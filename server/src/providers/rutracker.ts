// RuTracker: поиск раздач (tracker.php) и magnet-ссылка раздачи (viewtopic.php).
// Поиск на RuTracker доступен только после входа — куки берутся из встроенного
// окна авторизации (как у LostFilm). Страницы сайта в windows-1251.
// Смотреть раздачу напрямую нельзя: magnet уходит в торрент-клиент, а скачанные
// файлы появляются в медиатеке, если её папка совпадает с папкой загрузок.
import * as cheerio from 'cheerio';
import { providerFetchPage, mirrorHosts } from '../security.js';
import type { SearchResult } from './index.js';

export interface RuTrackerConfig {
  mirrors?: string[];
  loginPath?: string;   // '/forum/login.php'
  cookies?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const ENCODING = 'windows-1251';

// Ошибка с кодом: клиент по NEED_LOGIN показывает кнопку «Войти».
export class ProviderError extends Error {
  constructor(public code: 'NEED_LOGIN' | 'UNAVAILABLE', message: string) { super(message); }
}

// Запрос в windows-1251: кириллица кодируется так, как её отправил бы сам сайт.
export function encodeCp1251(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    let byte: number | null = null;
    if (c < 0x80) byte = c;
    else if (c >= 0x410 && c <= 0x44f) byte = c - 0x410 + 0xc0; // А–я
    else if (c === 0x401) byte = 0xa8; // Ё
    else if (c === 0x451) byte = 0xb8; // ё
    if (byte === null) { out += '%3F'; continue; } // символ вне cp1251 → «?»
    out += /[A-Za-z0-9\-_.~]/.test(String.fromCharCode(byte)) && byte < 0x80
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function isLoginPage(html: string, finalUrl: string): boolean {
  return /login\.php/i.test(finalUrl) || (/name="login_username"/i.test(html) && !/id="tor-tbl"/i.test(html));
}

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function fetchPage(url: string, config: RuTrackerConfig) {
  return providerFetchPage(url, {
    encoding: ENCODING,
    cookies: config.cookies,
    cookieHosts: mirrorHosts(config.mirrors),
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9' },
    timeoutMs: 12000,
  });
}

export async function searchRuTracker(query: string, raw: Record<string, unknown>): Promise<SearchResult[]> {
  const config = raw as RuTrackerConfig;
  if (!config.cookies) throw new ProviderError('NEED_LOGIN', 'Поиск на RuTracker доступен после входа на сайт');
  const mirrors = config.mirrors?.length ? config.mirrors : ['https://rutracker.org'];
  let lastError: unknown = null;
  for (const mirror of mirrors) {
    const base = mirror.replace(/\/$/, '');
    try {
      const { text: html, finalUrl } = await fetchPage(`${base}/forum/tracker.php?nm=${encodeCp1251(query)}`, config);
      if (isLoginPage(html, finalUrl)) {
        throw new ProviderError('NEED_LOGIN', 'Сессия RuTracker истекла — войдите на сайт ещё раз');
      }
      return parseSearch(html, base);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      lastError = e; // зеркало недоступно — пробуем следующее
    }
  }
  throw new ProviderError('UNAVAILABLE',
    `RuTracker недоступен${lastError instanceof Error ? `: ${lastError.message}` : ''}. Сайт блокируется в РФ — нужен VPN на этом ПК.`);
}

export function parseSearch(html: string, base: string): SearchResult[] {
  const $ = cheerio.load(html);
  const rows: (SearchResult & { seeds: number })[] = [];
  $('#tor-tbl tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const link = $tr.find('a.tLink, a[href*="viewtopic.php?t="]').first();
    const href = link.attr('href');
    const title = link.text().replace(/\s+/g, ' ').trim();
    if (!href || !title) return;
    const topicId = /t=(\d+)/.exec(href)?.[1];
    if (!topicId) return;
    const category = $tr.find('.f-name a, td.f-name-col a').first().text().trim();
    const sizeCell = $tr.find('td.tor-size').first();
    const sizeBytes = Number(sizeCell.attr('data-ts_text'));
    const size = fmtSize(sizeBytes) || sizeCell.text().replace(/[↓\s]+/g, ' ').trim();
    const seeds = Number($tr.find('b.seedmed, .seedmed').first().text().trim()) || 0;
    rows.push({
      provider: 'rutracker',
      title,
      url: `${base}/forum/viewtopic.php?t=${topicId}`,
      subtitle: [category, size, `сиды: ${seeds}`].filter(Boolean).join(' · '),
      seeds,
    });
  });
  // Сначала живые раздачи: по числу сидов.
  return rows.sort((a, b) => b.seeds - a.seeds).slice(0, 50).map(({ seeds: _s, ...r }) => r);
}

// Magnet-ссылка и название раздачи по URL темы.
export async function getRuTrackerTopic(topicUrl: string, raw: Record<string, unknown>): Promise<{ title: string; magnet: string }> {
  const config = raw as RuTrackerConfig;
  const { text: html, finalUrl } = await fetchPage(topicUrl, config);
  const $ = cheerio.load(html);
  const magnet = $('a.magnet-link, a[href^="magnet:"]').first().attr('href') ?? '';
  if (!magnet) {
    if (isLoginPage(html, finalUrl)) throw new ProviderError('NEED_LOGIN', 'Войдите на RuTracker, чтобы получить раздачу');
    throw new ProviderError('UNAVAILABLE', 'На странице раздачи не нашлась magnet-ссылка');
  }
  if (!/^magnet:\?xt=urn:btih:[a-z0-9]{32,40}/i.test(magnet)) {
    throw new ProviderError('UNAVAILABLE', 'Неожиданный формат magnet-ссылки');
  }
  const title = $('#topic-title, h1.maintitle a').first().text().replace(/\s+/g, ' ').trim();
  return { title, magnet };
}
