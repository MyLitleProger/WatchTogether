// REST API: комнаты, провайдеры, поиск, информация о сервере.
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  createRoom, getRoom, listRooms, listMembers,
  listProviders, upsertProvider, deleteProvider, db, historyList,
  getClientSecretHash, addClient,
} from './db.js';
import { searchProviders } from './providers/index.js';
import { getSeriesEpisodes, getEpisodeStream } from './providers/lostfilm.js';
import { getLordSerialEpisodes, getLordSerialStream } from './providers/lordserial.js';
import { getRutubeStream, getRutubeSeasonPack } from './providers/rutube.js';
import { getRuTrackerTopic, ProviderError } from './providers/rutracker.js';
import { APP_VERSION } from './version.js';
import { deviceName, localAddresses, INSTANCE_ID } from './discovery.js';
import {
  classifyRequest, requireAccess, isValidProxyToken, proxyToken, safeFetch, SsrfError,
  hashPassword, hasRoomAccess, verifyClient, mirrorHosts, isMirrorUrl,
} from './security.js';

const newId = (len = 8) => crypto.randomBytes(len).toString('base64url').slice(0, len);

export async function registerRoutes(app: FastifyInstance) {
  // Информация о сервере (для LAN-discovery, ссылок-приглашений и экрана подключения)
  app.get('/api/server-info', async (_req, reply) => {
    // Единственная ручка с CORS: предпроверка «Подключиться» с чужого origin.
    reply.header('Access-Control-Allow-Origin', '*');
    return {
    name: 'WatchTogether',
    version: APP_VERSION,
    serverTime: Date.now(),
    deviceName: deviceName(),
    addresses: localAddresses(),
    id: INSTANCE_ID,
    };
  });

  // --- комнаты ---
  app.get('/api/rooms', async () =>
    listRooms().map((r) => ({
      id: r.id,
      name: r.name,
      controlMode: r.control_mode,
      hasPassword: !!r.password_hash,
      // Что смотрят в комнате с паролем — видно только вошедшим.
      video: !r.password_hash && r.current_video_json ? JSON.parse(r.current_video_json) : null,
      positionSec: r.password_hash ? 0 : r.position_sec,
      state: r.password_hash ? 'paused' : r.state,
      updatedAt: r.updated_at,
      members: listMembers(r.id).length,
    }))
  );

  app.post('/api/rooms', async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string; password?: string; controlMode?: 'all' | 'host'; hostClientId?: string; hostSecret?: string;
    };
    const name = String(body.name ?? '').trim().slice(0, 100);
    if (!name) return reply.code(400).send({ error: 'Укажите название комнаты' });
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    // Хостом становится только тот, кто доказал владение clientId секретом.
    const hostOk = !!body.hostClientId
      && verifyClient(body.hostClientId, body.hostSecret, { get: getClientSecretHash, add: addClient });
    if (body.controlMode === 'host' && !hostOk) {
      return reply.code(400).send({ error: 'Не удалось подтвердить устройство хоста' });
    }
    const room = {
      id: newId(8),
      name,
      password_hash: password ? hashPassword(password) : null,
      control_mode: body.controlMode === 'host' ? ('host' as const) : ('all' as const),
      current_video_json: null,
      position_sec: 0,
      state: 'paused' as const,
      host_client_id: hostOk ? body.hostClientId! : null,
      updated_at: Date.now(),
      created_at: Date.now(),
    };
    createRoom(room);
    return { id: room.id, name: room.name };
  });

  app.get('/api/rooms/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = getRoom(id);
    if (!room) return reply.code(404).send({ error: 'Комната не найдена' });
    if (!hasRoomAccess(req, room)) {
      // Без пароля — только публичная карточка комнаты.
      return { id: room.id, name: room.name, controlMode: room.control_mode, hasPassword: true };
    }
    return {
      id: room.id,
      name: room.name,
      controlMode: room.control_mode,
      hasPassword: !!room.password_hash,
      video: room.current_video_json ? JSON.parse(room.current_video_json) : null,
      positionSec: room.position_sec,
      state: room.state,
      updatedAt: room.updated_at,
      members: listMembers(room.id),
    };
  });

  app.delete('/api/rooms/:id', { preHandler: requireAccess('local', 'lan') }, async (req) => {
    const { id } = req.params as { id: string };
    db.prepare(`DELETE FROM members WHERE room_id = ?`).run(id);
    db.prepare(`DELETE FROM chat_messages WHERE room_id = ?`).run(id);
    db.prepare(`DELETE FROM rooms WHERE id = ?`).run(id);
    return { ok: true };
  });

  // --- провайдеры контента ---
  // Куки сессии наружу не отдаём (защита от угона сессии в LAN): только флаг hasCookies.
  app.get('/api/providers', async () =>
    listProviders().map((p) => {
      const config = JSON.parse(p.config_json);
      const hasCookies = typeof config.cookies === 'string' && config.cookies.length > 0;
      delete config.cookies;
      return {
        id: p.id, type: p.type, name: p.name, enabled: !!p.enabled,
        config: { ...config, hasCookies },
      };
    })
  );

  app.put('/api/providers/:id', { preHandler: requireAccess('local') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { type?: string; name?: string; config?: object; enabled?: boolean };
    if (!body.name || !body.type) return reply.code(400).send({ error: 'Нужны name и type' });
    const prev = listProviders().find((p) => p.id === id);
    const prevConfig = prev ? JSON.parse(prev.config_json) : {};
    const newConfig = { ...(body.config ?? {}) } as Record<string, unknown>;
    delete newConfig.hasCookies; // служебный флаг, не хранить
    if (newConfig.cookies === undefined && prevConfig.cookies) {
      newConfig.cookies = prevConfig.cookies; // не затираем куки при правке зеркал
    }
    upsertProvider({
      id,
      type: body.type as 'youtube' | 'lostfilm' | 'lordserial' | 'custom',
      name: body.name,
      config_json: JSON.stringify(newConfig),
      enabled: body.enabled === false ? 0 : 1,
    });
    return { ok: true };
  });

  // Куки сессии из встроенного окна авторизации (Electron) — или сброс пустой строкой.
  app.post('/api/providers/:id/cookies', { preHandler: requireAccess('local') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { cookies } = (req.body ?? {}) as { cookies?: string };
    const row = listProviders().find((p) => p.id === id);
    if (!row) return reply.code(404).send({ error: 'Провайдер не найден' });
    const config = JSON.parse(row.config_json);
    if (cookies && cookies.trim()) config.cookies = cookies.trim();
    else delete config.cookies;
    upsertProvider({ ...row, config_json: JSON.stringify(config) });
    return { ok: true, hasCookies: !!config.cookies };
  });

  app.delete('/api/providers/:id', { preHandler: requireAccess('local') }, async (req) => {
    deleteProvider((req.params as { id: string }).id);
    return { ok: true };
  });

  // --- LostFilm: серии сериала и поток конкретной серии ---
  const lostfilmConfig = () => {
    const row = listProviders().find((p) => p.id === 'lostfilm');
    return row ? JSON.parse(row.config_json) : {};
  };

  app.get('/api/lostfilm/episodes', async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'Нужен url страницы сериала' });
    if (!isMirrorUrl(url, mirrorHosts(lostfilmConfig().mirrors))) {
      return reply.code(400).send({ error: 'Ссылка не на зеркало LostFilm из настроек источника' });
    }
    try {
      const episodes = await getSeriesEpisodes(url, lostfilmConfig());
      return { episodes };
    } catch (e) {
      return reply.code(502).send({ error: `Не удалось разобрать страницу: ${e instanceof Error ? e.message : e}` });
    }
  });

  app.get('/api/lostfilm/stream', async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'Нужен url серии' });
    if (!isMirrorUrl(url, mirrorHosts(lostfilmConfig().mirrors))) {
      return reply.code(400).send({ error: 'Ссылка не на зеркало LostFilm из настроек источника' });
    }
    try {
      return await getEpisodeStream(url, lostfilmConfig());
    } catch (e) {
      return reply.code(502).send({ error: `Не удалось получить поток: ${e instanceof Error ? e.message : e}` });
    }
  });

  // --- LordSerial: серии сериала и поток конкретной серии ---
  const lordserialConfig = () => {
    const row = listProviders().find((p) => p.id === 'lordserial');
    return row ? JSON.parse(row.config_json) : {};
  };

  app.get('/api/lordserial/episodes', async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'Нужен url страницы сериала' });
    if (!isMirrorUrl(url, mirrorHosts(lordserialConfig().mirrors))) {
      return reply.code(400).send({ error: 'Ссылка не на зеркало LordSerial из настроек источника' });
    }
    try {
      const episodes = await getLordSerialEpisodes(url, lordserialConfig());
      return { episodes };
    } catch (e) {
      return reply.code(502).send({ error: `Не удалось разобрать страницу: ${e instanceof Error ? e.message : e}` });
    }
  });

  app.get('/api/lordserial/stream', async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'Нужен url серии' });
    if (!isMirrorUrl(url, mirrorHosts(lordserialConfig().mirrors))) {
      return reply.code(400).send({ error: 'Ссылка не на зеркало LordSerial из настроек источника' });
    }
    try {
      return await getLordSerialStream(url, lordserialConfig());
    } catch (e) {
      return reply.code(502).send({ error: `Не удалось получить поток: ${e instanceof Error ? e.message : e}` });
    }
  });

  // --- Rutube: поток ролика и «серии сезона» (собираются поиском по шаблону названия) ---
  app.get('/api/rutube/stream', async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'Нужен url ролика' });
    try {
      return await getRutubeStream(url);
    } catch (e) {
      return reply.code(502).send({ error: `Не удалось получить поток: ${e instanceof Error ? e.message : e}` });
    }
  });

  app.get('/api/rutube/season', async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'Нужен url ролика' });
    try {
      const pack = await getRutubeSeasonPack(url);
      return pack ?? { base: null, season: null, episodes: [] };
    } catch (e) {
      return reply.code(502).send({ error: `Не удалось собрать сезон: ${e instanceof Error ? e.message : e}` });
    }
  });

  // --- RuTracker: magnet-ссылка раздачи (смотреть раздачу напрямую нельзя —
  // её качает торрент-клиент, а файлы появляются в медиатеке) ---
  const rutrackerConfig = () => {
    const row = listProviders().find((p) => p.id === 'rutracker');
    return row ? JSON.parse(row.config_json) : {};
  };

  app.get('/api/rutracker/topic', async (req, reply) => {
    const { url } = req.query as { url?: string };
    if (!url) return reply.code(400).send({ error: 'Нужен url раздачи' });
    const config = rutrackerConfig();
    if (!isMirrorUrl(url, mirrorHosts(config.mirrors)) || !/\/forum\/viewtopic\.php\?t=\d+$/.test(url)) {
      return reply.code(400).send({ error: 'Ссылка не на раздачу RuTracker из настроек источника' });
    }
    try {
      return await getRuTrackerTopic(url, config);
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : 'ERROR';
      return reply.code(code === 'NEED_LOGIN' ? 401 : 502).send({
        error: e instanceof Error ? e.message : String(e), code,
      });
    }
  });

  // --- история просмотра комнаты ---
  app.get('/api/rooms/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = getRoom(id);
    if (!room) return reply.code(404).send({ error: 'Комната не найдена' });
    if (!hasRoomAccess(req, room)) return reply.code(403).send({ error: 'Нужен пароль комнаты' });
    return {
      history: historyList(id).map((h) => ({
        video: JSON.parse(h.video_json),
        positionSec: h.position_sec,
        finished: !!h.finished,
        updatedAt: h.updated_at,
      })),
    };
  });

  // Поиск по выбранным провайдерам: /api/search?q=...&providers=youtube,lostfilm
  app.get('/api/search', async (req, reply) => {
    const { q, providers } = req.query as { q?: string; providers?: string };
    if (!q?.trim()) return reply.code(400).send({ error: 'Пустой запрос' });
    if (q.length > 200) return reply.code(400).send({ error: 'Слишком длинный запрос' });
    const ids = providers ? providers.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    return await searchProviders(q.trim(), ids);
  });

  // --- Медиа-прокси: /api/proxy/stream?url=...&referer=... ---
  // Перехваченные потоки (m3u8/mp4) часто требуют Referer/регион хоста и не отдают
  // CORS — гоняем через сервер: участникам в LAN видео доступно всегда,
  // а hls.js работает same-origin. m3u8 переписываем: сегменты тоже идут через прокси.
  app.get('/api/proxy/stream', async (req, reply) => {
    const { url, referer, t } = req.query as { url?: string; referer?: string; t?: string };
    if (!url) return reply.code(400).send({ error: 'Нужен url' });
    // Из интернета (туннель) прокси работает только с токеном участника комнаты —
    // иначе это открытый прокси, который ходит в сеть с вашего домашнего IP.
    const hasToken = isValidProxyToken(t);
    if (!hasToken && classifyRequest(req) === 'public') {
      return reply.code(403).send({ error: 'Нужен токен доступа (войдите в комнату)' });
    }

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'Некорректный url' });
    }

    const range = req.headers.range;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let upstream: Awaited<ReturnType<typeof safeFetch>>['res'];
    let finalUrl: URL;
    try {
      ({ res: upstream, finalUrl } = await safeFetch(target, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': PROXY_UA,
          ...(referer ? { Referer: referer } : {}),
          ...(range ? { Range: range } : {}),
        },
      }));
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof SsrfError || (e as { cause?: unknown })?.cause instanceof SsrfError) {
        return reply.code(403).send({ error: 'Этот адрес проксировать нельзя' });
      }
      return reply.code(502).send({ error: `Источник не ответил: ${e instanceof Error ? e.message : e}` });
    }
    clearTimeout(timer);

    if (!upstream.ok && upstream.status !== 206) {
      return reply.code(upstream.status).send({ error: `Источник ответил HTTP ${upstream.status}` });
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    const isPlaylist = /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(target.pathname);

    // Плейлист: читаем целиком и переписываем ссылки на сегменты через прокси.
    if (isPlaylist) {
      const text = await upstream.text();
      const base = finalUrl.toString();
      reply.header('Content-Type', 'application/vnd.apple.mpegurl');
      reply.header('Cache-Control', 'no-cache');
      return reply.send(rewriteM3U8(text, base, referer, hasToken ? proxyToken() : undefined));
    }

    // Бинарный поток (mp4/ts/m4s): пробрасываем статус и заголовки диапазонов.
    reply.code(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) reply.header(h, v);
    }
    if (!upstream.body) return reply.send('');
    return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
  });
}

const PROXY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Перепись m3u8: URI сегментов/вариантов и URI="..." в атрибутах (ключи, аудио,
// субтитры) заворачиваем в прокси; относительные ссылки резолвим от плейлиста.
function rewriteM3U8(text: string, baseUrl: string, referer?: string, token?: string): string {
  const wrap = (u: string): string => {
    try {
      const abs = new URL(u, baseUrl).toString();
      let out = `/api/proxy/stream?url=${encodeURIComponent(abs)}`;
      if (referer) out += `&referer=${encodeURIComponent(referer)}`;
      if (token) out += `&t=${token}`;
      return out;
    } catch {
      return u; // битая строка — оставляем как есть
    }
  };
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${wrap(u)}"`);
      }
      return wrap(t);
    })
    .join('\n');
}
