// Область просмотра трансляции сайта: удалённый WebRTC-поток вместо плеера.
// Если ведущий разрешил управление — клики и колесо уходят на его окно.
import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { StreamViewer } from '@/lib/streamViewer';

interface StreamViewProps {
  getSocket: () => Socket | null;
  connected: boolean;
  hostClientId: string;
  allowControl: boolean;
  // Ведущий сообщает, что страница трансляции ещё грузится — показываем спиннер
  // вместо белого экрана.
  pageLoading?: boolean;
}

export function StreamView({ getSocket, connected, hostClientId, allowControl, pageLoading }: StreamViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<StreamViewer | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!connected) return;
    const socket = getSocket();
    if (!socket) return;
    const viewer = new StreamViewer(socket, hostClientId);
    viewer.onStream = (s) => {
      setLive(!!s);
      if (videoRef.current) videoRef.current.srcObject = s;
    };
    viewer.onClosed = () => setLive(false);
    viewerRef.current = viewer;
    viewer.watch();
    return () => {
      viewer.close();
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, hostClientId]);

  const rel = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  };

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black select-none">
      <video ref={videoRef} autoPlay playsInline className="absolute inset-0 h-full w-full" />
      {!live && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
          Подключаемся к трансляции…
        </div>
      )}
      {live && pageLoading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/70 text-sm text-zinc-300">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-amber-400" />
          Загружаем страницу…
        </div>
      )}
      {allowControl && live && (
        <div
          className="absolute inset-0 cursor-pointer"
          title="Управление разрешено ведущим: клик — как по странице, колесо — прокрутка"
          onClick={(e) => viewerRef.current?.sendInput({ kind: 'click', ...rel(e) })}
          onWheel={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            viewerRef.current?.sendInput({
              kind: 'wheel',
              x: (e.clientX - rect.left) / rect.width,
              y: (e.clientY - rect.top) / rect.height,
              deltaY: e.deltaY,
            });
          }}
        />
      )}
      {allowControl && (
        <span className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-amber-300">
          Управление включено
        </span>
      )}
    </div>
  );
}
