// REST-клиент + подключение к Socket.IO.
// Адрес сервера: по умолчанию текущий origin (клиент раздаётся самим сервером);
// в dev — Vite проксирует /api и /socket.io на :9345; из UI можно указать другой хост.
import { io, type Socket } from 'socket.io-client';

export interface WatchSource {
  kind: 'direct' | 'youtube' | 'embed' | 'rutube' | 'stream';
  url: string;
  title?: string;
  provider?: string;
}

// Трансляция сайта: хост (десктоп) захватывает окно и раздаёт WebRTC-потоком.
export interface StreamInfo {
  active: boolean;
  hostClientId: string | null;
  allowControl: boolean;
  playerOnly: boolean;
}

// Элемент очереди просмотра (хранится на сервере, общий для комнаты).
export interface QueueItem {
  id: number;
  video: WatchSource;
  addedBy: string;
  addedAt: number;
}

// Запись истории просмотра комнаты.
export interface HistoryEntry {
  video: WatchSource;
  positionSec: number;
  finished: boolean;
  updatedAt: number;
}

// «Серии сезона» Rutube, собранные поиском по шаблону названия
// (текущий и следующий сезон — чтобы очередь не упиралась в конец сезона).
export interface RutubeSeasonPack {
  base: string | null;
  season: number | null;
  episodes: { season: number; episode: number; title: string; url: string; durationSec?: number }[];
}

export interface RoomSummary {
  id: string;
  name: string;
  controlMode: 'all' | 'host';
  hasPassword: boolean;
  video: WatchSource | null;
  positionSec: number;
  state: 'playing' | 'paused';
  updatedAt: number;
  members: number;
}

export interface RoomDetails extends Omit<RoomSummary, 'members'> {
  members: { client_id: string; nickname: string; last_seen: number }[];
}

export interface ProviderInfo {
  id: string;
  type: 'youtube' | 'lostfilm' | 'lordserial' | 'rutube' | 'rutracker' | 'custom';
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface SearchResult {
  provider: string;
  title: string;
  url: string;
  thumbnail?: string;
  subtitle?: string;
}

// Ошибка отдельного источника при поиске: NEED_LOGIN → показать «Войти».
export interface ProviderSearchError {
  provider: string;
  code: 'NEED_LOGIN' | 'UNAVAILABLE' | 'ERROR';
  message: string;
}

// Медиатека: видеофайл из папок компьютера-хоста.
export interface LibraryFile {
  id: string;
  name: string;
  title: string;
  dir: string;
  folder: string;
  size: number;
  mtime: number;
  playable: boolean;
  ext: string;
}

export interface LibraryInfo {
  files: LibraryFile[];
  folders: { id: number; path: string; files?: number }[];
  canManage: boolean; // папками управляет только сам хост (на этом ПК)
  scanning: boolean;
  scannedAt: number;
}

// Источник «файл медиатеки» для плеера и синхронизации комнаты.
export function librarySource(f: LibraryFile): WatchSource {
  return { kind: 'direct', url: `/api/library/stream/${f.id}`, title: f.title, provider: 'library' };
}

export interface SyncState {
  video: WatchSource | null;
  positionSec: number;
  state: 'playing' | 'paused';
  // Сколько мс назад сервер зафиксировал positionSec (0 на паузе) — позицию
  // досчитываем по своим часам, не доверяя системным часам устройств.
  positionAgeMs: number;
  serverTime: number;
  actor?: string;
}

export interface MemberPresence {
  clientId: string;
  nickname: string;
  online: boolean;
}

export interface ChatMessage {
  id: number;
  clientId: string;
  nickname: string;
  text: string;
  ts: number;
}

export interface EpisodeInfo {
  season: number;
  episode: number;
  title: string;
  url: string;
}

// База API: пустая строка = тот же origin (прод или Vite-прокси в dev).
export function apiBase(): string {
  return sessionStorage.getItem('wt.apiBase') ?? '';
}

export function setApiBase(base: string) {
  sessionStorage.setItem('wt.apiBase', base.replace(/\/$/, ''));
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listRooms: () => req<RoomSummary[]>('/api/rooms'),
  createRoom: (name: string, controlMode: 'all' | 'host', hostClientId: string, hostSecret: string, password?: string) =>
    req<{ id: string }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name, controlMode, hostClientId, hostSecret, password: password || undefined }),
    }),
  getRoom: (id: string) => req<RoomDetails>(`/api/rooms/${id}`),
  listProviders: () => req<ProviderInfo[]>('/api/providers'),
  saveProvider: (p: ProviderInfo) =>
    req<{ ok: true }>(`/api/providers/${p.id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deleteProvider: (id: string) => req<{ ok: true }>(`/api/providers/${id}`, { method: 'DELETE' }),
  search: (q: string, providers?: string[]) =>
    req<{ results: SearchResult[]; errors?: ProviderSearchError[] }>(
      `/api/search?q=${encodeURIComponent(q)}${providers?.length ? `&providers=${providers.join(',')}` : ''}`
    ),
  discover: () => req<{ peers: { id?: string; name: string; httpPort: number; from: string; addresses?: string[] }[] }>('/api/discover'),
  serverInfo: () =>
    req<{ name: string; version: string; deviceName?: string; addresses?: string[]; id?: string }>('/api/server-info'),
  lostfilmEpisodes: (url: string) =>
    req<{ episodes: EpisodeInfo[] }>(`/api/lostfilm/episodes?url=${encodeURIComponent(url)}`),
  lostfilmStream: (url: string) =>
    req<{ streamUrl: string | null; pageUrl: string }>(`/api/lostfilm/stream?url=${encodeURIComponent(url)}`),
  lordserialEpisodes: (url: string) =>
    req<{ episodes: EpisodeInfo[] }>(`/api/lordserial/episodes?url=${encodeURIComponent(url)}`),
  lordserialStream: (url: string) =>
    req<{ streamUrl: string | null; pageUrl: string }>(`/api/lordserial/stream?url=${encodeURIComponent(url)}`),
  rutubeStream: (url: string) =>
    req<{ streamUrl: string | null; pageUrl: string; title?: string; durationMs?: number }>(
      `/api/rutube/stream?url=${encodeURIComponent(url)}`
    ),
  rutubeSeason: (url: string) =>
    req<RutubeSeasonPack>(`/api/rutube/season?url=${encodeURIComponent(url)}`),
  rutrackerTopic: (url: string) =>
    req<{ title: string; magnet: string }>(`/api/rutracker/topic?url=${encodeURIComponent(url)}`),
  library: () =>
    req<LibraryInfo>('/api/library', { headers: { 'Content-Type': 'application/json', ...mediaTokenHeader() } }),
  addLibraryFolder: (path: string) =>
    req<{ ok: true }>('/api/library/folders', { method: 'POST', body: JSON.stringify({ path }) }),
  removeLibraryFolder: (id: number) =>
    req<{ ok: true }>(`/api/library/folders/${id}`, { method: 'DELETE' }),
  scanLibrary: () => req<{ ok: true; scannedAt: number }>('/api/library/scan', { method: 'POST', body: '{}' }),
  roomHistory: (roomId: string) =>
    req<{ history: HistoryEntry[] }>(`/api/rooms/${roomId}/history`, {
      headers: { 'Content-Type': 'application/json', ...roomTokenHeader(roomId) },
    }),
};

// Токены доступа к REST комнат с паролем (история и т.п.): выдаются при входе.
const roomTokens = new Map<string, string>();
export function setRoomToken(roomId: string, token: string | null | undefined) {
  if (token) roomTokens.set(roomId, token);
}
function roomTokenHeader(roomId: string): Record<string, string> {
  const t = roomTokens.get(roomId);
  return t ? { 'X-Room-Token': t } : {};
}

// Токен медиа-прокси выдаётся сервером при входе в комнату. Из LAN прокси
// работает и без него, а гостям через интернет-туннель он обязателен.
let proxyAccessToken: string | null = null;
export function setProxyToken(t: string | null | undefined) {
  proxyAccessToken = t || null;
}

// Добавляет токен к ссылкам на медиа-прокси и файлы медиатеки (в т.ч. сохранённым
// в истории/очереди) — без него гости через интернет-туннель получат 403.
export function withProxyToken(url: string): string {
  if (!proxyAccessToken || /[?&]t=/.test(url)) return url;
  const t = encodeURIComponent(proxyAccessToken);
  if (url.startsWith('/api/proxy/stream?')) return `${url}&t=${t}`;
  if (url.startsWith('/api/library/stream/')) return `${url}?t=${t}`;
  return url;
}

function mediaTokenHeader(): Record<string, string> {
  return proxyAccessToken ? { 'X-Media-Token': proxyAccessToken } : {};
}

// Обёртка потока в серверный медиа-прокси (Referer + CORS + доступность для LAN).
export function proxiedStream(url: string, referer?: string): string {
  let p = `/api/proxy/stream?url=${encodeURIComponent(url)}`;
  if (referer) p += `&referer=${encodeURIComponent(referer)}`;
  return p;
}

export function isRutubeUrl(url: string): boolean {
  return /rutube\.ru\/(?:video|play\/embed)\/[0-9a-f]{32}/i.test(url);
}

export function connectSocket(): Socket {
  return io(apiBase() || undefined, { transports: ['websocket', 'polling'] });
}
