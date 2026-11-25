// Rutube: поиск и потоки через публичное API (без зеркал и авторизации).
// Поток: /api/play/options/<id>/ отдаёт m3u8-балансер — играем в нашем плеере
// через hls.js (обычно через серверный медиа-прокси, Referer: rutube.ru).
// Сериалы на Rutube — это отдельные ролики канала с единообразными названиями
// («Извне 1 сезон 2 серия …»), поэтому «серии сезона» собираем поиском.
import type { SearchResult } from './index.js';
import type { StreamInfo } from './lostfilm.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const RUTUBE_REFERER = 'https://rutube.ru/';

async function fetchJson<T>(url: string, timeoutMs = 9000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: RUTUBE_REFERER },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ID видео из ссылки: /video/<hex32>/ или /play/embed/<hex32>.
export function extractRutubeId(url: string): string | null {
  const m = url.match(/rutube\.ru\/(?:video|play\/embed)\/([0-9a-f]{32})/i);
  return m?.[1] ?? null;
}

interface RutubeSearchItem {
  id: string;
  title: string;
  duration?: number; // секунды
  video_url: string;
  thumbnail_url?: string;
  author?: { id: number; name: string };
}

function fmtDuration(sec?: number): string | undefined {
  if (!sec || sec < 30) return undefined;
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
}

export async function searchRutube(query: string, _config: Record<string, unknown>): Promise<SearchResult[]> {
  const url = `https://rutube.ru/api/search/video/?query=${encodeURIComponent(query)}&page=1&per_page=12`;
  const data = await fetchJson<{ results?: RutubeSearchItem[] }>(url);
  return (data.results ?? [])
    .filter((r) => r.id && r.title && r.video_url)
    .map((r) => ({
      provider: 'rutube',
      title: r.title,
      url: r.video_url,
      thumbnail: r.thumbnail_url,
      subtitle: [fmtDuration(r.duration), r.author?.name].filter(Boolean).join(' · ') || undefined,
    }));
}

interface RutubePlayOptions {
  title?: string;
  duration?: number; // миллисекунды
  thumbnail_url?: string;
  video_balancer?: { m3u8?: string; default?: string };
}

export interface RutubeStreamInfo extends StreamInfo {
  title?: string;
  durationMs?: number;
}

// Поток ролика: m3u8-балансер. Ключ m3u8 — адаптивный HLS; default — то же самое.
export async function getRutubeStream(videoUrl: string): Promise<RutubeStreamInfo> {
  const id = extractRutubeId(videoUrl);
  if (!id) return { streamUrl: null, pageUrl: videoUrl };
  const data = await fetchJson<RutubePlayOptions>(
    `https://rutube.ru/api/play/options/${id}/?no_404=true&pver=v2`
  );
  const streamUrl = data.video_balancer?.m3u8 ?? data.video_balancer?.default ?? null;
  return {
    streamUrl,
    pageUrl: videoUrl,
    title: data.title,
    durationMs: data.duration,
  };
}

// «Серии сезона»: из названия текущей серии («Извне 1 сезон 1 серия …»)
// достаём базу и сезон, ищем остальные серии тем же шаблоном и сортируем по номеру.
// Сезон берём текущий И СЛЕДУЮЩИЙ: если сериал заканчивается, следующая серия
// (S+1 E1) тоже найдётся — так очередь не упирается в конец сезона.
const SERIAL_RE = /^(.+?)[\s–—-]+(\d{1,2})\s*сезон\s+(\d{1,3})\s*серия/i;

export interface RutubeSeasonInfo {
  base: string;        // «Извне»
  season: number;      // сезон текущего ролика
  episodes: { season: number; episode: number; title: string; url: string; durationSec?: number }[];
}

export function parseRutubeSerialTitle(title: string): { base: string; season: number; episode: number } | null {
  const m = title.match(SERIAL_RE);
  if (!m) return null;
  return { base: m[1].trim(), season: Number(m[2]), episode: Number(m[3]) };
}

type EpisodeHit = RutubeSeasonInfo['episodes'][number];

// Серии одного сезона поиском: «<база> <сезон> сезон», разбор шаблона названия,
// дедуп по номеру серии с приоритетом того же канала/базы.
async function searchSeason(base: string, season: number, authorId?: number): Promise<EpisodeHit[]> {
  const data = await fetchJson<{ results?: RutubeSearchItem[] }>(
    `https://rutube.ru/api/search/video/?query=${encodeURIComponent(`${base} ${season} сезон`)}&page=1&per_page=50`
  );
  const byEpisode = new Map<number, EpisodeHit>();
  for (const r of data.results ?? []) {
    const p = parseRutubeSerialTitle(r.title ?? '');
    if (!p || p.season !== season || !r.video_url) continue;
    const sameAuthor = !!authorId && r.author?.id === authorId;
    const sameBase = p.base.toLowerCase() === base.toLowerCase();
    const prev = byEpisode.get(p.episode);
    if (!prev || ((sameAuthor || sameBase) && !prev.title.toLowerCase().startsWith(base.toLowerCase()))) {
      byEpisode.set(p.episode, { season, episode: p.episode, title: r.title, url: r.video_url, durationSec: r.duration });
    }
  }
  return [...byEpisode.values()];
}

export async function getRutubeSeasonPack(videoUrl: string): Promise<RutubeSeasonInfo | null> {
  const id = extractRutubeId(videoUrl);
  if (!id) return null;
  const info = await fetchJson<{ title?: string; author?: { id: number } }>(
    `https://rutube.ru/api/video/${id}/`
  );
  const parsed = info.title ? parseRutubeSerialTitle(info.title) : null;
  if (!parsed) return null;

  const authorId = info.author?.id;
  const [current, next] = await Promise.all([
    searchSeason(parsed.base, parsed.season, authorId),
    searchSeason(parsed.base, parsed.season + 1, authorId).catch(() => [] as EpisodeHit[]),
  ]);
  const episodes = [...current, ...next].sort((a, b) => a.season - b.season || a.episode - b.episode);
  return { base: parsed.base, season: parsed.season, episodes };
}
