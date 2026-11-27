// Хранилище: встроенный node:sqlite (без нативных зависимостей).
// Файл БД — watchtogether.db рядом с сервером; переживает перезапуски.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptSecret, decryptSecret, isEncrypted, secretEncryptionEnabled } from './secretbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.WT_DB_PATH ?? path.join(__dirname, '..', 'watchtogether.db');

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT,
  control_mode TEXT NOT NULL DEFAULT 'all',       -- 'all' | 'host'
  current_video_json TEXT,                         -- WatchSource | null
  position_sec REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'paused',            -- 'playing' | 'paused'
  host_client_id TEXT,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  room_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room_id, client_id)
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                              -- 'youtube' | 'lostfilm' | 'custom'
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages (room_id, id);

-- Очередь просмотра комнаты (порядок = id).
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  video_json TEXT NOT NULL,                          -- WatchSource (стабильная ссылка, не поток)
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_room ON queue (room_id, id);

-- История просмотра: что смотрели в комнате, где остановились, досмотрели ли.
CREATE TABLE IF NOT EXISTS history (
  room_id TEXT NOT NULL,
  url TEXT NOT NULL,                                 -- ключ: WatchSource.url
  video_json TEXT NOT NULL,
  position_sec REAL NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, url)
);
CREATE INDEX IF NOT EXISTS idx_history_room ON history (room_id, updated_at);

-- Устройства участников: clientId публичен (виден в комнате), поэтому
-- владение им подтверждается секретом. Первый пришедший с clientId «занимает» его.
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Служебные настройки сервера (секреты и т.п.), ключ → значение.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Однократно шифруем куки, сохранённые старыми версиями открытым текстом.
export function encryptStoredCookies() {
  if (!secretEncryptionEnabled) return;
  const raw = db.prepare(`SELECT * FROM providers`).all() as unknown as ProviderRow[];
  for (const row of raw) {
    const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
    if (typeof cfg.cookies === 'string' && cfg.cookies && !isEncrypted(cfg.cookies)) upsertProvider(row);
  }
}

export function getClientSecretHash(clientId: string): string | undefined {
  const row = db.prepare(`SELECT secret_hash FROM clients WHERE client_id = ?`).get(clientId) as { secret_hash: string } | undefined;
  return row?.secret_hash;
}

export function addClient(clientId: string, secretHash: string) {
  db.prepare(`INSERT OR IGNORE INTO clients (client_id, secret_hash, created_at) VALUES (?, ?, ?)`)
    .run(clientId, secretHash, Date.now());
}

export function setRoomPasswordHash(roomId: string, hash: string) {
  db.prepare(`UPDATE rooms SET password_hash = ? WHERE id = ?`).run(hash, roomId);
}

export function queueCount(roomId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE room_id = ?`).get(roomId) as { n: number }).n;
}

// Миграция: «скрытая» комната (не показывается в общем списке).
{
  const cols = db.prepare(`PRAGMA table_info(rooms)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'hidden')) db.exec(`ALTER TABLE rooms ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
}

export function updateRoomSettings(id: string, patch: { name?: string; password_hash?: string | null; hidden?: boolean }) {
  if (patch.name !== undefined) db.prepare(`UPDATE rooms SET name = ? WHERE id = ?`).run(patch.name, id);
  if (patch.password_hash !== undefined) db.prepare(`UPDATE rooms SET password_hash = ? WHERE id = ?`).run(patch.password_hash, id);
  if (patch.hidden !== undefined) db.prepare(`UPDATE rooms SET hidden = ? WHERE id = ?`).run(patch.hidden ? 1 : 0, id);
}

export function deleteRoom(id: string) {
  for (const t of ['members', 'chat_messages', 'queue', 'history']) {
    db.prepare(`DELETE FROM ${t} WHERE room_id = ?`).run(id);
  }
  db.prepare(`DELETE FROM rooms WHERE id = ?`).run(id);
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

// --- типы ---
export interface RoomRow {
  id: string;
  name: string;
  password_hash: string | null;
  control_mode: 'all' | 'host';
  current_video_json: string | null;
  position_sec: number;
  state: 'playing' | 'paused';
  host_client_id: string | null;
  updated_at: number;
  created_at: number;
  hidden?: number;
}

export interface ProviderRow {
  id: string;
  type: 'youtube' | 'lostfilm' | 'lordserial' | 'rutube' | 'rutracker' | 'custom';
  name: string;
  config_json: string;
  enabled: number;
}

// --- комнаты ---
export function createRoom(row: RoomRow) {
  db.prepare(
    `INSERT INTO rooms (id, name, password_hash, control_mode, current_video_json, position_sec, state, host_client_id, updated_at, created_at, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.name, row.password_hash, row.control_mode, row.current_video_json,
        row.position_sec, row.state, row.host_client_id, row.updated_at, row.created_at, row.hidden ? 1 : 0);
}

export function getRoom(id: string): RoomRow | undefined {
  return db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
}

export function listRooms(): RoomRow[] {
  return db.prepare(`SELECT * FROM rooms ORDER BY updated_at DESC`).all() as unknown as RoomRow[];
}

export function updateRoomPlayback(id: string, positionSec: number, state: 'playing' | 'paused') {
  db.prepare(`UPDATE rooms SET position_sec = ?, state = ?, updated_at = ? WHERE id = ?`)
    .run(positionSec, state, Date.now(), id);
}

export function updateRoomVideo(id: string, videoJson: string | null) {
  db.prepare(`UPDATE rooms SET current_video_json = ?, position_sec = 0, state = 'paused', updated_at = ? WHERE id = ?`)
    .run(videoJson, Date.now(), id);
}

// --- участники ---
export function upsertMember(roomId: string, clientId: string, nickname: string) {
  db.prepare(
    `INSERT INTO members (room_id, client_id, nickname, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(room_id, client_id) DO UPDATE SET nickname = excluded.nickname, last_seen = excluded.last_seen`
  ).run(roomId, clientId, nickname, Date.now());
}

export function touchMember(roomId: string, clientId: string) {
  db.prepare(`UPDATE members SET last_seen = ? WHERE room_id = ? AND client_id = ?`)
    .run(Date.now(), roomId, clientId);
}

export function listMembers(roomId: string): { client_id: string; nickname: string; last_seen: number }[] {
  return db.prepare(`SELECT client_id, nickname, last_seen FROM members WHERE room_id = ? ORDER BY nickname`)
    .all(roomId) as unknown as { client_id: string; nickname: string; last_seen: number }[];
}

// --- провайдеры (источники контента, редактируемые пользователем) ---
// Куки сессий в config_json хранятся зашифрованными (secretbox); снаружи этих
// функций весь код видит обычный текст.
function mapCookies(configJson: string, fn: (v: string) => string | null): string {
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(configJson); } catch { return configJson; }
  if (typeof cfg.cookies !== 'string' || !cfg.cookies) return configJson;
  const next = fn(cfg.cookies);
  if (next === null) delete cfg.cookies; // не расшифровать (ключ сменился) — как будто входа не было
  else cfg.cookies = next;
  return JSON.stringify(cfg);
}

export function listProviders(): ProviderRow[] {
  const rows = db.prepare(`SELECT * FROM providers ORDER BY name`).all() as unknown as ProviderRow[];
  return rows.map((r) => ({ ...r, config_json: mapCookies(r.config_json, decryptSecret) }));
}

export function upsertProvider(p: ProviderRow) {
  p = { ...p, config_json: mapCookies(p.config_json, encryptSecret) };
  db.prepare(
    `INSERT INTO providers (id, type, name, config_json, enabled) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name,
       config_json = excluded.config_json, enabled = excluded.enabled`
  ).run(p.id, p.type, p.name, p.config_json, p.enabled);
}

export function deleteProvider(id: string) {
  db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
}

// --- чат ---
export interface ChatMessage {
  id: number;
  room_id: string;
  client_id: string;
  nickname: string;
  text: string;
  ts: number;
}

export function addChatMessage(roomId: string, clientId: string, nickname: string, text: string): ChatMessage {
  const ts = Date.now();
  const res = db.prepare(
    `INSERT INTO chat_messages (room_id, client_id, nickname, text, ts) VALUES (?, ?, ?, ?, ?)`
  ).run(roomId, clientId, nickname, text, ts);
  return { id: Number(res.lastInsertRowid), room_id: roomId, client_id: clientId, nickname, text, ts };
}

export function listChatMessages(roomId: string, limit = 50): ChatMessage[] {
  return db.prepare(
    `SELECT * FROM (SELECT * FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
  ).all(roomId, limit) as unknown as ChatMessage[];
}

// --- очередь просмотра ---
export interface QueueItem {
  id: number;
  room_id: string;
  video_json: string;
  added_by: string;
  added_at: number;
}

export function queueAdd(roomId: string, videoJson: string, addedBy: string): QueueItem {
  const res = db.prepare(
    `INSERT INTO queue (room_id, video_json, added_by, added_at) VALUES (?, ?, ?, ?)`
  ).run(roomId, videoJson, addedBy, Date.now());
  return { id: Number(res.lastInsertRowid), room_id: roomId, video_json: videoJson, added_by: addedBy, added_at: Date.now() };
}

export function queueList(roomId: string): QueueItem[] {
  return db.prepare(`SELECT * FROM queue WHERE room_id = ? ORDER BY id ASC`).all(roomId) as unknown as QueueItem[];
}

export function queueRemove(roomId: string, id: number) {
  db.prepare(`DELETE FROM queue WHERE room_id = ? AND id = ?`).run(roomId, id);
}

export function queueClear(roomId: string) {
  db.prepare(`DELETE FROM queue WHERE room_id = ?`).run(roomId);
}

// Атомарно снять первый элемент очереди (автопереход к следующей серии).
export function queueShift(roomId: string): QueueItem | undefined {
  const first = db.prepare(`SELECT * FROM queue WHERE room_id = ? ORDER BY id ASC LIMIT 1`).get(roomId) as QueueItem | undefined;
  if (first) db.prepare(`DELETE FROM queue WHERE id = ?`).run(first.id);
  return first;
}

// --- история просмотра ---
export interface HistoryRow {
  room_id: string;
  url: string;
  video_json: string;
  position_sec: number;
  finished: number;
  updated_at: number;
}

export function historyUpsert(roomId: string, videoJson: string, url: string, positionSec: number, finished: boolean) {
  db.prepare(
    `INSERT INTO history (room_id, url, video_json, position_sec, finished, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id, url) DO UPDATE SET
       video_json = excluded.video_json,
       position_sec = excluded.position_sec,
       finished = MAX(history.finished, excluded.finished),
       updated_at = excluded.updated_at`
  ).run(roomId, url, videoJson, positionSec, finished ? 1 : 0, Date.now());
}

export function historyList(roomId: string, limit = 50): HistoryRow[] {
  return db.prepare(`SELECT * FROM history WHERE room_id = ? ORDER BY updated_at DESC LIMIT ?`)
    .all(roomId, limit) as unknown as HistoryRow[];
}

// Сиды по умолчанию: YouTube + LostFilm + LordSerial с редактируемыми списками зеркал.
// Работает и на существующих БД: недостающие провайдеры добавляются, а конфиги
// со старой configVersion обновляются (зеркала пользователя сохраняются) — без этого
// в уже установленных приложениях оставались бы селекторы от старой вёрстки сайтов.
const LOSTFILM_CONFIG_VERSION = 3;

const LOSTFILM_DEFAULTS = {
  // Зеркала перебираются по очереди до первого отвечающего; список правится из UI.
  mirrors: ['https://www.lostfilm.today', 'https://www.lostfilm.tv', 'https://lostfilm.site'],
  searchPath: '/search/?q={q}',
  itemSelector: '.row-search',
  titleSelector: '.name-ru, .name-en',
  linkSelector: 'a.no-decoration',
  loginPath: '/login', // страница авторизации (кнопка «Авторизоваться» в клиенте)
};

const LORDSERIAL_CONFIG_VERSION = 2;

const LORDSERIAL_DEFAULTS = {
  mirrors: ['https://lordserials.fan'],
  loginPath: '/login',
};

const RUTRACKER_DEFAULTS = {
  // Зеркала одного сайта; куки входа действуют на том домене, где выполнен вход.
  mirrors: ['https://rutracker.org', 'https://rutracker.net'],
  loginPath: '/forum/login.php',
  configVersion: 1,
};

export function seedProviders() {
  const byId = new Map(listProviders().map((p) => [p.id, p]));
  if (!byId.has('rutracker')) {
    upsertProvider({
      id: 'rutracker', type: 'rutracker', name: 'RuTracker',
      config_json: JSON.stringify(RUTRACKER_DEFAULTS),
      enabled: 1,
    });
  }

  if (!byId.has('youtube')) {
    upsertProvider({ id: 'youtube', type: 'youtube', name: 'YouTube', config_json: '{}', enabled: 1 });
  }

  if (!byId.has('rutube')) {
    upsertProvider({ id: 'rutube', type: 'rutube', name: 'Rutube', config_json: '{}', enabled: 1 });
  }

  const lf = byId.get('lostfilm');
  if (!lf) {
    upsertProvider({
      id: 'lostfilm', type: 'lostfilm', name: 'LostFilm',
      config_json: JSON.stringify({ ...LOSTFILM_DEFAULTS, configVersion: LOSTFILM_CONFIG_VERSION }),
      enabled: 1,
    });
  } else {
    const cfg = JSON.parse(lf.config_json) as Record<string, unknown>;
    if (Number(cfg.configVersion ?? 0) < LOSTFILM_CONFIG_VERSION) {
      upsertProvider({
        id: 'lostfilm', type: 'lostfilm', name: lf.name,
        config_json: JSON.stringify({
          ...LOSTFILM_DEFAULTS,
          mirrors: Array.isArray(cfg.mirrors) && cfg.mirrors.length > 0 ? cfg.mirrors : LOSTFILM_DEFAULTS.mirrors,
          ...(typeof cfg.cookies === 'string' && cfg.cookies ? { cookies: cfg.cookies } : {}),
          configVersion: LOSTFILM_CONFIG_VERSION,
        }),
        enabled: lf.enabled,
      });
      console.log('[db] конфиг LostFilm обновлён до актуальных селекторов (зеркала и куки сохранены)');
    }
  }

  const ls = byId.get('lordserial');
  if (!ls) {
    upsertProvider({
      id: 'lordserial', type: 'lordserial', name: 'LordSerial',
      config_json: JSON.stringify({ ...LORDSERIAL_DEFAULTS, configVersion: LORDSERIAL_CONFIG_VERSION }),
      enabled: 1,
    });
  } else {
    const cfg = JSON.parse(ls.config_json) as Record<string, unknown>;
    if (Number(cfg.configVersion ?? 0) < LORDSERIAL_CONFIG_VERSION) {
      upsertProvider({
        id: 'lordserial', type: 'lordserial', name: ls.name,
        config_json: JSON.stringify({
          ...LORDSERIAL_DEFAULTS,
          mirrors: Array.isArray(cfg.mirrors) && cfg.mirrors.length > 0 ? cfg.mirrors : LORDSERIAL_DEFAULTS.mirrors,
          ...(typeof cfg.cookies === 'string' && cfg.cookies ? { cookies: cfg.cookies } : {}),
          configVersion: LORDSERIAL_CONFIG_VERSION,
        }),
        enabled: ls.enabled,
      });
      console.log('[db] конфиг LordSerial обновлён (зеркала и куки сохранены)');
    }
  }
}
