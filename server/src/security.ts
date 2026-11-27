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
export async function safeFetch(
  url: URL,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
  maxRedirects = 5,
): Promise<{ res: Response; finalUrl: URL }> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    assertPublicUrl(current);
    const res = await undiciFetch(current, { ...init, redirect: 'manual', dispatcher: safeAgent });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      current = new URL(location, current);
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error('Слишком много перенаправлений');
}
