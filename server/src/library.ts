// Медиатека: видеофайлы из папок этого ПК — для всех устройств дома и гостей комнаты.
// Папки добавляет только сам хост (на этом компьютере); файлы отдаются по id
// (не по пути!), поэтому через API нельзя прочитать ничего вне выбранных папок.
// Воспроизведение — потоком с поддержкой Range: перемотка работает сразу.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { classifyRequest, requireAccess, isValidProxyToken } from './security.js';

db.exec(`
CREATE TABLE IF NOT EXISTS library_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS library_files (
  id TEXT PRIMARY KEY,              -- sha1(полный путь), стабилен между сканированиями
  folder_id INTEGER NOT NULL,
  rel_path TEXT NOT NULL,           -- путь внутри папки (для показа «где лежит»)
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_files_folder ON library_files (folder_id);
`);

// Тип по расширению. «Играет в приложении» — то, что умеет Chromium без перекодирования
// (MKV/MOV — если внутри H.264/VP9 и AAC/Opus; с HEVC/AC3 может не быть картинки или звука).
const VIDEO_TYPES: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm',
  ogv: 'video/ogg', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
  ts: 'video/mp2t', m2ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp',
};
const PLAYABLE = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv']);
const SKIP_DIRS = /^(\.|\$)|^(System Volume Information|node_modules)$/i;
const MAX_FILES = 50000;
const MAX_DEPTH = 10;

interface FolderRow { id: number; path: string; added_at: number }
interface FileRow { id: string; folder_id: number; rel_path: string; name: string; ext: string; size: number; mtime: number }

const listFolders = () => db.prepare(`SELECT * FROM library_folders ORDER BY path`).all() as unknown as FolderRow[];
const fileById = (id: string) => db.prepare(`SELECT * FROM library_files WHERE id = ?`).get(id) as FileRow | undefined;
const folderById = (id: number) => db.prepare(`SELECT * FROM library_folders WHERE id = ?`).get(id) as FolderRow | undefined;

// «Breaking.Bad.S01E02.1080p.mkv» → «Breaking Bad S01E02 1080p»
export function titleFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Сканирование ───
let scanning = false;
let scannedAt = 0;

async function walk(root: string, dir: string, depth: number, out: Omit<FileRow, 'folder_id'>[]) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // нет доступа или папку удалили — пропускаем
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.isSymbolicLink()) continue; // ссылки могут увести за пределы папки
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.test(e.name)) await walk(root, full, depth + 1, out);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).slice(1).toLowerCase();
    if (!VIDEO_TYPES[ext]) continue; // в т.ч. недокачанные .!qB/.part торрентов
    try {
      const st = await fs.promises.stat(full);
      if (st.size < 1024 * 1024) continue; // сэмплы и мусор меньше 1 МБ
      out.push({
        id: crypto.createHash('sha1').update(full).digest('hex').slice(0, 20),
        rel_path: path.relative(root, full),
        name: e.name,
        ext,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
      });
    } catch { /* файл исчез во время сканирования */ }
  }
}

export async function scanLibrary(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    for (const folder of listFolders()) {
      const found: Omit<FileRow, 'folder_id'>[] = [];
      await walk(folder.path, folder.path, 0, found);
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM library_files WHERE folder_id = ?`).run(folder.id);
        const ins = db.prepare(
          `INSERT OR REPLACE INTO library_files (id, folder_id, rel_path, name, ext, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const f of found) ins.run(f.id, folder.id, f.rel_path, f.name, f.ext, f.size, f.mtime);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    // Файлы удалённых папок.
    db.exec(`DELETE FROM library_files WHERE folder_id NOT IN (SELECT id FROM library_folders)`);
    scannedAt = Date.now();
  } finally {
    scanning = false;
  }
}

// Новые загрузки торрент-клиента подхватываются сами: пересканирование раз в 10 минут.
export function startLibraryRescans() {
  void scanLibrary().catch((e) => console.warn('[library] сканирование:', e));
  setInterval(() => { void scanLibrary().catch(() => {}); }, 10 * 60 * 1000).unref();
}

// ─── Доступ ───
// Как у медиа-прокси: в LAN открыто, из интернета (туннель) — только участникам
// комнаты (токен выдаётся при входе в комнату).
function mediaAllowed(req: FastifyRequest): boolean {
  if (classifyRequest(req) !== 'public') return true;
  const q = req.query as { t?: string };
  return isValidProxyToken(q.t ?? req.headers['x-media-token']);
}

function deny(reply: FastifyReply) {
  return reply.code(403).send({ error: 'Медиатека доступна участникам комнаты' });
}

// Разбор заголовка Range: «bytes=500-», «bytes=500-999», «bytes=-500».
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

// ─── Маршруты ───
export async function registerLibraryRoutes(app: FastifyInstance) {
  // Список файлов. Полные пути видит только сам хост; остальным — имя папки.
  app.get('/api/library', async (req, reply) => {
    if (!mediaAllowed(req)) return deny(reply);
    const isLocal = classifyRequest(req) === 'local';
    const folders = listFolders();
    const folderLabel = new Map(folders.map((f) => [f.id, path.basename(f.path) || f.path]));
    const files = (db.prepare(`SELECT * FROM library_files ORDER BY mtime DESC`).all() as unknown as FileRow[]).map((f) => ({
      id: f.id,
      name: f.name,
      title: titleFromName(f.name),
      dir: path.dirname(f.rel_path) === '.' ? '' : path.dirname(f.rel_path),
      folder: folderLabel.get(f.folder_id) ?? '',
      size: f.size,
      mtime: f.mtime,
      playable: PLAYABLE.has(f.ext),
      ext: f.ext,
    }));
    const counts = new Map(
      (db.prepare(`SELECT folder_id, COUNT(*) AS n FROM library_files GROUP BY folder_id`).all() as { folder_id: number; n: number }[])
        .map((r) => [r.folder_id, r.n]),
    );
    return {
      files,
      folders: isLocal
        ? folders.map((f) => ({ id: f.id, path: f.path, files: counts.get(f.id) ?? 0 }))
        : folders.map((f) => ({ id: f.id, path: folderLabel.get(f.id) ?? '' })),
      canManage: isLocal,
      scanning,
      scannedAt,
    };
  });

  app.post('/api/library/folders', { preHandler: requireAccess('local') }, async (req, reply) => {
    const raw = String((req.body as { path?: string } | undefined)?.path ?? '').trim().replace(/^"|"$/g, '');
    if (!raw || !path.isAbsolute(raw)) return reply.code(400).send({ error: 'Укажите полный путь к папке, напр. D:\\Фильмы' });
    let real: string;
    try {
      real = await fs.promises.realpath(raw);
      if (!(await fs.promises.stat(real)).isDirectory()) throw new Error('not a dir');
    } catch {
      return reply.code(400).send({ error: 'Папка не найдена' });
    }
    if (path.parse(real).root === real) {
      return reply.code(400).send({ error: 'Целый диск добавить нельзя — выберите папку с видео' });
    }
    db.prepare(`INSERT OR IGNORE INTO library_folders (path, added_at) VALUES (?, ?)`).run(real, Date.now());
    void scanLibrary().catch(() => {});
    return { ok: true };
  });

  app.delete('/api/library/folders/:id', { preHandler: requireAccess('local') }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    db.prepare(`DELETE FROM library_files WHERE folder_id = ?`).run(id);
    db.prepare(`DELETE FROM library_folders WHERE id = ?`).run(id);
    return { ok: true };
  });

  app.post('/api/library/scan', { preHandler: requireAccess('local', 'lan') }, async () => {
    await scanLibrary();
    return { ok: true, scannedAt };
  });

  // Поток файла: Range → 206 с нужным куском (перемотка без скачивания целиком).
  app.get('/api/library/stream/:id', async (req, reply) => {
    if (!mediaAllowed(req)) return deny(reply);
    const file = fileById((req.params as { id: string }).id);
    const folder = file ? folderById(file.folder_id) : undefined;
    if (!file || !folder) return reply.code(404).send({ error: 'Файл не найден — обновите медиатеку' });

    // Путь из БД всё равно перепроверяем: файл внутри папки и это обычный файл.
    const full = path.resolve(folder.path, file.rel_path);
    if (!full.startsWith(path.resolve(folder.path) + path.sep)) return reply.code(404).send({ error: 'Файл не найден' });
    let size: number;
    try {
      const st = await fs.promises.stat(full);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      return reply.code(404).send({ error: 'Файл удалён или перемещён — обновите медиатеку' });
    }

    const type = VIDEO_TYPES[file.ext] ?? 'application/octet-stream';
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', type);
    reply.header('Cache-Control', 'no-cache');
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.code(416).send();
    }
    if (!range) {
      reply.header('Content-Length', String(size));
      return reply.send(fs.createReadStream(full));
    }
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    reply.header('Content-Length', String(range.end - range.start + 1));
    return reply.send(fs.createReadStream(full, { start: range.start, end: range.end }));
  });
}
