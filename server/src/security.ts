// Безопасность сервера: откуда пришёл запрос (этот ПК / LAN / интернет-туннель),
// токен доступа к медиа-прокси и fetch, который не ходит во внутреннюю сеть (SSRF).
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Agent, fetch as undiciFetch, type Response } from 'undici';
import { getSetting, setSetting } from './db.js';

// ─── Происхождение запроса ───
// local  — этот компьютер (окно приложения, браузер на localhost);
// lan    — соседи по локальной/виртуальной сети (LAN, ZeroTier, Hamachi, Tailscale);
// public — всё остальное, в том числе туннель Pinggy: он приходит на 127.0.0.1,
//          но с чужим Host, поэтому loopback БЕЗ localhost-Host считаем публичным
//          (заодно это защита от DNS-rebinding на админские ручки).
export type Access = 'local' | 'lan' | 'public';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Адреса «своих» сетей, из которых соседям доверяем как раньше (LAN-модель).
const TRUSTED_NETS = new net.BlockList();
TRUSTED_NETS.addSubnet('10.0.0.0', 8, 'ipv4');
TRUSTED_NETS.addSubnet('172.16.0.0', 12, 'ipv4');
TRUSTED_NETS.addSubnet('192.168.0.0', 16, 'ipv4');
TRUSTED_NETS.addSubnet('169.254.0.0', 16, 'ipv4');
TRUSTED_NETS.addSubnet('100.64.0.0', 10, 'ipv4'); // Tailscale / CGNAT
TRUSTED_NETS.addSubnet('25.0.0.0', 8, 'ipv4');    // Hamachi
TRUSTED_NETS.addSubnet('fc00::', 7, 'ipv6');
TRUSTED_NETS.addSubnet('fe80::', 10, 'ipv6');

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

function hostHeaderName(req: FastifyRequest): string {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0];
}

export function classifyRequest(req: FastifyRequest): Access {
  const ip = normalizeIp(req.socket.remoteAddress ?? '');
  const loopback = ip === '::1' || ip.startsWith('127.');
  if (loopback) return LOCAL_HOSTNAMES.has(hostHeaderName(req)) ? 'local' : 'public';
  const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;
  if (family && TRUSTED_NETS.check(ip, family)) return 'lan';
  return 'public';
}

// preHandler-гард: пропускает только запросы с перечисленным происхождением.
export function requireAccess(...allowed: Access[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!allowed.includes(classifyRequest(req))) {
      return reply.code(403).send({ error: 'Это действие доступно только на компьютере-хосте' });
    }
  };
}

// ─── Токен медиа-прокси ───
// Из LAN прокси открыт как раньше; через туннель — только с токеном, который
// сервер выдаёт при входе в комнату. Секрет хранится в БД, поэтому ссылки
// в истории/очереди переживают перезапуск.
function proxySecret(): string {
  let s = getSetting('proxy_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('base64url');
    setSetting('proxy_secret', s);
  }
  return s;
}

let cachedToken: string | null = null;
export function proxyToken(): string {
  cachedToken ??= crypto.createHmac('sha256', proxySecret()).update('media-proxy').digest('base64url').slice(0, 32);
  return cachedToken;
}

export function isValidProxyToken(t: unknown): boolean {
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(proxyToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── SSRF: проверка адресов назначения ───
// Два отдельных списка: BlockList сверяет IPv4-адрес и с IPv4-mapped
// IPv6-правилами, и правило ::ffff:0:0/96 в общем списке блокировало бы весь IPv4.
const BLOCKED_V4 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED_V4.addSubnet(addr, prefix, 'ipv4');
const BLOCKED_V6 = new net.BlockList();
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) BLOCKED_V6.addSubnet(addr, prefix, 'ipv6');

export function isBlockedIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (net.isIPv4(n)) return BLOCKED_V4.check(n, 'ipv4');
  if (net.isIPv6(n)) return BLOCKED_V6.check(n, 'ipv6');
  return true; // не IP — не пускаем
}

const BLOCKED_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa|localdomain)$/i;

// Предварительная проверка URL (протокол, IP-литерал, «внутренние» имена).
// Имена дополнительно проверяются при каждом подключении в safeLookup.
export function assertPublicUrl(u: URL): void {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError();
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError();
  } else if (BLOCKED_NAME.test(host)) {
    throw new SsrfError();
  }
}

export class SsrfError extends Error {
  constructor() { super('Этот адрес проксировать нельзя'); }
}

// DNS-резолв с проверкой: адрес проверяется в момент подключения, так что
// домен, указывающий на 127.0.0.1/192.168.x (или DNS-rebinding), не пройдёт.
type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) {
      const e = new SsrfError() as NodeJS.ErrnoException;
      e.code = 'EBLOCKED';
      return cb(e);
    }
    if (options.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}

const safeAgent = new Agent({
  connect: { lookup: safeLookup as unknown as typeof dns.lookup },
});

// fetch для пользовательских URL: только публичные адреса, редиректы
// проверяются на каждом шаге (иначе публичный URL мог бы увести на 127.0.0.1).
// headers может быть функцией от URL текущего шага — так куки сайта не
// уезжают вслед за редиректом на чужой домен.
export async function safeFetch(
  url: URL,
  init: {
    headers?: Record<string, string> | ((u: URL) => Record<string, string>);
    signal?: AbortSignal;
    method?: string;
    body?: string;
  },
  maxRedirects = 5,
): Promise<{ res: Response; finalUrl: URL }> {
  let current = url;
  let method = init.method ?? 'GET';
  let body = init.body;
  for (let i = 0; i <= maxRedirects; i++) {
    assertPublicUrl(current);
    const headers = typeof init.headers === 'function' ? init.headers(current) : init.headers;
    const res = await undiciFetch(current, {
      method, body, headers, signal: init.signal, redirect: 'manual', dispatcher: safeAgent,
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      current = new URL(location, current);
      // Как браузер: после 301/302/303 повтор — GET без тела.
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; }
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error('Слишком много перенаправлений');
}

// ─── Запросы провайдеров (LostFilm, LordSerial) ───
// URL страниц приходят от клиента, поэтому: только публичные адреса, и куки
// входа на сайт прикладываются ТОЛЬКО к хостам зеркал этого провайдера.
// Раньше куки уходили на любой присланный URL — их можно было увести.
const normHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

export function mirrorHosts(mirrors: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(mirrors)) return out;
  for (const m of mirrors) {
    try { out.add(normHost(new URL(String(m)).hostname)); } catch { /* битое зеркало */ }
  }
  return out;
}

export function isMirrorUrl(url: string, hosts: Set<string>): boolean {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && hosts.has(normHost(u.hostname));
  } catch {
    return false;
  }
}

export async function providerFetchPage(
  url: string,
  opts: {
    cookies?: string;
    cookieHosts: Set<string>;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    timeoutMs?: number;
    encoding?: string; // кодировка страницы, если не UTF-8 (RuTracker — windows-1251)
  },
): Promise<{ text: string; finalUrl: string }> {
  const { res, finalUrl } = await safeFetch(new URL(url), {
    method: opts.method,
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 9000),
    headers: (u) => ({
      ...(opts.headers ?? {}),
      ...(opts.cookies && opts.cookieHosts.has(normHost(u.hostname)) ? { Cookie: opts.cookies } : {}),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = opts.encoding
    ? new TextDecoder(opts.encoding).decode(await res.arrayBuffer())
    : await res.text();
  // finalUrl (после редиректов) — по нему видно, что сайт отправил на страницу входа.
  return { text, finalUrl: finalUrl.toString() };
}

export async function providerFetchText(...args: Parameters<typeof providerFetchPage>): Promise<string> {
  return (await providerFetchPage(...args)).text;
}

// ─── Пароли комнат: scrypt с солью ───
// Формат: scrypt$<соль b64>$<хеш b64>. Старые хеши (голый sha256 hex)
// принимаются и перехешируются при первом успешном входе.
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): { ok: boolean; needsRehash: boolean } {
  if (stored.startsWith('scrypt$')) {
    const [, saltB64, hashB64] = stored.split('$');
    const expected = Buffer.from(hashB64 ?? '', 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64 ?? '', 'base64'), expected.length || 32);
    return { ok: expected.length > 0 && crypto.timingSafeEqual(actual, expected), needsRehash: false };
  }
  if (/^[0-9a-f]{64}$/.test(stored)) {
    const legacy = crypto.createHash('sha256').update(password).digest();
    return { ok: crypto.timingSafeEqual(legacy, Buffer.from(stored, 'hex')), needsRehash: true };
  }
  return { ok: false, needsRehash: false };
}

// Токен доступа к REST комнаты с паролем (история, детали). Выдаётся при входе
// через сокет; смена пароля делает старые токены недействительными.
export function roomAccessToken(roomId: string, passwordHash: string | null): string {
  return crypto.createHmac('sha256', proxySecret()).update(`room:${roomId}:${passwordHash ?? ''}`)
    .digest('base64url').slice(0, 32);
}

export function hasRoomAccess(req: FastifyRequest, room: { id: string; password_hash: string | null }): boolean {
  if (!room.password_hash) return true;
  const t = req.headers['x-room-token'];
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(roomAccessToken(room.id, room.password_hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Подтверждение владения clientId ───
// clientId виден всем в комнате (присутствие, сигналинг), поэтому сам по себе
// не доказывает «я хост». Клиент хранит случайный секрет; сервер запоминает
// его хеш при первом появлении clientId и дальше сверяет.
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function verifyClient(
  clientId: unknown,
  secret: unknown,
  store: { get(id: string): string | undefined; add(id: string, hash: string): void },
): boolean {
  if (typeof clientId !== 'string' || !/^[\w-]{8,64}$/.test(clientId)) return false;
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128) return false;
  const known = store.get(clientId);
  const hash = sha256(secret);
  if (!known) {
    store.add(clientId, hash);
    return store.get(clientId) === hash; // гонка двух первых входов — выигрывает один
  }
  return crypto.timingSafeEqual(Buffer.from(known), Buffer.from(hash));
}

// ─── Ограничение частоты (token bucket) ───
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; ts: number }>();
  constructor(private perSec: number, private burst: number) {}

  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, ts: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.ts) / 1000) * this.perSec);
    b.ts = now;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10000) this.prune(now);
    return true;
  }

  forget(prefix: string) {
    for (const k of this.buckets.keys()) if (k.startsWith(prefix)) this.buckets.delete(k);
  }

  private prune(now: number) {
    for (const [k, b] of this.buckets) if (now - b.ts > 600000) this.buckets.delete(k);
  }
}

// ─── Проверка входных данных ───
const VIDEO_KINDS = new Set(['direct', 'youtube', 'embed', 'rutube', 'stream']);

export interface CleanVideo { kind: string; url: string; title?: string; provider?: string }

// Видео от клиента: известный kind, http(s)-ссылка или наш прокси, ограниченные длины.
// Лишние поля отбрасываются.
export function cleanVideo(v: unknown): CleanVideo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !VIDEO_KINDS.has(o.kind)) return null;
  if (typeof o.url !== 'string' || o.url.length > 4096) return null;
  // Свои ссылки сервера: медиа-прокси и файлы медиатеки этого ПК.
  const isOwn = o.url.startsWith('/api/proxy/stream?') || /^\/api\/library\/stream\/[\w-]{1,64}$/.test(o.url);
  if (!isOwn) {
    try {
      if (!/^https?:$/.test(new URL(o.url).protocol)) return null;
    } catch {
      return null;
    }
  }
  const out: CleanVideo = { kind: o.kind, url: o.url };
  if (typeof o.title === 'string') out.title = o.title.slice(0, 300);
  if (typeof o.provider === 'string') out.provider = o.provider.slice(0, 50);
  return out;
}

// Позиция воспроизведения: конечное число в разумных пределах (до ~11 суток).
export function cleanPosition(x: unknown): number {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(0, n), 1_000_000);
}
