// Socket.IO: синхронизация воспроизведения, присутствие, heartbeat, очередь.
// Громкость сюда НЕ передаётся никогда — она индивидуальна у каждого клиента.
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  getRoom, updateRoomPlayback, updateRoomVideo,
  upsertMember, touchMember, listMembers,
  addChatMessage, listChatMessages,
  queueAdd, queueList, queueRemove, queueClear, queueShift,
  historyUpsert,
} from './db.js';
import crypto from 'node:crypto';

const hashPassword = (p: string) => crypto.createHash('sha256').update(p).digest('hex');

interface WatchSource {
  kind: 'direct' | 'youtube' | 'embed' | 'rutube' | 'stream';
  url: string;            // прямая ссылка на поток либо URL страницы/embed
  title?: string;
  provider?: string;
}

interface StatePayload {
  video: WatchSource | null;
  positionSec: number;
  state: 'playing' | 'paused';
  // Сколько мс назад зафиксирована positionSec (0 на паузе). Клиент досчитывает
  // позицию по СВОИМ часам — так синхронизация не зависит от расхождения
  // системных часов устройств (а они в LAN без NTP расходятся на секунды).
  positionAgeMs: number;
  serverTime: number;
  actor?: string;
}

// socket.id → { roomId, clientId }
const presence = new Map<string, { roomId: string; clientId: string }>();

function canControl(room: { control_mode: string; host_client_id: string | null }, clientId: string) {
  return room.control_mode === 'all' || room.host_client_id === clientId;
}

function snapshot(roomId: string, actor?: string): StatePayload | null {
  const room = getRoom(roomId);
  if (!room) return null;
  // Позицию отдаём «сырой» + её возраст: клиент сам добавит возраст и время
  // в пути по своим часам. Так ошибка — только задержка сети (мс в LAN),
  // а не расхождение системных часов устройств.
  const now = Date.now();
  return {
    video: room.current_video_json ? JSON.parse(room.current_video_json) : null,
    positionSec: room.position_sec,
    state: room.state,
    positionAgeMs: room.state === 'playing' ? now - room.updated_at : 0,
    serverTime: now,
    actor,
  };
}

function broadcastPresence(io: Server, roomId: string) {
  const onlineIds = new Set(
    [...presence.entries()].filter(([, v]) => v.roomId === roomId).map(([, v]) => v.clientId)
  );
  const members = listMembers(roomId).map((m) => ({
    clientId: m.client_id,
    nickname: m.nickname,
    online: onlineIds.has(m.client_id),
  }));
  io.to(roomId).emit('room:presence', { members });
}

// Очередь уходит отдельным событием (не sync:state), чтобы не дёргать плеер.
function broadcastQueue(io: Server, roomId: string) {
  io.to(roomId).emit('room:queue', {
    queue: queueList(roomId).map((q) => ({
      id: q.id,
      video: JSON.parse(q.video_json) as WatchSource,
      addedBy: q.added_by,
      addedAt: q.added_at,
    })),
  });
}

// Запись в историю: видео комнаты (url = ключ), позиция и признак «досмотрено».
function recordHistory(roomId: string, video: WatchSource | null, positionSec: number, finished: boolean) {
  if (!video?.url) return;
  try {
    historyUpsert(roomId, JSON.stringify(video), video.url, positionSec, finished);
  } catch (e) {
    console.warn('[history] не удалось записать:', e);
  }
}

// Защита от дублей «video:ended»: все клиенты финишируют почти одновременно.
const lastEnded = new Map<string, { url: string; ts: number }>();

// --- Трансляция сайта ---
// Хост (десктоп) захватывает окно со страницей и раздаёт видео/звук
// WebRTC-потоком напрямую участникам. Сервер хранит только факт трансляции
// и ретранслирует сигналинг (SDP/ICE) и ввод мыши.
interface StreamInfo {
  active: boolean;
  hostClientId: string | null;
  allowControl: boolean;
  playerOnly: boolean;
}
const roomStreams = new Map<string, StreamInfo>();

function streamInfo(roomId: string): StreamInfo {
  return roomStreams.get(roomId) ?? { active: false, hostClientId: null, allowControl: false, playerOnly: false };
}

function broadcastStream(io: Server, roomId: string) {
  io.to(roomId).emit('stream:state', streamInfo(roomId));
}

// Событие всем сокетам конкретного участника комнаты.
function emitToClient(io: Server, roomId: string, clientId: string, event: string, payload: unknown) {
  for (const [sid, c] of presence.entries()) {
    if (c.roomId === roomId && c.clientId === clientId) io.to(sid).emit(event, payload);
  }
}

// --- Голосовая комната ---
// Серверу голос не нужен: WebRTC-меш идёт напрямую между устройствами (P2P),
// здесь только список участников и ретрансляция SDP/ICE-сигналинга.
interface VoicePeer {
  clientId: string;
  nickname: string;
  muted: boolean;    // выключил микрофон
  deafened: boolean; // не слышит никого
}
// roomId → clientId → состояние
const voiceRooms = new Map<string, Map<string, VoicePeer>>();

function broadcastVoice(io: Server, roomId: string) {
  const peers = [...(voiceRooms.get(roomId)?.values() ?? [])];
  io.to(roomId).emit('voice:peers', { peers });
}

function leaveVoice(io: Server, socketId: string) {
  const ctx = presence.get(socketId);
  if (!ctx) return;
  const roomPeers = voiceRooms.get(ctx.roomId);
  if (roomPeers?.delete(ctx.clientId)) {
    if (roomPeers.size === 0) voiceRooms.delete(ctx.roomId);
    broadcastVoice(io, ctx.roomId);
  }
}

export function setupSync(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true }, // LAN: клиенты подключаются с разных устройств
  });

  io.on('connection', (socket: Socket) => {
    // Вход в комнату → полный снапшот состояния + история чата
    socket.on('room:join', (payload: { roomId: string; clientId: string; nickname: string; password?: string }, ack?: (r: unknown) => void) => {
      const { roomId, clientId, nickname, password } = payload ?? {};
      const room = roomId ? getRoom(roomId) : undefined;
      if (!room) return ack?.({ error: 'Комната не найдена' });
      if (room.password_hash) {
        if (!password) return ack?.({ error: 'NEED_PASSWORD' });
        if (hashPassword(password) !== room.password_hash) return ack?.({ error: 'WRONG_PASSWORD' });
      }
      const nick = (nickname || 'Гость').trim().slice(0, 32) || 'Гость';
      upsertMember(roomId, clientId, nick);
      presence.set(socket.id, { roomId, clientId });
      socket.join(roomId);
      ack?.({
        ok: true,
        snapshot: snapshot(roomId),
        room: { id: room.id, name: room.name, controlMode: room.control_mode, hostClientId: room.host_client_id },
        chat: listChatMessages(roomId).map((m) => ({
          id: m.id, clientId: m.client_id, nickname: m.nickname, text: m.text, ts: m.ts,
        })),
        queue: queueList(roomId).map((q) => ({
          id: q.id, video: JSON.parse(q.video_json) as WatchSource, addedBy: q.added_by, addedAt: q.added_at,
        })),
        stream: streamInfo(roomId),
      });
      broadcastPresence(io, roomId);
    });

    // Чат: сохраняем и рассылаем всем в комнате
    socket.on('chat:message', (p: { text: string }) => {
      const ctx = presence.get(socket.id);
      if (!ctx) return;
      const text = String(p?.text ?? '').trim().slice(0, 500);
      if (!text) return;
      const room = getRoom(ctx.roomId);
      const nick = listMembers(ctx.roomId).find((m) => m.client_id === ctx.clientId)?.nickname ?? 'Гость';
      const msg = addChatMessage(ctx.roomId, ctx.clientId, nick, text);
      touchMember(ctx.roomId, ctx.clientId);
      io.to(ctx.roomId).emit('chat:message', {
        id: msg.id, clientId: msg.client_id, nickname: msg.nickname, text: msg.text, ts: msg.ts,
      });
      void room;
    });

    const guarded = (
      socket: Socket,
      fn: (ctx: { roomId: string; clientId: string }) => void
    ) => {
      const ctx = presence.get(socket.id);
      if (!ctx) return;
      const room = getRoom(ctx.roomId);
      if (!room || !canControl(room, ctx.clientId)) return; // режим «только хост»
      fn(ctx);
    };

    socket.on('sync:play', (p: { positionSec: number }) =>
      guarded(socket, ({ roomId, clientId }) => {
        const pos = Math.max(0, Number(p?.positionSec) || 0);
        updateRoomPlayback(roomId, pos, 'playing');
        touchMember(roomId, clientId);
        io.to(roomId).emit('sync:state', snapshot(roomId, clientId));
      })
    );

    socket.on('sync:pause', (p: { positionSec: number }) =>
      guarded(socket, ({ roomId, clientId }) => {
        const pos = Math.max(0, Number(p?.positionSec) || 0);
        updateRoomPlayback(roomId, pos, 'paused');
        touchMember(roomId, clientId);
        io.to(roomId).emit('sync:state', snapshot(roomId, clientId));
      })
    );

    socket.on('sync:seek', (p: { positionSec: number }) =>
      guarded(socket, ({ roomId, clientId }) => {
        const room = getRoom(roomId)!;
        const pos = Math.max(0, Number(p?.positionSec) || 0);
        updateRoomPlayback(roomId, pos, room.state);
        touchMember(roomId, clientId);
        io.to(roomId).emit('sync:state', snapshot(roomId, clientId));
      })
    );

    socket.on('sync:setVideo', (p: { video: WatchSource | null }) =>
      guarded(socket, ({ roomId, clientId }) => {
        updateRoomVideo(roomId, p?.video ? JSON.stringify(p.video) : null);
        recordHistory(roomId, p?.video ?? null, 0, false);
        touchMember(roomId, clientId);
        io.to(roomId).emit('sync:state', snapshot(roomId, clientId));
      })
    );

    // Пауза — заодно запоминаем позицию в истории (не чаще раза в 5 с на видео).
    const lastHistoryWrite = new Map<string, number>();
    socket.on('sync:pause', (p: { positionSec: number }) =>
      guarded(socket, ({ roomId }) => {
        const room = getRoom(roomId);
        const video = room?.current_video_json ? (JSON.parse(room.current_video_json) as WatchSource) : null;
        if (video?.url) {
          const key = `${roomId}:${video.url}`;
          const now = Date.now();
          if (now - (lastHistoryWrite.get(key) ?? 0) > 5000) {
            lastHistoryWrite.set(key, now);
            recordHistory(roomId, video, Math.max(0, Number(p?.positionSec) || 0), false);
          }
        }
      })
    );

    // Очередь просмотра (только для тех, кто управляет).
    socket.on('queue:add', (p: { video: WatchSource }) =>
      guarded(socket, ({ roomId, clientId }) => {
        const video = p?.video;
        if (!video?.url || !video.kind) return;
        queueAdd(roomId, JSON.stringify(video), clientId);
        touchMember(roomId, clientId);
        broadcastQueue(io, roomId);
      })
    );

    socket.on('queue:remove', (p: { id: number }) =>
      guarded(socket, ({ roomId, clientId }) => {
        queueRemove(roomId, Number(p?.id) || 0);
        touchMember(roomId, clientId);
        broadcastQueue(io, roomId);
      })
    );

    socket.on('queue:clear', () =>
      guarded(socket, ({ roomId, clientId }) => {
        queueClear(roomId);
        touchMember(roomId, clientId);
        broadcastQueue(io, roomId);
      })
    );

    // Видео закончилось: фиксируем в истории и, если есть очередь, включаем
    // следующее. Событие приходит от всех клиентов разом — берём только первое.
    socket.on('video:ended', (p: { positionSec?: number }) => {
      const ctx = presence.get(socket.id);
      if (!ctx) return;
      const room = getRoom(ctx.roomId);
      if (!room?.current_video_json) return;
      const video = JSON.parse(room.current_video_json) as WatchSource;
      const prev = lastEnded.get(ctx.roomId);
      if (prev && prev.url === video.url && Date.now() - prev.ts < 15000) return;
      lastEnded.set(ctx.roomId, { url: video.url, ts: Date.now() });

      recordHistory(ctx.roomId, video, Math.max(0, Number(p?.positionSec) || room.position_sec), true);

      const next = queueShift(ctx.roomId);
      if (next) {
        const nextVideo = JSON.parse(next.video_json) as WatchSource;
        updateRoomVideo(ctx.roomId, next.video_json);
        recordHistory(ctx.roomId, nextVideo, 0, false);
        // Автостарт следующей серии: состояние playing с нулевой позиции.
        updateRoomPlayback(ctx.roomId, 0, 'playing');
        io.to(ctx.roomId).emit('sync:state', snapshot(ctx.roomId, ctx.clientId));
        broadcastQueue(io, ctx.roomId);
      } else {
        updateRoomPlayback(ctx.roomId, room.position_sec, 'paused');
        io.to(ctx.roomId).emit('sync:state', snapshot(ctx.roomId, ctx.clientId));
      }
    });

    // Heartbeat: уточнение позиции и запись в БД, чтобы «продолжить через месяц».
    socket.on('sync:heartbeat', (p: { positionSec: number; state: 'playing' | 'paused' }) => {
      const ctx = presence.get(socket.id);
      if (!ctx) return;
      const room = getRoom(ctx.roomId);
      if (!room) return;
      // Принимаем heartbeat только если клиентское состояние совпадает с серверным,
      // чтобы отставшие клиенты не перетирали актуальную позицию.
      if (room.state === p.state) {
        const pos = Math.max(0, Number(p.positionSec) || 0);
        if (room.state === 'playing') {
          // Отставший клиент (буферизация, слабая сеть) не должен тянуть
          // общую позицию назад — его heartbeat игнорируем.
          const serverPos = room.position_sec + (Date.now() - room.updated_at) / 1000;
          if (pos < serverPos - 3) {
            touchMember(ctx.roomId, ctx.clientId);
            return;
          }
        }
        updateRoomPlayback(ctx.roomId, pos, p.state);
      }
      touchMember(ctx.roomId, ctx.clientId);
    });

    // --- голосовая комната (только присутствие + сигналинг; медиа — P2P) ---
    socket.on('voice:join', () => {
      const ctx = presence.get(socket.id);
      if (!ctx) return;
      const nick = listMembers(ctx.roomId).find((m) => m.client_id === ctx.clientId)?.nickname ?? 'Гость';
      let roomPeers = voiceRooms.get(ctx.roomId);
      if (!roomPeers) voiceRooms.set(ctx.roomId, (roomPeers = new Map()));
      roomPeers.set(ctx.clientId, { clientId: ctx.clientId, nickname: nick, muted: false, deafened: false });
      broadcastVoice(io, ctx.roomId);
    });

    socket.on('voice:leave', () => leaveVoice(io, socket.id));

    socket.on('voice:state', (p: { muted?: boolean; deafened?: boolean }) => {
      const ctx = presence.get(socket.id);
      if (!ctx) return;
      const peer = voiceRooms.get(ctx.roomId)?.get(ctx.clientId);
      if (!peer) return;
      if (typeof p?.muted === 'boolean') peer.muted = p.muted;
      if (typeof p?.deafened === 'boolean') peer.deafened = p.deafened;
      broadcastVoice(io, ctx.roomId);
    });

    // SDP/ICE конкретному участнику комнаты.
    socket.on('voice:signal', (p: { to?: string; data?: unknown }) => {
      const ctx = presence.get(socket.id);
      if (!ctx || !p?.to || p.data == null) return;
      for (const [sid, c] of presence.entries()) {
        if (c.roomId === ctx.roomId && c.clientId === p.to) {
          io.to(sid).emit('voice:signal', { from: ctx.clientId, data: p.data });
        }
      }
    });

    // --- трансляция сайта (медиа — P2P; тут состояние, сигналинг, ввод) ---
    socket.on('stream:start', (p: { url?: string; title?: string; playerOnly?: boolean }) =>
      guarded(socket, ({ roomId, clientId }) => {
        const url = String(p?.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) return;
        roomStreams.set(roomId, { active: true, hostClientId: clientId, allowControl: false, playerOnly: !!p?.playerOnly });
        const video: WatchSource = { kind: 'stream', url, title: String(p?.title ?? url).slice(0, 200), provider: 'stream' };
        updateRoomVideo(roomId, JSON.stringify(video));
        recordHistory(roomId, video, 0, false);
        touchMember(roomId, clientId);
        io.to(roomId).emit('sync:state', snapshot(roomId, clientId));
        broadcastStream(io, roomId);
      })
    );

    socket.on('stream:control', (p: { allow?: boolean }) =>
      guarded(socket, ({ roomId, clientId }) => {
        const s = roomStreams.get(roomId);
        if (!s || s.hostClientId !== clientId) return; // управляет только ведущий
        s.allowControl = !!p?.allow;
        broadcastStream(io, roomId);
      })
    );

    socket.on('stream:stop', () =>
      guarded(socket, ({ roomId, clientId }) => {
        const s = roomStreams.get(roomId);
        if (!s || s.hostClientId !== clientId) return;
        roomStreams.delete(roomId);
        updateRoomVideo(roomId, null);
        io.to(roomId).emit('sync:state', snapshot(roomId, clientId));
        broadcastStream(io, roomId);
      })
    );

    // Зритель просит поток → передаём ведущему, тот создаёт P2P-соединение.
    socket.on('stream:watch', () => {
      const ctx = presence.get(socket.id);
      if (!ctx) return;
      const s = roomStreams.get(ctx.roomId);
      if (!s?.active || !s.hostClientId) return;
      emitToClient(io, ctx.roomId, s.hostClientId, 'stream:watch', { from: ctx.clientId });
    });

    // SDP/ICE — только в паре зритель ↔ ведущий.
    socket.on('stream:signal', (p: { to?: string; data?: unknown }) => {
      const ctx = presence.get(socket.id);
      if (!ctx || !p?.to || p.data == null) return;
      const s = roomStreams.get(ctx.roomId);
      if (!s?.active || !s.hostClientId) return;
      const isHost = ctx.clientId === s.hostClientId;
      if (!isHost && p.to !== s.hostClientId) return;
      emitToClient(io, ctx.roomId, p.to, 'stream:signal', { from: ctx.clientId, data: p.data });
    });

    // Ввод мыши от зрителей — только когда ведущий разрешил управление.
    socket.on('stream:input', (p: Record<string, unknown>) => {
      const ctx = presence.get(socket.id);
      if (!ctx) return;
      const s = roomStreams.get(ctx.roomId);
      if (!s?.active || !s.allowControl || !s.hostClientId) return;
      emitToClient(io, ctx.roomId, s.hostClientId, 'stream:input', { from: ctx.clientId, ...p });
    });

    // Индикатор загрузки страницы трансляции: ведущий → всем остальным в комнате.
    socket.on('stream:loading', (p: { loading?: boolean; error?: string }) =>
      guarded(socket, ({ roomId, clientId }) => {
        const s = roomStreams.get(roomId);
        if (!s?.active || s.hostClientId !== clientId) return;
        socket.to(roomId).emit('stream:loading', {
          loading: !!p?.loading,
          error: typeof p?.error === 'string' ? p.error.slice(0, 200) : undefined,
        });
      })
    );

    socket.on('disconnect', () => {
      leaveVoice(io, socket.id);
      const ctx = presence.get(socket.id);
      if (ctx) {
        presence.delete(socket.id);
        // Ведущий трансляции отключился (все его сокеты) — трансляция кончилась.
        const s = roomStreams.get(ctx.roomId);
        if (s?.hostClientId === ctx.clientId) {
          const stillHere = [...presence.values()].some(
            (c) => c.roomId === ctx.roomId && c.clientId === ctx.clientId
          );
          if (!stillHere) {
            roomStreams.delete(ctx.roomId);
            broadcastStream(io, ctx.roomId);
          }
        }
        broadcastPresence(io, ctx.roomId);
      }
    });
  });

  return io;
}
