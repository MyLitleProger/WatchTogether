// Голосовая комната под чатом: вход/выход, мьют микрофона, «не слышать никого».
// Медиа — P2P между участниками (WebRTC), сервер видит только список и иконки.
import { useEffect, useRef, useState } from 'react';
import { VoiceManager, type VoicePeerInfo } from '@/lib/voice';
import { getClientId } from '@/lib/identity';
import type { Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';

interface VoicePanelProps {
  // Сокет уже подключённой к комнате синхронизации (null, пока нет связи).
  getSocket: () => Socket | null;
  connected: boolean;
}

const MicIcon = ({ off }: { off?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v1a7 7 0 0014 0v-1M12 18v4" />
    {off && <line x1="2" y1="2" x2="22" y2="22" />}
  </svg>
);

const DeafenIcon = ({ off }: { off?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M3 14v-3a9 9 0 0118 0v7" />
    <path d="M3 14h4v7H3zM17 14h4v7h-4z" />
    {off && <line x1="2" y1="2" x2="22" y2="22" />}
  </svg>
);

export function VoicePanel({ getSocket, connected }: VoicePanelProps) {
  const mgrRef = useRef<VoiceManager | null>(null);
  const [peers, setPeers] = useState<VoicePeerInfo[]>([]);
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Кто говорит прямо сейчас (по уровню звука) — подсветка аватаров.
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());

  // Менеджер живёт, пока жива комната; при размонтировании — выходим из голоса.
  useEffect(() => {
    if (!connected) return;
    const socket = getSocket();
    if (!socket) return;
    const mgr = new VoiceManager(socket, getClientId());
    mgr.onPeers = setPeers;
    mgr.onSpeaking = (ids) => setSpeaking(new Set(ids));
    mgrRef.current = mgr;
    return () => {
      mgr.dispose();
      mgrRef.current = null;
      setJoined(false);
      setPeers([]);
      setSpeaking(new Set());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const join = async () => {
    const mgr = mgrRef.current;
    if (!mgr) return;
    setBusy(true);
    setError(null);
    try {
      await mgr.join();
      setJoined(true);
    } catch (e) {
      if (e instanceof Error && e.message === 'insecure-context') {
        setError('Браузер блокирует микрофон по http-ссылке. Голос работает в приложении WatchTogether — установите его на этом устройстве.');
      } else {
        setError('Нет доступа к микрофону — проверьте разрешение в системе/браузере.');
      }
    } finally {
      setBusy(false);
    }
  };

  const leave = () => {
    mgrRef.current?.leave();
    setJoined(false);
    setMuted(false);
    setDeafened(false);
    setSpeaking(new Set());
  };

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    mgrRef.current?.setMuted(m);
  };

  const toggleDeafen = () => {
    const d = !deafened;
    setDeafened(d);
    mgrRef.current?.setDeafened(d);
    // «Не слышать никого» в Discord заодно глушит и микрофон — у нас тоже.
    if (d && !muted) { setMuted(true); mgrRef.current?.setMuted(true); }
  };

  const selfId = getClientId();

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">Голосовая комната</h2>
        {joined && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            на связи
          </span>
        )}
      </div>

      {!joined ? (
        <div className="mt-2">
          <Button size="sm" variant="outline" onClick={join} disabled={busy || !connected} className="w-full">
            {busy ? 'Подключаем микрофон…' : 'Подключиться к голосу'}
          </Button>
          {error && <p className="mt-2 text-xs text-amber-400/90">{error}</p>}
        </div>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {peers.map((p) => {
              const isSpeaking = speaking.has(p.clientId) && !p.muted;
              return (
              <li
                key={p.clientId}
                className={`flex items-center gap-2 text-sm transition-opacity duration-200 ${isSpeaking ? 'opacity-100' : 'opacity-50'}`}
              >
                <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold transition-shadow ${
                  p.clientId === selfId ? 'bg-amber-500/20 text-amber-300' : 'bg-zinc-700/60 text-zinc-300'
                } ${isSpeaking ? 'ring-2 ring-emerald-400' : ''}`}>
                  {p.nickname.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-200">
                  {p.nickname}{p.clientId === selfId ? ' (вы)' : ''}
                </span>
                {p.muted && <span className="text-red-400" title="Микрофон выключен"><MicIcon off /></span>}
                {p.deafened && <span className="text-red-400" title="Не слышит никого"><DeafenIcon off /></span>}
              </li>
              );
            })}
          </ul>

          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <Button size="sm" variant={muted ? 'destructive' : 'outline'} onClick={toggleMute}
              title={muted ? 'Включить микрофон' : 'Выключить микрофон'} aria-label="Микрофон">
              <MicIcon off={muted} />
            </Button>
            <Button size="sm" variant={deafened ? 'destructive' : 'outline'} onClick={toggleDeafen}
              title={deafened ? 'Слышать всех' : 'Не слышать никого'} aria-label="Звук собеседников">
              <DeafenIcon off={deafened} />
            </Button>
            <Button size="sm" variant="ghost" onClick={leave} className="text-zinc-400 hover:text-red-400"
              title="Покинуть голосовую комнату" aria-label="Отключиться">
              ✕
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
