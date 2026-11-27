// LostFilm: домен-зеркало и CSS-селекторы хранятся в конфиге провайдера (БД),
// потому что официальные зеркала регулярно меняются. Список правится из UI.
import { providerFetchText, mirrorHosts } from '../security.js';
import * as cheerio from 'cheerio';
import type { SearchResult } from './index.js';

interface LostFilmConfig {
  mirrors?: string[];
  searchPath?: string;      // '/search/?q={q}'
  itemSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  loginPath?: string;       // '/login' — страница авторизации (кнопка в клиенте)
  cookies?: string;         // куки сессии (из встроенного окна авторизации Electron)
}

// Только публичные адреса; куки входа — только хостам зеркал (см. security.ts).
async function fetchWithTimeout(url: string, timeoutMs = 8000, auth?: { cookies?: string; mirrors?: string[] }): Promise<string> {
  return providerFetchText(url, {
    timeoutMs,
    cookies: auth?.cookies,
    cookieHosts: mirrorHosts(auth?.mirrors),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WatchTogether/0.1' },
  });
}

export async function searchLostFilm(query: string, raw: Record<string, unknown>): Promise<SearchResult[]> {
  const config = raw as unknown as LostFilmConfig;  const mirrors = config.mirrors ?? [];
  const searchPath = config.searchPath ?? '/search/?q={q}';
  const itemSelector = config.itemSelector ?? '.row-search';
  const titleSelector = config.titleSelector ?? '.name-ru, .name-en';
  const linkSelector = config.linkSelector ?? 'a.no-decoration';

  let lastError: unknown = null;
  for (const mirror of mirrors) {
    try {
      const url = mirror.replace(/\/$/, '') + searchPath.replace('{q}', encodeURIComponent(query));
      const html = await fetchWithTimeout(url);
      const $ = cheerio.load(html);
      const results: SearchResult[] = [];
      $(itemSelector).slice(0, 15).each((_, el) => {
        const $el = $(el);
        const title = $el.find(titleSelector).first().text().trim();
        const href = $el.find(linkSelector).first().attr('href');
        if (!title || !href) return;
        const thumb = $el.find('img').first().attr('src');
        results.push({
          provider: 'lostfilm',
          title,
          url: new URL(href, mirror).toString(),
          thumbnail: thumb ? new URL(thumb, mirror).toString() : undefined,
          subtitle: $el.find(titleSelector).eq(1).text().trim() || undefined,
        });
      });
      return results; // первое ответившее зеркало — рабочее
    } catch (err) {
      lastError = err; // пробуем следующее зеркало
    }
  }
  console.warn('[lostfilm] все зеркала недоступны:', lastError);
  return [];
}

// --- Разбор серий сериала (v0.2) ---

export interface EpisodeInfo {
  season: number;
  episode: number;
  title: string;
  url: string; // страница серии
}

// Парсим страницу сериала: главная страница содержит только последний сезон,
// поэтому догружаем страницы /series/<slug>/season_N/ для каждого сезона.
export async function getSeriesEpisodes(seriesUrl: string, raw: Record<string, unknown>): Promise<EpisodeInfo[]> {
  const config = raw as unknown as LostFilmConfig;
  const html = await fetchWithTimeout(seriesUrl, 8000, config);
  const mirrors = config.mirrors ?? [];
  const base = mirrors.find((m) => seriesUrl.startsWith(m)) ?? mirrors[0] ?? seriesUrl;
  const slugMatch = seriesUrl.match(/\/series\/([^/]+)\/?/);
  const slug = slugMatch?.[1];

  // Страница сериала не всегда содержит ссылки на все сезоны (контент зависит от
  // UA/зеркала), поэтому идём по сезонам последовательно: season_1, season_2, …,
  // пока страницы отвечают и содержат серии. Две подряд пустые — стоп.
  const pages: string[] = [];
  if (slug) {
    for (let n = 1; n <= 30; n++) {
      pages.push(new URL(`/series/${slug}/season_${n}/`, base).toString());
    }
  } else {
    pages.push(seriesUrl);
  }

  const all: EpisodeInfo[] = [];
  const seen = new Set<string>();
  let emptyStreak = 0;
  for (const pageUrl of pages) {
    // До трёх попыток: зеркала нестабильны и иногда отдают урезанную страницу —
    // считаем «0 серий» ошибкой и повторяем с паузой.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const pageHtml = pageUrl === seriesUrl ? html : await fetchWithTimeout(pageUrl, 8000, config);
        const parsed = parseEpisodeTable(pageHtml, base, slug);
        if (parsed.length === 0) throw new Error('пустая выдача');
        for (const ep of parsed) {
          const key = `${ep.season}-${ep.episode}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(ep);
        }
        break;
      } catch {
        if (attempt === 2) console.warn(`[lostfilm] не удалось разобрать ${pageUrl}`);
        else await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (pageUrl === seriesUrl) continue; // fallback-страница не влияет на стоп-счётчик
    // Стоп-правило: страница сезона не дала НОВЫХ серий (несуществующий сезон
    // может отдавать 404 или редиректить на страницу сериала с уже виденными сериями).
    const seasonNum = Number(pageUrl.match(/season_(\d+)/)?.[1]);
    const hasNew = all.some((e) => e.season === seasonNum);
    if (!hasNew) {
      emptyStreak++;
      if (emptyStreak >= 2) break;
    } else {
      emptyStreak = 0;
    }
  }

  return all.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

// Таблица серий: td.beta = «4 сезон 6 серия» со ссылкой в onclick, td.gamma = названия.
function parseEpisodeTable(html: string, base: string, slug?: string): EpisodeInfo[] {
  const $ = cheerio.load(html);
  const epRe = slug
    ? new RegExp(`/series/${slug}/season_(\\d+)/episode_(\\d+)/?`)
    : /\/series\/[^/]+\/season_(\d+)\/episode_(\d+)\/?/;
  const out: EpisodeInfo[] = [];

  $('td.beta[onclick*="/series/"]').each((_, el) => {
    const onclick = $(el).attr('onclick') ?? '';
    const m = onclick.match(epRe);
    if (!m) return;
    const row = $(el).closest('tr');
    const gamma = row.find('td.gamma').first();
    // Русское название: текст td.gamma без английского span (он в <br><span>).
    // Работает для обеих вёрсток: текст прямо в td и текст внутри вложенного div.
    const gammaClone = gamma.clone();
    gammaClone.find('span').remove();
    const ruTitle = gammaClone.text().trim();
    const enTitle = gamma.find('span').first().text().trim();
    const title = ruTitle
      ? enTitle ? `${ruTitle} / ${enTitle}` : ruTitle
      : ($(el).text().trim() || `Сезон ${m[1]}, серия ${m[2]}`);
    out.push({
      season: Number(m[1]),
      episode: Number(m[2]),
      title,
      url: new URL(m[0], base).toString(),
    });
  });

  // Fallback: ссылки на серии (если вёрстка зеркала другая)
  if (out.length === 0) {
    $('a[href*="/series/"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const m = href.match(epRe);
      if (!m) return;
      const title =
        $(el).attr('title')?.trim() ||
        $(el).text().trim().split('\n')[0]?.trim() ||
        `Сезон ${m[1]}, серия ${m[2]}`;
      out.push({
        season: Number(m[1]),
        episode: Number(m[2]),
        title,
        url: new URL(m[0], base).toString(),
      });
    });
  }

  return out;
}

// Пытаемся вытащить прямой поток со страницы серии (m3u8/mp4 или iframe плеера).
// Учтите: у LostFilm плеер обфусцирован и может требовать авторизацию —
// поэтому это best-effort: если поток не нашли, клиенту вернётся pageUrl.
export interface StreamInfo {
  streamUrl: string | null;
  pageUrl: string;
}

export async function getEpisodeStream(episodeUrl: string, raw?: Record<string, unknown>): Promise<StreamInfo> {
  const html = await fetchWithTimeout(episodeUrl, 8000, raw as LostFilmConfig | undefined);
  // 1) прямые ссылки на поток в разметке/скриптах
  const direct = html.match(/https?:\\?\/\\?\/[^\s"'\\]+\.(?:m3u8|mp4)(?:\?[^\s"'\\]*)?/i);
  if (direct) {
    return { streamUrl: direct[0].replaceAll('\\/', '/'), pageUrl: episodeUrl };
  }
  // 2) iframe плеера
  const $ = cheerio.load(html);
  const iframeSrc = $('iframe[src*="play"], iframe[src*="video"], iframe[src*="embed"]').first().attr('src');
  if (iframeSrc) {
    return { streamUrl: null, pageUrl: new URL(iframeSrc, episodeUrl).toString() };
  }
  return { streamUrl: null, pageUrl: episodeUrl };
}
