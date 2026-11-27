// LordSerial: семейство зеркал lordserials (DataLife Engine).
// Поиск — стандартный DLE POST (do=search), серии размечены прямо в HTML
// страницы сериала (#soons-tv-ajax), поток — best-effort из iframe плеера.
// Список зеркал хранится в конфиге провайдера (БД) и правится из UI.
import { providerFetchText, mirrorHosts } from '../security.js';
import * as cheerio from 'cheerio';
import type { SearchResult } from './index.js';
import type { EpisodeInfo, StreamInfo } from './lostfilm.js';

interface LordSerialConfig {
  mirrors?: string[];
  itemSelector?: string;   // '.th-item'
  titleSelector?: string;  // '.th-title'
  linkSelector?: string;   // 'a.th-in'
  loginPath?: string;      // '/login'
  cookies?: string;        // куки сессии (из встроенного окна авторизации Electron)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Только публичные адреса; куки входа — только хостам зеркал (не стороннему
// плееру из iframe и не URL, присланному клиентом) — см. security.ts.
async function fetchWithTimeout(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
  timeoutMs = 9000,
  auth?: { cookies?: string; mirrors?: string[] },
): Promise<string> {
  return providerFetchText(url, {
    method: init?.method,
    body: init?.body,
    timeoutMs,
    cookies: auth?.cookies,
    cookieHosts: mirrorHosts(auth?.mirrors),
    headers: { 'User-Agent': UA, ...(init?.headers ?? {}) },
  });
}

// Поиск по зеркалу: POST do=search&subaction=search&story=<запрос>.
// DLE ищет нечётко (тысячи совпадений), поэтому ранжируем: сначала те,
// чьё название содержит запрос целиком.
export async function searchLordSerial(query: string, raw: Record<string, unknown>): Promise<SearchResult[]> {
  const config = raw as unknown as LordSerialConfig;
  const mirrors = config.mirrors ?? [];
  const itemSelector = config.itemSelector ?? '.th-item';
  const titleSelector = config.titleSelector ?? '.th-title';
  const linkSelector = config.linkSelector ?? 'a.th-in';

  for (const mirror of mirrors) {
    try {
      const base = mirror.replace(/\/$/, '');
      const body = new URLSearchParams({ do: 'search', subaction: 'search', story: query });
      const html = await fetchWithTimeout(base + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const $ = cheerio.load(html);
      const results: SearchResult[] = [];
      $(itemSelector).slice(0, 40).each((_, el) => {
        const $el = $(el);
        const href = $el.find(linkSelector).first().attr('href');
        const title = $el.find(titleSelector).first().text().trim();
        if (!title || !href) return;
        const img = $el.find('img').first().attr('src');
        const kp = $el.find('.th-rate-kp span').first().text().trim();
        results.push({
          provider: 'lordserial',
          title,
          url: new URL(href, base).toString(),
          thumbnail: img ? new URL(img, base).toString() : undefined,
          subtitle: kp ? `КП ${kp}` : undefined,
        });
      });
      // Ранжирование: совпадение запроса в названии — в начало.
      const q = query.toLowerCase();
      results.sort((a, b) => Number(b.title.toLowerCase().includes(q)) - Number(a.title.toLowerCase().includes(q)));
      return results.slice(0, 15); // первое ответившее зеркало — рабочее
    } catch {
      // пробуем следующее зеркало
    }
  }
  console.warn('[lordserial] все зеркала недоступны');
  return [];
}

// Серии сериала: страница содержит #soons-tv-ajax с блоками .episodes-season
// (номер сезона в .episodes-season__icon) и строками .episodes-item.
// Невышедшие серии (статус ×) пропускаем. URL серии: <страница>#s<сезон>e<серия> —
// фрагмент нужен, чтобы эндпоинт потока знал сезон/серию.
export async function getLordSerialEpisodes(seriesUrl: string, raw: Record<string, unknown>): Promise<EpisodeInfo[]> {
  const config = raw as unknown as LordSerialConfig;
  const html = await fetchWithTimeout(seriesUrl, undefined, 9000, config);
  const $ = cheerio.load(html);
  const episodes: EpisodeInfo[] = [];

  $('.episodes-season').each((_, seasonEl) => {
    const season = Number($(seasonEl).find('.episodes-season__icon').first().text().trim());
    if (!season) return;
    $(seasonEl).find('.episodes-item').each((_, epEl) => {
      const $ep = $(epEl);
      // У невышедшей серии «✓» скрыт инлайн-стилем.
      const releasedStyle = $ep.find('.episodes-item__status.is-released').attr('style') ?? '';
      if (/display:\s*none/.test(releasedStyle)) return;
      const episode = Number($ep.find('.episodes-item__num').first().text().replace(/\D+/g, ''));
      if (!episode) return;
      const title = $ep.find('.episodes-item__title').first().text().trim() || `Серия ${episode}`;
      episodes.push({
        season,
        episode,
        title,
        url: `${seriesUrl}#s${season}e${episode}`,
      });
    });
  });

  return episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

// Поток серии: на странице сериала есть iframe плеера вида
// //<host>/lat/<id>?...&season=1&episode=1 — подставляем нужные сезон/серию
// и пытаемся вытащить m3u8/mp4 из ответа (может редиректить на другое зеркало
// плеера). Если плеер обфусцирован или регион заблокирован — честно возвращаем
// pageUrl, клиент покажет ссылку на страницу серии.
export async function getLordSerialStream(episodeUrl: string, raw?: Record<string, unknown>): Promise<StreamInfo> {
  const auth = raw as LordSerialConfig | undefined;
  const m = episodeUrl.match(/#s(\d+)e(\d+)$/);
  const seriesUrl = episodeUrl.replace(/#s\d+e\d+$/, '');
  const season = m?.[1] ?? '1';
  const episode = m?.[2] ?? '1';

  const html = await fetchWithTimeout(seriesUrl, undefined, 9000, auth);
  const $ = cheerio.load(html);
  const iframeSrc = $('iframe[src*="season="]').first().attr('src');
  if (!iframeSrc) return { streamUrl: null, pageUrl: seriesUrl };

  const playerUrl = new URL(iframeSrc, seriesUrl);
  playerUrl.searchParams.set('season', season);
  playerUrl.searchParams.set('episode', episode);

  try {
    const playerHtml = await fetchWithTimeout(playerUrl.toString(), {
      headers: { Referer: seriesUrl },
    }, 9000, auth);
    const direct = playerHtml.match(/https?:\\?\/\\?\/[^\s"'\\]+\.(?:m3u8|mp4)(?:\?[^\s"'\\]*)?/i);
    if (direct) {
      return { streamUrl: direct[0].replaceAll('\\/', '/'), pageUrl: playerUrl.toString() };
    }
  } catch {
    // плеер недоступен из нашего региона/сети — отдаём ссылку на страницу
  }
  return { streamUrl: null, pageUrl: playerUrl.toString() };
}
