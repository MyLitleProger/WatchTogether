// Кастомный плеер «в стиле YouTube»: свои контролы, горячие клавиши,
// HTML5 <video> для прямых ссылок и YouTube IFrame API с оверлеем для YouTube.
// Громкость/mute — строго локальные (localStorage), в синхронизацию не уходят.
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import Hls from 'hls.js';
import { MediaPlayer, type MediaPlayerClass } from 'dashjs';
import { type WatchSource, withProxyToken } from '@/lib/api';

export interface PlayerHandle {
  getPosition: () => { positionSec: number; state: 'playing' | 'paused' };
  play: () => void;
  pause: () => void;
  seekTo: (sec: number) => void;
  currentTime: () => number;
  // Локальная скорость воспроизведения (для плавной подгонки под комнату).
  setRate: (rate: number) => void;
}

interface PlayerProps {
  video: WatchSource | null;
  canControl: boolean;
  onUserPlay: (pos: number) => void;
  onUserPause: (pos: number) => void;
  onUserSeek: (pos: number) => void;
  // Видео доиграло до конца — комната может включить следующее из очереди.
  onUserEnded?: (pos: number) => void;
}

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve();
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    });
  }
  return ytApiPromise;
}

export function extractYouTubeId(url: string): string | null {
  const m =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/(?:embed|shorts)\/([\w-]{11})/);
  return m ? m[1] : null;
}

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

const VOLUME_KEY = 'wt.volume';

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(
  { video, canControl, onUserPlay, onUserPause, onUserSeek, onUserEnded },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytMountRef = useRef<HTMLDivElement>(null);
  const ytPlayerRef = useRef<any>(null);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return isFinite(v) && v >= 0 && v <= 1 ? v : 0.8;
  });
  const [muted, setMuted] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [ytReady, setYtReady] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isYouTube = video?.kind === 'youtube' || (!!video && extractYouTubeId(video.url) !== null && video.kind !== 'direct');

  // ---- единый доступ к «движку» ----
  const engine = {
    play: () => {
      if (isYouTube) ytPlayerRef.current?.playVideo();
      else videoRef.current?.play();
    },
    pause: () => {
      if (isYouTube) ytPlayerRef.current?.pauseVideo();
      else videoRef.current?.pause();
    },
    seekTo: (sec: number) => {
      if (isYouTube) ytPlayerRef.current?.seekTo(sec, true);
      else if (videoRef.current) videoRef.current.currentTime = sec;
    },
    currentTime: (): number => {
      if (isYouTube) return ytPlayerRef.current?.getCurrentTime?.() ?? 0;
      return videoRef.current?.currentTime ?? 0;
    },
    duration: (): number => {
      if (isYouTube) return ytPlayerRef.current?.getDuration?.() ?? 0;
      return videoRef.current?.duration ?? 0;
    },
    setVolume: (v: number, m: boolean) => {
      if (isYouTube) {
        ytPlayerRef.current?.setVolume?.(Math.round(v * 100));
        if (m) ytPlayerRef.current?.mute?.(); else ytPlayerRef.current?.unMute?.();
      } else if (videoRef.current) {
        videoRef.current.volume = v;
        videoRef.current.muted = m;
      }
    },
    isPlaying: (): boolean => {
      if (isYouTube) return ytPlayerRef.current?.getPlayerState?.() === 1;
      return !!videoRef.current && !videoRef.current.paused;
    },
    setRate: (r: number) => {
      if (isYouTube) {
        // YouTube принимает только ставки из своего списка — ближайшая сама.
        ytPlayerRef.current?.setPlaybackRate?.(r);
      } else if (videoRef.current) {
        videoRef.current.playbackRate = r;
      }
    },
  };

  useImperativeHandle(ref, () => ({
    getPosition: () => ({
      positionSec: engine.currentTime(),
      state: engine.isPlaying() ? 'playing' : 'paused',
    }),
    play: () => engine.play(),
    pause: () => engine.pause(),
    seekTo: (sec: number) => engine.seekTo(sec),
    currentTime: () => engine.currentTime(),
    setRate: (r: number) => engine.setRate(r),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [isYouTube]);

  // ---- YouTube-плеер ----
  useEffect(() => {
    if (!isYouTube || !video) return;
    const videoId = extractYouTubeId(video.url);
    if (!videoId || !ytMountRef.current) return;
    let cancelled = false;
    setYtReady(false);

    loadYouTubeApi().then(() => {
      if (cancelled || !ytMountRef.current) return;
      ytPlayerRef.current?.destroy?.();
      ytPlayerRef.current = new window.YT.Player(ytMountRef.current, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3 },
        events: {
          onReady: () => {
            if (cancelled) return;
            setYtReady(true);
            engine.setVolume(volume, muted);
          },
          onStateChange: (e: any) => {
            if (cancelled) return;
            setPlaying(e.data === 1);
            if (e.data === 0) { // YT ENDED
              const pos = ytPlayerRef.current?.getDuration?.() ?? 0;
              if (onUserEnded) onUserEnded(pos);
              else onUserPause(pos);
            }
          },
        },
      });
    });
    return () => {
      cancelled = true;
      ytPlayerRef.current?.destroy?.();
      ytPlayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isYouTube, video?.url]);

  // ---- прямое видео (HLS через hls.js, DASH через dash.js) ----
  const isHls = !!video && !isYouTube && /\.m3u8/i.test(video.url);
  const isDash = !!video && !isYouTube && /\.mpd(\?|%3F|#|$)/i.test(video.url);
  // Ссылки на наш медиа-прокси получают токен доступа (нужен гостям через туннель).
  const playUrl = video ? withProxyToken(video.url) : '';
  useEffect(() => {
    const v = videoRef.current;
    if (!v || isYouTube || !video) return;

    // HLS: hls.js там, где нет нативной поддержки (Chrome/Electron).
    let hls: Hls | null = null;
    let dash: MediaPlayerClass | null = null;
    if (isHls) {
      if (Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30, enableWorker: true });
        hls.loadSource(playUrl);
        hls.attachMedia(v);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = playUrl; // Safari — нативно
      }
    } else if (isDash) {
      dash = MediaPlayer().create();
      dash.initialize(v, playUrl, false);
    }

    engine.setVolume(volume, muted);
    const onTime = () => setTime(v.currentTime);
    const onDur = () => setDuration(v.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    // Конец видео = пауза для всех: рассылаем синхронно.
    // Конец видео: сообщаем отдельно (очередь/история), паузу шлём только без обработчика.
    const onEnded = () => {
      setPlaying(false);
      const pos = v.duration || v.currentTime;
      if (onUserEnded) onUserEnded(pos);
      else onUserPause(pos);
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('durationchange', onDur);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('durationchange', onDur);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      hls?.destroy();
      dash?.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isYouTube, video?.url, playUrl]);

  // таймер для YouTube (timeupdate у iframe нет)
  useEffect(() => {
    if (!isYouTube) return;
    const t = setInterval(() => {
      setTime(engine.currentTime());
      setDuration(engine.duration());
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isYouTube, ytReady]);

  // громкость — локально
  useEffect(() => {
    localStorage.setItem(VOLUME_KEY, String(volume));
    engine.setVolume(volume, muted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, muted]);

  // ---- действия пользователя → локально + наружу (для синка) ----
  const userToggle = useCallback(() => {
    if (!canControl) return;
    if (engine.isPlaying()) {
      engine.pause();
      onUserPause(engine.currentTime());
    } else {
      engine.play();
      onUserPlay(engine.currentTime());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canControl, onUserPlay, onUserPause, isYouTube]);

  const userSeekBy = useCallback((delta: number) => {
    if (!canControl) return;
    const t = Math.max(0, Math.min(engine.duration() || Infinity, engine.currentTime() + delta));
    engine.seekTo(t);
    onUserSeek(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canControl, onUserSeek, isYouTube]);

  const userSeekTo = useCallback((t: number) => {
    if (!canControl) return;
    engine.seekTo(t);
    onUserSeek(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canControl, onUserSeek, isYouTube]);

  // ---- горячие клавиши (как на YouTube) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      const dur = engine.duration();
      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
        case 'л': // русская раскладка
          e.preventDefault();
          userToggle();
          break;
        case 'arrowleft':
          e.preventDefault();
          userSeekBy(-5);
          break;
        case 'arrowright':
          e.preventDefault();
          userSeekBy(5);
          break;
        case 'j':
        case 'о':
          userSeekBy(-10);
          break;
        case 'l':
        case 'д':
          userSeekBy(10);
          break;
        case 'arrowup':
          e.preventDefault();
          setVolume((v) => Math.min(1, v + 0.05));
          setMuted(false);
          break;
        case 'arrowdown':
          e.preventDefault();
          setVolume((v) => Math.max(0, v - 0.05));
          break;
        case 'm':
        case 'ь':
          setMuted((m) => !m);
          break;
        case 'f':
        case 'а': {
          e.preventDefault();
          const el = containerRef.current;
          if (!el) break;
          if (document.fullscreenElement) document.exitFullscreen();
          else el.requestFullscreen().catch(() => {});
          break;
        }
        default:
          if (/^[0-9]$/.test(e.key) && dur > 0) {
            userSeekTo((Number(e.key) / 10) * dur);
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userToggle, userSeekBy, userSeekTo, isYouTube]);

  // автоскрытие контролов при воспроизведении
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (engine.isPlaying()) setControlsVisible(false);
    }, 2500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isYouTube]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const progress = duration > 0 ? (time / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className="group relative aspect-video w-full overflow-hidden rounded-xl bg-black select-none"
      onMouseMove={pokeControls}
      onMouseLeave={() => playing && setControlsVisible(false)}
    >
      {video ? (
        isYouTube ? (
          <>
            <div ref={ytMountRef} className="pointer-events-none absolute inset-0 h-full w-full" />
            {/* кликабельный слой поверх iframe — наш тоггл play/pause */}
            <button
              type="button"
              aria-label={playing ? 'Пауза' : 'Смотреть'}
              className="absolute inset-0 h-full w-full cursor-pointer"
              onClick={userToggle}
              onDoubleClick={() => {
                const el = containerRef.current;
                if (!el) return;
                if (document.fullscreenElement) document.exitFullscreen();
                else el.requestFullscreen().catch(() => {});
              }}
            />
            {!ytReady && (
              <div className="absolute inset-0 flex items-center justify-center text-zinc-400">
                Загрузка YouTube-плеера…
              </div>
            )}
          </>
        ) : (
          <video
            ref={videoRef}
            // HLS/DASH отдают hls.js/dash.js через MediaSource — src не ставим, иначе двойная загрузка.
            src={(isHls && Hls.isSupported()) || isDash ? undefined : playUrl}
            className="absolute inset-0 h-full w-full"
            onClick={userToggle}
            playsInline
          />
        )
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-500">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <rect x="2" y="4" width="20" height="16" rx="3" />
            <path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none" />
          </svg>
          <p>Видео ещё не выбрано — найдите что-нибудь в поиске или вставьте ссылку</p>
        </div>
      )}

      {/* контролы */}
      {video && (
        <div
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-8 transition-opacity duration-200 ${
            controlsVisible || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* прогресс */}
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            disabled={!canControl}
            onChange={(e) => userSeekTo(Number(e.target.value))}
            aria-label="Позиция воспроизведения"
            className="wt-progress mb-1 w-full cursor-pointer"
            style={{ ['--p' as string]: `${progress}%` }}
          />
          <div className="flex items-center gap-3 text-sm text-zinc-200">
            <button
              type="button"
              onClick={userToggle}
              disabled={!canControl}
              aria-label={playing ? 'Пауза (K)' : 'Смотреть (K)'}
              className="cursor-pointer rounded p-1 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {playing ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>
              )}
            </button>

            {/* громкость — локальная */}
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              aria-label={muted ? 'Включить звук (M)' : 'Без звука (M)'}
              className="cursor-pointer rounded p-1 transition-colors hover:text-white"
            >
              {muted || volume === 0 ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 010 7"/><path d="M18.5 5.5a9 9 0 010 13"/></svg>
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }}
              aria-label="Громкость (только у вас)"
              title="Громкость — только у вас"
              className="wt-progress w-24 cursor-pointer"
              style={{ ['--p' as string]: `${(muted ? 0 : volume) * 100}%` }}
            />

            <span className="tabular-nums text-zinc-300">
              {fmt(time)} / {fmt(duration)}
            </span>

            <span className="ml-auto hidden text-xs text-zinc-400 md:block">
              K — пауза · J/L — ±10 с · M — звук · F — весь экран
            </span>

            <button
              type="button"
              onClick={() => {
                const el = containerRef.current;
                if (!el) return;
                if (document.fullscreenElement) document.exitFullscreen();
                else el.requestFullscreen().catch(() => {});
              }}
              aria-label="Во весь экран (F)"
              className="cursor-pointer rounded p-1 transition-colors hover:text-white"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
