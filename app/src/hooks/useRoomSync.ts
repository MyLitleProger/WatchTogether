// Хук синхронизации комнаты: join, приём sync:state, отправка play/pause/seek, heartbeat, очередь.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { connectSocket, type ChatMessage, type MemberPresence, type QueueItem, type StreamInfo, type SyncState, type WatchSource, setProxyToken, setRoomToken } from '@/lib/api';
import { getClientId, getClientSecret } from '@/lib/identity';

export interface RoomMeta {
  id: string;
  name: string;
  controlMode: 'all' | 'host';
  hostClientId: string | null;
  hasPassword?: boolean;
  hidden?: boolean;
}

const HEARTBEAT_MS = 5000;

export function useRoomSync(roomId: string, nickname: string, password?: string) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomMeta | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [members, setMembers] = useState<MemberPresence[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [streamInfo, setStreamInfo] = useState<StreamInfo | null>(null);
  const socketRef = useRef<Socket | null>(null);
  // Колбэк, который Room навешивает, чтобы применить состояние к плееру.
  const applyRef = useRef<(s: SyncState) => void>(() => {});

  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit(
        'room:join',
        { roomId, clientId: getClientId(), clientSecret: getClientSecret(), nickname, password },
        (res: { error?: string; ok?: boolean; snapshot?: SyncState; room?: RoomMeta; chat?: ChatMessage[]; queue?: QueueItem[]; stream?: StreamInfo; proxyToken?: string; roomToken?: string }) => {
          if (res.error || !res.ok) {
            setError(res.error === 'CLIENT_MISMATCH'
              ? 'Сервер не узнал это устройство (его идентификатор уже занят другим). Очистите данные сайта или откройте комнату в другом браузере.'
              : res.error ?? 'Не удалось войти в комнату');
            return;
          }
          setProxyToken(res.proxyToken);
          setRoomToken(roomId, res.roomToken);
          setConnected(true);
          setError(null);
          if (res.room) setRoom(res.room);
          if (res.chat) setMessages(res.chat);
          if (res.queue) setQueue(res.queue);
          if (res.stream) setStreamInfo(res.stream);
          if (res.snapshot) {
            setSyncState(res.snapshot);
            applyRef.current(res.snapshot);
          }
        }
      );
    });

    socket.on('sync:state', (s: SyncState) => {
      setSyncState(s);
      applyRef.current(s);
    });

    socket.on('chat:message', (m: ChatMessage) => {
      setMessages((prev) => [...prev.slice(-199), m]);
    });

    socket.on('room:presence', (p: { members: MemberPresence[] }) => setMembers(p.members));
    // Создатель поменял название/пароль/скрытость — обновляем у всех сразу.
    socket.on('room:meta', (m: { name: string; hasPassword: boolean; hidden: boolean }) =>
      setRoom((prev) => (prev ? { ...prev, ...m } : prev)));
    socket.on('room:deleted', () => setError('Комнату удалил её создатель'));
    socket.on('room:queue', (p: { queue: QueueItem[] }) => setQueue(p.queue));
    socket.on('stream:state', (s: StreamInfo) => setStreamInfo(s));
    socket.on('disconnect', () => setConnected(false));

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, nickname, password]);

  // Heartbeat: плеер сообщает текущую позицию; сервер пишет её в БД.
  const heartbeat = useCallback((positionSec: number, state: 'playing' | 'paused') => {
    socketRef.current?.emit('sync:heartbeat', { positionSec, state });
  }, []);

  // Тикающая отправка heartbeat каждые 5 c — позицию берём из getPosition, который задаёт Room.
  const getPositionRef = useRef<() => { positionSec: number; state: 'playing' | 'paused' }>(() => ({
    positionSec: 0,
    state: 'paused',
  }));
  useEffect(() => {
    const t = setInterval(() => {
      if (!connected) return;
      const p = getPositionRef.current();
      heartbeat(p.positionSec, p.state);
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [connected, heartbeat]);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  // Голосовой менеджер навешивается на тот же сокет (комната уже join'нута).
  const getSocket = useCallback(() => socketRef.current, []);

  return {
    connected,
    error,
    room,
    syncState,
    members,
    messages,
    isHost: room?.hostClientId === getClientId(),
    canControl: room ? room.controlMode === 'all' || room.hostClientId === getClientId() : false,
    setApply: (fn: (s: SyncState) => void) => { applyRef.current = fn; },
    getSocket,
    setGetPosition: (fn: () => { positionSec: number; state: 'playing' | 'paused' }) => {
      getPositionRef.current = fn;
    },
    play: (positionSec: number) => emit('sync:play', { positionSec }),
    pause: (positionSec: number) => emit('sync:pause', { positionSec }),
    seek: (positionSec: number) => emit('sync:seek', { positionSec }),
    setVideo: (video: WatchSource | null) => emit('sync:setVideo', { video }),
    sendChat: (text: string) => emit('chat:message', { text }),
    queue,
    streamInfo,
    queueAdd: (video: WatchSource) => emit('queue:add', { video }),
    queueRemove: (id: number) => emit('queue:remove', { id }),
    queueClear: () => emit('queue:clear'),
    videoEnded: (positionSec: number) => emit('video:ended', { positionSec }),
  };
}
