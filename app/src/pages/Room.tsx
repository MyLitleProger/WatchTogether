// Комната: плеер + синхронизация + участники + выбор видео (поиск или прямая ссылка).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { Player, type PlayerHandle, extractYouTubeId } from '@/components/Player';
import { SearchPanel } from '@/components/SearchPanel';
import { LibraryPanel } from '@/components/LibraryPanel';
import { ProxyPicker } from '@/components/ProxyPicker';
import { RoomSettingsDialog } from '@/components/RoomSettingsDialog';
import { Chat } from '@/components/Chat';
import { VoicePanel } from '@/components/VoicePanel';
import { StreamView } from '@/components/StreamView';
import { StreamHost } from '@/lib/streamHost';
import { useRoomSync } from '@/hooks/useRoomSync';
import { getClientId, getNickname } from '@/lib/identity';
import { api, type EpisodeInfo, type HistoryEntry, type RutubeSeasonPack, type SearchResult, type SyncState, type WatchSource, proxiedStream, isRutubeUrl, librarySource, type LibraryFile } from '@/lib/api';
import { getDesktop, type SniffResult } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const DRIFT_TOLERANCE = 1.5; // секунд — больше → плавный seek к авторитетной позиции
const HARD_DRIFT = 6;        // секунд — больше → жёсткий seek (подгонка скоростью уже не догонит)
const RATE_DRIFT = 0.75;     // секунд — больше → слегка меняем скорость, чтобы догнать без рывков

// Шаблон названий сериалов на Rutube: «Извне 1 сезон 2 серия …».
const SERIAL_RE = /^(.+?)[\s–—-]+(\d{1,2})\s*сезон\s+(\d{1,3})\s*серия/i;
const parseSerialTitle = (title?: string) => {
  const m = title?.match(SERIAL_RE);
  return m ? { base: m[1].trim(), season: Number(m[2]), episode: Number(m[3]) } : null;
};

const fmtPos = (sec: number) => {
  const m = Math.floor(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
    : `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
};

// Перехваченный поток: HLS/mp4 гоняем через серверный прокси (одинаково работает
// у всех участников LAN, не бьётся о CORS и регион), DASH — напрямую с CDN.
function playableSniffedUrl(r: SniffResult): string {
  const u = r.streamUrl ?? '';
  if (r.format === 'hls' || r.format === 'mp4') {
    let p = `/api/proxy/stream?url=${encodeURIComponent(u)}`;
    if (r.referer) p += `&referer=${encodeURIComponent(r.referer)}`;
    return p;
  }
  return u;
}

export default function Room() {
  const { roomId = '' } = useParams();
  const navigate = useNavigate();
  const [nickname] = useState(getNickname());
  const playerRef = useRef<PlayerHandle>(null);
  const [directUrl, setDirectUrl] = useState('');
  const [video, setVideo] = useState<WatchSource | null>(null);
  const [copied, setCopied] = useState(false);
  // Несколько сетевых адаптеров (LAN + туннели/виртуальные) — показываем все
  // варианты ссылки, автовыбор угадать адаптер не может.
  const [inviteLinks, setInviteLinks] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [episodes, setEpisodes] = useState<EpisodeInfo[] | null>(null);
  const [episodesFor, setEpisodesFor] = useState('');
  const [episodesProvider, setEpisodesProvider] = useState<'lostfilm' | 'lordserial'>('lostfilm');
  const [streamPageUrl, setStreamPageUrl] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const pendingEpisode = useRef<EpisodeInfo | null>(null);
  const [episodeError, setEpisodeError] = useState<string | null>(null);
  const [streamLoading, setStreamLoading] = useState(false);
  // Rutube-резолв: в комнате хранится стабильная ссылка на ролик, а играет
  // свежий поток (m3u8 подписан и протухает — поэтому резолвим при включении).
  const [resolvedVideo, setResolvedVideo] = useState<WatchSource | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // Очередь приходит из sync; тут — история, сезон Rutube и ввод ссылки в очередь.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [seasonPack, setSeasonPack] = useState<RutubeSeasonPack | null>(null);
  const [seasonLoading, setSeasonLoading] = useState(false);
  const [queueUrl, setQueueUrl] = useState('');
  const [queueMsg, setQueueMsg] = useState<string | null>(null);
  // Вкладки под плеером: поиск / серии / очередь / история / трансляция.
  const [tab, setTab] = useState<'search' | 'library' | 'episodes' | 'queue' | 'history' | 'stream'>('search');
  // Трансляция сайта: объект ведущего живёт здесь (только у того, кто ведёт).
  const streamHostRef = useRef<StreamHost | null>(null);
  const [hostStream, setHostStream] = useState<MediaStream | null>(null);
  const [streamUrlInput, setStreamUrlInput] = useState('');
  const [streamPlayerOnly, setStreamPlayerOnly] = useState(true);
  // Прокси для страниц трансляции: VPN многих работает только для браузера,
  // а скрытое окно идёт напрямую (YouTube: «Нет подключения»). Храним локально.
  // Как окно трансляции выходит в интернет: 'system' (как Windows/браузер, по умолчанию),
  // 'direct' или конкретный прокси. Старое пустое значение = «как в Windows».
  const [streamProxy, setStreamProxyState] = useState(() => {
    try { return localStorage.getItem('wt-stream-proxy') || 'system'; } catch { return 'system'; }
  });
  const setStreamProxy = (v: string) => {
    setStreamProxyState(v);
    try { localStorage.setItem('wt-stream-proxy', v); } catch { /* приватный режим */ }
  };
  const [streamBusy, setStreamBusy] = useState(false);
  // Загрузка страницы в окне трансляции: у ведущего — локальные события Electron,
  // у зрителей — ретрансляция по комнате. Нужно, чтобы вместо белого экрана
  // был спиннер, а ошибка загрузки была видна.
  const [streamPageLoading, setStreamPageLoading] = useState(false);
  const [streamPageError, setStreamPageError] = useState<string | null>(null);

  const sync = useRoomSync(roomId, nickname, password || undefined);

  // Хуки — до любых ранних return (экран пароля и т.п.): иначе при переходе
  // с экрана пароля в комнату React падает «Rendered more hooks than during the previous render».
  // Версия приложения — видна в шапке комнаты, чтобы не гадать при отладке.
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => { api.serverInfo().then((i) => setAppVersion(i.version)).catch(() => {}); }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // «Смотреть» в медиатеке на главной: комната создана, видео пришло в state
  // навигации — включаем его один раз, как только вошли и можем управлять.
  const routeLocation = useLocation();
  const autoPlayDone = useRef(false);
  useEffect(() => {
    const play = (routeLocation.state as { play?: WatchSource } | null)?.play;
    if (!play || autoPlayDone.current || !sync.connected || !sync.canControl) return;
    autoPlayDone.current = true;
    setVideo(play);
    sync.setVideo(play);
    navigate(routeLocation.pathname, { replace: true, state: null }); // не повторять при обновлении
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.connected, sync.canControl]);

  // Применяем авторитетное состояние от сервера к плееру.
  // lastSync хранит момент получения — позицию досчитываем по своим часам:
  // expected = positionSec + возраст_позиции_на_сервере + время_с_получения.
  // Расхождение системных часов устройств в LAN больше не влияет на синхрон.
  const lastSyncRef = useRef<(SyncState & { receivedAt: number }) | null>(null);
  const applyFnRef = useRef<(s: SyncState) => void>(() => {});
  const expectedOf = (s: SyncState & { receivedAt: number }) =>
    s.state === 'playing'
      ? s.positionSec + (s.positionAgeMs + (Date.now() - s.receivedAt)) / 1000
      : s.positionSec;
  useEffect(() => {
    applyFnRef.current = (s: SyncState) => {
      const anchored = { ...s, receivedAt: Date.now() };
      lastSyncRef.current = anchored;
      const p = playerRef.current;
      if (!p) return;
      if (s.video?.url !== video?.url) setVideo(s.video);
      const expected = expectedOf(anchored);
      const drift = Math.abs(p.currentTime() - expected);
      if (drift > DRIFT_TOLERANCE) p.seekTo(expected);
      if (s.state === 'playing') p.play();
      else p.pause();
    };
    sync.setApply((s) => applyFnRef.current(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.setApply, video?.url]);

  // Rutube: страница ролика → свежий m3u8 через серверный прокси.
  useEffect(() => {
    let cancelled = false;
    setSeasonPack(null);
    if (!video || video.kind !== 'rutube') {
      setResolvedVideo(video);
      setResolveError(null);
      return;
    }
    setResolvedVideo(null);
    setResolveError(null);
    api.rutubeStream(video.url)
      .then((r) => {
        if (cancelled) return;
        if (r.streamUrl) {
          setResolvedVideo({ ...video, kind: 'direct', url: proxiedStream(r.streamUrl, 'https://rutube.ru/') });
        } else {
          setResolveError('Rutube не отдал поток для этого ролика.');
        }
      })
      .catch((e) => {
        if (!cancelled) setResolveError(e instanceof Error ? e.message : 'Ошибка запроса к Rutube');
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.url]);

  // Поток резолвнулся → повторяем применение состояния (позиция, автостарт).
  useEffect(() => {
    if (resolvedVideo && lastSyncRef.current) applyFnRef.current(lastSyncRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedVideo?.url]);

  // Непрерывная подгонка под комнату: раз в 2 с сверяем позицию с авторитетной.
  // События play/pause/seek приходят редко, а буферизация (особенно у участников
  // LAN через прокси) даёт постоянное отставание — догоняем плавным изменением
  // скорости; жёсткий seek только при большом расхождении и не чаще раза в 10 с.
  const lastHardSeek = useRef(0);
  const resolvedVideoRef = useRef<WatchSource | null>(null);
  useEffect(() => { resolvedVideoRef.current = resolvedVideo; }, [resolvedVideo]);
  useEffect(() => {
    const t = setInterval(() => {
      const s = lastSyncRef.current;
      const p = playerRef.current;
      if (!s || !p || s.state !== 'playing' || !resolvedVideoRef.current) return;
      const pos = p.getPosition();
      if (pos.state !== 'playing') return; // пауза или буферизация — не трогаем
      const expected = expectedOf(s);
      const drift = expected - pos.positionSec;
      if (Math.abs(drift) > HARD_DRIFT) {
        if (Date.now() - lastHardSeek.current > 10000) {
          lastHardSeek.current = Date.now();
          p.setRate(1);
          p.seekTo(expected);
        }
        return;
      }
      if (drift > RATE_DRIFT) p.setRate(Math.min(1.2, 1 + drift * 0.08));
      else if (drift < -RATE_DRIFT) p.setRate(Math.max(0.9, 1 + drift * 0.08));
      else p.setRate(1);
    }, 2000);
    return () => clearInterval(t);
  }, []);

  // Heartbeat берёт позицию у плеера.
  useEffect(() => {
    sync.setGetPosition(() => playerRef.current?.getPosition() ?? { positionSec: 0, state: 'paused' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.setGetPosition]);

  // Исходное видео из снапшота (первая загрузка).
  useEffect(() => {
    if (sync.syncState && video?.url !== sync.syncState.video?.url) {
      setVideo(sync.syncState.video);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.syncState]);

  // --- трансляция сайта (ведущий) ---
  const stopStream = useCallback(() => {
    streamHostRef.current?.dispose();
    streamHostRef.current = null;
    setHostStream(null);
  }, []);

  const startStream = useCallback(async () => {
    const socket = sync.getSocket();
    const url = streamUrlInput.trim();
    const d = getDesktop();
    if (!socket || !url || !d) return;
    setStreamBusy(true);
    setStreamPageLoading(true); // страница ещё даже не начала грузиться — уже показываем спиннер
    setStreamPageError(null);
    try {
      // Прокси (если задан) — до открытия окна: страница сразу пойдёт через VPN.
      const proxy = streamProxy.trim() || 'system';
      await d.setProxy(proxy);
      const host = new StreamHost(socket);
      host.onStream = (s) => setHostStream(s);
      host.onEnded = () => stopStream();
      await host.start(url, streamPlayerOnly);
      streamHostRef.current = host;
    } catch {
      setQueueMsg('Не удалось запустить трансляцию — окно не захватилось');
      setTimeout(() => setQueueMsg(null), 4000);
    } finally {
      setStreamBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.getSocket, streamUrlInput, streamPlayerOnly, streamProxy, stopStream]);

  // Уходим со страницы комнаты — трансляция останавливается, окно закрывается.
  useEffect(() => () => {
    streamHostRef.current?.dispose();
    streamHostRef.current = null;
  }, []);

  // Индикатор загрузки страницы трансляции: локальные события Electron (у ведущего).
  useEffect(() => {
    const d = getDesktop();
    if (!d?.onStreamLoading) return;
    return d.onStreamLoading((s) => {
      setStreamPageLoading(s.loading);
      setStreamPageError(s.error ? `Страница не загрузилась: ${s.error}` : null);
    });
  }, []);

  // То же состояние у зрителей — ретрансляция от ведущего через сервер.
  useEffect(() => {
    if (!sync.connected) return;
    const socket = sync.getSocket();
    if (!socket) return;
    const onLoading = (s: { loading?: boolean; error?: string }) => {
      setStreamPageLoading(!!s.loading);
      setStreamPageError(s.error ? `Страница не загрузилась: ${s.error}` : null);
    };
    socket.on('stream:loading', onLoading);
    return () => { socket.off('stream:loading', onLoading); };
  }, [sync.connected, sync.getSocket]);

  // Трансляция остановлена — сбрасываем индикаторы.
  useEffect(() => {
    if (!sync.streamInfo?.active) {
      setStreamPageLoading(false);
      setStreamPageError(null);
    }
  }, [sync.streamInfo?.active]);

  // Потеря соединения с сервером (хост закрыл доступ / выключил приложение):
  // если связь была и пропала дольше 8 с — показываем оверлей.
  const [lostConn, setLostConn] = useState(false);
  const everConnected = useRef(false);
  useEffect(() => {
    if (sync.connected) {
      everConnected.current = true;
      setLostConn(false);
      return;
    }
    if (!everConnected.current) return;
    const t = setTimeout(() => setLostConn(true), 8000);
    return () => clearTimeout(t);
  }, [sync.connected]);

  // «Домой»: на чужом сервере (подключение по IP/туннелю в десктопе)
  // возвращаемся на свой локальный сервер, иначе — роутинг на главную.
  const goHome = useCallback(() => {
    const d = getDesktop();
    if (d && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      window.location.href = `http://localhost:${d.localPort}/`;
    } else {
      navigate('/');
    }
  }, [navigate]);

  // Полноэкранный режим трансляции: видео на весь экран, чат — полупрозрачной
  // панелью поверх, сворачивается в кнопку со счётчиком непрочитанных.
  const streamBoxRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsPanelOpen, setFsPanelOpen] = useState(true);
  const [fsUnread, setFsUnread] = useState(0);
  useEffect(() => {
    const onFs = () => {
      const f = !!document.fullscreenElement;
      setIsFullscreen(f);
      if (!f) { setFsUnread(0); setFsPanelOpen(true); }
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const fsMsgCountRef = useRef(0);
  useEffect(() => {
    const prev = fsMsgCountRef.current;
    const now = sync.messages.length;
    fsMsgCountRef.current = now;
    if (isFullscreen && !fsPanelOpen && now > prev) setFsUnread((u) => u + (now - prev));
  }, [sync.messages.length, isFullscreen, fsPanelOpen]);
  useEffect(() => { if (fsPanelOpen) setFsUnread(0); }, [fsPanelOpen]);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void streamBoxRef.current?.requestFullscreen().catch(() => {});
  }, []);

  const onUserPlay = useCallback((pos: number) => sync.play(pos), [sync.play]);
  const onUserPause = useCallback((pos: number) => sync.pause(pos), [sync.pause]);
  const onUserSeek = useCallback((pos: number) => sync.seek(pos), [sync.seek]);
  // Видео доиграло → сервер запишет в историю и включит следующее из очереди.
  const onUserEnded = useCallback((pos: number) => sync.videoEnded(pos), [sync.videoEnded]);

  const pickResult = async (r: SearchResult) => {
    const yt = extractYouTubeId(r.url);
    const isMedia = /\.(mp4|webm|mkv|m3u8|mp3|ogg)(\?|$)/i.test(r.url);

    // Сериальные провайдеры: страница сериала → тянем список серий
    if ((r.provider === 'lostfilm' || r.provider === 'lordserial') && !isMedia) {
      setEpisodeError(null);
      setStreamPageUrl(null);
      pendingEpisode.current = null;
      setEpisodes(null);
      setEpisodesFor(r.title);
      setEpisodesProvider(r.provider);
      setTab('episodes'); // показываем список серий сразу под плеером
      try {
        const { episodes } = r.provider === 'lostfilm'
          ? await api.lostfilmEpisodes(r.url)
          : await api.lordserialEpisodes(r.url);
        if (episodes.length === 0) {
          setEpisodeError('Серии не найдены на странице. Возможно, поменялась вёрстка зеркала.');
        }
        setEpisodes(episodes);
      } catch (e) {
        setEpisodeError(e instanceof Error ? e.message : 'Ошибка загрузки серий');
      }
      return;
    }

    // Rutube: страница ролика — поток резолвим отдельно (эффект выше).
    if (r.provider === 'rutube' || isRutubeUrl(r.url)) {
      const source: WatchSource = { kind: 'rutube', url: r.url, title: r.title, provider: 'rutube' };
      setVideo(source);
      sync.setVideo(source);
      return;
    }

    const source: WatchSource = yt
      ? { kind: 'youtube', url: r.url, title: r.title, provider: r.provider }
      : isMedia
        ? { kind: 'direct', url: r.url, title: r.title, provider: r.provider }
        : { kind: 'embed', url: r.url, title: r.title, provider: r.provider };
    if (source.kind === 'embed') {
      // Страницы-витрины не проигрываются напрямую — нужна ссылка на поток.
      alert('Это страница, а не видеопоток. Откройте её, скопируйте прямую ссылку на видео (mp4/m3u8) и вставьте ниже.');
      return;
    }
    setVideo(source);
    sync.setVideo(source);
  };

  const pickEpisode = async (ep: EpisodeInfo) => {
    setStreamLoading(true);
    setEpisodeError(null);
    setStreamPageUrl(null);
    try {
      const { streamUrl, pageUrl } = episodesProvider === 'lostfilm'
        ? await api.lostfilmStream(ep.url)
        : await api.lordserialStream(ep.url);
      if (streamUrl) {
        pendingEpisode.current = null;
        const source: WatchSource = {
          kind: 'direct',
          url: streamUrl,
          title: `${episodesFor} — S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`,
          provider: episodesProvider,
        };
        setVideo(source);
        sync.setVideo(source);
        return;
      }

      // Статика не дала поток (плеер обфусцирован). В десктопе перехватываем
      // реальный запрос плеера в скрытом окне — работает почти всегда.
      const desktop = getDesktop();
      if (desktop) {
        setEpisodeError('Плеер сайта прячет поток — ищем его во встроенном браузере (до 30 секунд)…');
        const seriesPage = ep.url.replace(/#s\d+e\d+$/, '');
        const res = await desktop.sniffStream({ pageUrl: seriesPage, season: ep.season, episode: ep.episode });
        if (res.ok && res.streamUrl) {
          pendingEpisode.current = null;
          setEpisodeError(null);
          setStreamPageUrl(null);
          const source: WatchSource = {
            kind: 'direct',
            url: playableSniffedUrl(res),
            title: `${episodesFor} — S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`,
            provider: episodesProvider,
          };
          setVideo(source);
          sync.setVideo(source);
          return;
        }
        if (res.error === 'busy') {
          setEpisodeError('Уже идёт поиск другого потока — подождите и нажмите на серию ещё раз.');
          return;
        }
      }

      pendingEpisode.current = ep; // для повторной попытки после авторизации
      setStreamPageUrl(pageUrl);
      setEpisodeError('Прямой поток не найден: сайт просит авторизацию или прячет поток.');
    } catch (e) {
      setEpisodeError(e instanceof Error ? e.message : 'Ошибка получения потока');
    } finally {
      setStreamLoading(false);
    }
  };

  // «Авторизоваться на сайте»: в десктопе — встроенное окно входа, куки уйдут
  // на сервер и серия повторится автоматически; в браузере — внешняя вкладка.
  const openAuth = async () => {
    setAuthBusy(true);
    try {
      const providers = await api.listProviders();
      const prov = providers.find((p) => p.id === episodesProvider);
      const mirror = ((prov?.config.mirrors as string[]) ?? [])[0];
      const loginPath = (prov?.config.loginPath as string) ?? '/login';
      const authUrl = mirror ? new URL(loginPath, mirror).toString() : streamPageUrl;
      if (!authUrl) return;

      const desktop = getDesktop();
      if (desktop) {
        const res = await desktop.openAuth(episodesProvider, authUrl);
        if (res.opened && (res.cookiesSaved ?? 0) > 0) {
          setEpisodeError(null);
          setStreamPageUrl(null);
          // Повторяем серию, на которой споткнулись, — теперь с куками сессии.
          const ep = pendingEpisode.current;
          if (ep) await pickEpisode(ep);
          return;
        }
        setEpisodeError('Окно авторизации закрыто, но куки сессии не получены. Войдите на сайте и закройте окно ещё раз.');
      } else {
        window.open(authUrl, '_blank', 'noopener');
        setEpisodeError('Авторизуйтесь на сайте в открывшейся вкладке, затем нажмите на серию ещё раз.');
      }
    } catch {
      setEpisodeError('Не удалось открыть страницу авторизации');
    } finally {
      setAuthBusy(false);
    }
  };

  const applyDirectUrl = () => {
    const url = directUrl.trim();
    if (!url) return;
    const yt = extractYouTubeId(url);
    const source: WatchSource = yt
      ? { kind: 'youtube', url, title: 'YouTube' }
      : isRutubeUrl(url)
        ? { kind: 'rutube', url, title: 'Rutube', provider: 'rutube' }
        : { kind: 'direct', url, title: url.split('/').pop() ?? url };
    setVideo(source);
    sync.setVideo(source);
    setDirectUrl('');
  };

  // --- очередь ---
  // Файл медиатеки хоста: включить сейчас для всех.
  const playLibrary = (f: LibraryFile) => {
    const source = librarySource(f);
    setVideo(source);
    sync.setVideo(source);
  };

  const queueSource = (source: WatchSource) => {
    sync.queueAdd(source);
    setQueueMsg(`В очереди: ${source.title ?? source.url}`);
    setTimeout(() => setQueueMsg(null), 2500);
  };

  // Кнопка «+» у результата поиска: в очередь, не включая.
  const queueResult = (r: SearchResult) => {
    const yt = extractYouTubeId(r.url);
    if (yt) return queueSource({ kind: 'youtube', url: r.url, title: r.title, provider: r.provider });
    if (r.provider === 'rutube' || isRutubeUrl(r.url)) {
      return queueSource({ kind: 'rutube', url: r.url, title: r.title, provider: 'rutube' });
    }
    if (/\.(mp4|webm|mkv|m3u8|mp3|ogg)(\?|$)/i.test(r.url)) {
      return queueSource({ kind: 'direct', url: r.url, title: r.title, provider: r.provider });
    }
    setQueueMsg('В очередь можно добавить Rutube, YouTube или прямую ссылку');
    setTimeout(() => setQueueMsg(null), 3000);
  };

  // Поле под плеером: ссылка сразу в очередь. У Rutube заодно узнаём название.
  const addQueueUrl = async () => {
    const url = queueUrl.trim();
    if (!url) return;
    const yt = extractYouTubeId(url);
    if (yt) {
      queueSource({ kind: 'youtube', url, title: 'YouTube' });
    } else if (isRutubeUrl(url)) {
      try {
        const info = await api.rutubeStream(url);
        queueSource({ kind: 'rutube', url, title: info.title ?? 'Rutube', provider: 'rutube' });
      } catch {
        queueSource({ kind: 'rutube', url, title: 'Rutube', provider: 'rutube' });
      }
    } else if (/\.(mp4|webm|mkv|m3u8|mp3|ogg)(\?|$)/i.test(url)) {
      queueSource({ kind: 'direct', url, title: url.split('/').pop() ?? url });
    } else {
      setQueueMsg('Поддерживаются ссылки Rutube, YouTube и прямые (mp4/m3u8)');
      setTimeout(() => setQueueMsg(null), 3000);
      return;
    }
    setQueueUrl('');
  };

  // «Серии сезона» для Rutube-сериала, который сейчас играет.
  const currentSerial = video?.kind === 'rutube' ? parseSerialTitle(video.title) : null;
  const loadSeasonPack = async () => {
    if (!video) return;
    setSeasonLoading(true);
    try {
      const pack = await api.rutubeSeason(video.url);
      setSeasonPack(pack.episodes.length > 0 ? pack : null);
      if (pack.episodes.length === 0) {
        setQueueMsg('Серии сезона не нашлись поиском — добавьте ссылки вручную');
        setTimeout(() => setQueueMsg(null), 3000);
      }
    } catch {
      setQueueMsg('Не удалось собрать серии сезона');
      setTimeout(() => setQueueMsg(null), 3000);
    } finally {
      setSeasonLoading(false);
    }
  };

  const queueAllAfterCurrent = () => {
    if (!seasonPack || !currentSerial) return;
    for (const ep of seasonPack.episodes) {
      const afterCurrent = ep.season > currentSerial.season
        || (ep.season === currentSerial.season && ep.episode > currentSerial.episode);
      if (afterCurrent) {
        sync.queueAdd({ kind: 'rutube', url: ep.url, title: ep.title, provider: 'rutube' });
      }
    }
    setQueueMsg('Серии добавлены в очередь');
    setTimeout(() => setQueueMsg(null), 2500);
  };

  // --- история просмотра ---
  const loadHistory = useCallback(() => {
    api.roomHistory(roomId).then((r) => setHistory(r.history)).catch(() => {});
  }, [roomId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);
  // Обновляем историю, когда видео сменилось (сервер уже записал запись).
  useEffect(() => {
    if (!video?.url) return;
    const t = setTimeout(loadHistory, 1200);
    return () => clearTimeout(t);
  }, [video?.url, loadHistory]);

  const playFromHistory = (h: HistoryEntry) => {
    setVideo(h.video);
    sync.setVideo(h.video);
  };

  const playFromQueue = (id: number, v: WatchSource) => {
    sync.queueRemove(id);
    setVideo(v);
    sync.setVideo(v);
  };

  const copyInvite = async () => {
    // У хоста приложение открыто на localhost — такая ссылка бесполезна для
    // остальных. Собираем варианты со всех адресов, которые сообщил сервер.
    let links = [`${location.origin}/room/${roomId}`];
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      try {
        const info = await api.serverInfo();
        const ips = info.addresses ?? [];
        if (ips.length > 0) links = ips.map((ip) => `http://${ip}:${location.port}/room/${roomId}`);
      } catch { /* оставляем как есть */ }
    }
    const link = links[0];
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        // По http://<ip>:9345 clipboard API недоступен — старый способ.
        const ta = document.createElement('textarea');
        ta.value = link;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* буфер недоступен */ }
    // Несколько сетей — показываем все варианты, чтобы выбрать рабочий.
    if (links.length > 1) {
      setInviteLinks(links);
      setTimeout(() => setInviteLinks(null), 15000);
    } else {
      setInviteLinks(null);
    }
  };

  if (!nickname) {
    // без ника — на главную
    return <Navigate to="/" replace />;
  }

  if (sync.error === 'NEED_PASSWORD' || sync.error === 'WRONG_PASSWORD' || sync.error === 'TOO_MANY_ATTEMPTS') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4">
        <h1 className="text-lg font-semibold text-zinc-100">Комната защищена паролем</h1>
        {sync.error === 'WRONG_PASSWORD' && <p className="text-sm text-red-400">Неверный пароль, попробуйте ещё раз</p>}
        {sync.error === 'TOO_MANY_ATTEMPTS' && <p className="text-sm text-red-400">Слишком много неверных попыток — подождите несколько минут</p>}
        <div className="flex w-full max-w-xs gap-2">
          <Input
            type="password"
            value={passwordDraft}
            onChange={(e) => setPasswordDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setPassword(passwordDraft)}
            placeholder="Пароль комнаты"
            aria-label="Пароль комнаты"
            autoFocus
          />
          <Button onClick={() => setPassword(passwordDraft)} disabled={!passwordDraft}>Войти</Button>
        </div>
        <Button variant="outline" onClick={() => navigate('/')}>На главную</Button>
      </div>
    );
  }

  if (sync.error) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4">
        <p className="text-lg text-zinc-200">{sync.error}</p>
        <Button variant="outline" onClick={() => navigate('/')}>На главную</Button>
      </div>
    );
  }

  const episodesActive = episodes !== null || !!episodeError;

  const tabs: { id: typeof tab; label: string }[] = [
    { id: 'search', label: 'Поиск' },
    { id: 'library', label: 'Медиатека' },
    ...(episodesActive ? [{ id: 'episodes' as const, label: 'Серии' }] : []),
    { id: 'queue', label: `Очередь${sync.queue.length > 0 ? ` (${sync.queue.length})` : ''}` },
    { id: 'history', label: 'История' },
    { id: 'stream', label: `Трансляция${sync.streamInfo?.active ? ' •' : ''}` },
  ];

  const amStreamHost = !!sync.streamInfo?.active && sync.streamInfo.hostClientId === getClientId();

  // Настройки комнаты видят её создатель и сам компьютер-хост (сервер всё равно проверит).
  const canManage = sync.room?.hostClientId === getClientId()
    || (!!getDesktop() && ['localhost', '127.0.0.1'].includes(window.location.hostname));

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1920px] flex-col gap-4 px-4 py-6">
      <header className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/')}>← Назад</Button>
        <h1 className="text-lg font-semibold text-zinc-50">{sync.room?.name ?? 'Комната'}</h1>
        {appVersion && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">v{appVersion}</span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-xs ${
          sync.connected ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
        }`}>
          {sync.connected ? 'Подключено' : 'Нет связи…'}
        </span>
        <span className="text-xs text-zinc-500">
          {sync.room?.controlMode === 'host'
            ? (sync.isHost ? 'Вы хост — управление у вас' : 'Управляет только хост')
            : 'Управлять может каждый'}
        </span>
        {sync.room?.hidden && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400" title="Не видна в списке комнат у других">скрыта</span>
        )}
        <div className="ml-auto flex gap-2">
          {canManage && sync.room && (
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>Настройки</Button>
          )}
          <Button variant="outline" size="sm" onClick={copyInvite}>
            {copied ? 'Скопировано!' : 'Пригласить (ссылка)'}
          </Button>
        </div>
      </header>
      {canManage && sync.room && (
        <RoomSettingsDialog
          room={{ id: sync.room.id, name: sync.room.name, hasPassword: !!sync.room.hasPassword, hidden: !!sync.room.hidden }}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onSaved={() => { /* room:meta придёт по сокету и обновит шапку */ }}
          onDeleted={() => navigate('/')}
        />
      )}

      {inviteLinks && inviteLinks.length > 1 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <p className="mb-1.5 text-xs text-amber-300">
            У вас несколько сетей (LAN, туннели, виртуальные адаптеры) — отправьте друзьям ту ссылку, которая у них откроется. Скопирована первая.
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {inviteLinks.map((l) => (
              <li key={l}>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(l).catch(() => {});
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  title="Скопировать эту ссылку"
                  className="cursor-pointer rounded-full border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 font-mono text-xs text-zinc-300 transition-colors hover:border-amber-500/50 hover:text-amber-300"
                >
                  {l}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* левая колонка: плеер + прямая ссылка + вкладки */}
        <div className="flex min-w-0 flex-col gap-3">
          <div
            ref={streamBoxRef}
            className={isFullscreen ? 'relative flex items-center justify-center bg-black' : 'relative'}
          >
            {video?.kind === 'stream' ? (
              sync.streamInfo?.active && sync.streamInfo.hostClientId ? (
                amStreamHost && hostStream ? (
                  // Ведущий смотрит свой локальный захват (без WebRTC-петли).
                  // Скрытое окно за экраном не видно, поэтому управление — прямо
                  // отсюда: клики и колесо уходят в окно трансляции через Electron.
                  <div className={`relative select-none overflow-hidden bg-black ${isFullscreen ? 'h-full w-full' : 'aspect-video w-full rounded-xl'}`}>
                    <video
                      autoPlay muted playsInline
                      className={`absolute inset-0 h-full w-full ${isFullscreen ? 'object-contain' : ''}`}
                      ref={(el) => { if (el && el.srcObject !== hostStream) el.srcObject = hostStream; }}
                    />
                    <div
                      className="absolute inset-0 cursor-pointer"
                      title="Вы управляете трансляцией: клик — как по странице, колесо — прокрутка"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        void getDesktop()?.streamInput({
                          kind: 'click',
                          x: (e.clientX - rect.left) / rect.width,
                          y: (e.clientY - rect.top) / rect.height,
                        });
                      }}
                      onWheel={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        void getDesktop()?.streamInput({
                          kind: 'wheel',
                          x: (e.clientX - rect.left) / rect.width,
                          y: (e.clientY - rect.top) / rect.height,
                          deltaY: e.deltaY,
                        });
                      }}
                    />
                    {streamPageLoading && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-black/70 text-sm text-zinc-300">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-amber-400" />
                        Загружаем страницу…
                      </div>
                    )}
                    <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-amber-300">
                      Вы управляете трансляцией
                    </span>
                  </div>
                ) : (
                  <StreamView
                    getSocket={sync.getSocket}
                    connected={sync.connected}
                    hostClientId={sync.streamInfo.hostClientId}
                    allowControl={sync.streamInfo.allowControl}
                    pageLoading={streamPageLoading}
                  />
                )
              ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl bg-black text-sm text-zinc-500">
                  <p>Трансляция сайта не идёт</p>
                  {sync.canControl && getDesktop() && (
                    <button
                      type="button"
                      onClick={() => setTab('stream')}
                      className="cursor-pointer text-amber-400/90 transition-colors hover:text-amber-300"
                    >
                      Начать во вкладке «Трансляция»
                    </button>
                  )}
                </div>
              )
            ) : (
              <>
                <Player
                  ref={playerRef}
                  video={resolvedVideo}
                  canControl={sync.canControl}
                  onUserPlay={onUserPlay}
                  onUserPause={onUserPause}
                  onUserSeek={onUserSeek}
                  onUserEnded={onUserEnded}
                />
                {video?.kind === 'rutube' && !resolvedVideo && !resolveError && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/60 text-sm text-zinc-300">
                    Получаем поток Rutube…
                  </div>
                )}
              </>
            )}

            {/* Полноэкранный режим: только когда идёт трансляция сайта */}
            {video?.kind === 'stream' && sync.streamInfo?.active && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
                className="absolute bottom-2 right-2 z-30 cursor-pointer rounded-lg bg-black/60 px-2.5 py-1.5 text-sm text-zinc-200 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-amber-300"
                title={isFullscreen ? 'Выйти из полноэкранного режима (Esc)' : 'На весь экран'}
                aria-label="Полноэкранный режим"
              >
                {isFullscreen ? '🗗 Свернуть' : '⛶ Во весь экран'}
              </button>
            )}

            {/* В полноэкранном режиме чат — полупрозрачной панелью поверх видео */}
            {isFullscreen && video?.kind === 'stream' && (
              fsPanelOpen ? (
                <div className="absolute right-0 top-0 z-40 flex h-full w-[320px] flex-col gap-2 bg-black/60 p-3 backdrop-blur-md">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-zinc-200">Чат</span>
                    <button
                      type="button"
                      onClick={() => setFsPanelOpen(false)}
                      className="cursor-pointer rounded px-2 py-0.5 text-xs text-zinc-400 transition-colors hover:text-amber-300"
                    >
                      Свернуть →
                    </button>
                  </div>
                  <Chat messages={sync.messages} onSend={sync.sendChat} connected={sync.connected} />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setFsPanelOpen(true)}
                  className="absolute right-3 top-3 z-40 flex cursor-pointer items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs text-zinc-200 backdrop-blur-md transition-colors hover:text-amber-300"
                  aria-label="Открыть чат"
                >
                  💬 Чат
                  {fsUnread > 0 && (
                    <span className="rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-black">+{fsUnread}</span>
                  )}
                </button>
              )
            )}
          </div>
          {resolveError && <p className="text-sm text-red-400">{resolveError}</p>}

          {/* прямая ссылка */}
          <div className="flex gap-2">
            <Input
              value={directUrl}
              onChange={(e) => setDirectUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyDirectUrl()}
              placeholder="Прямая ссылка на видео (mp4/m3u8), YouTube или Rutube…"
              aria-label="Прямая ссылка на видео"
            />
            <Button onClick={applyDirectUrl} disabled={!directUrl.trim() || !sync.canControl}>
              Включить
            </Button>
          </div>

          {/* вкладки: поиск / серии / очередь / история */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800 px-3 pt-2">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`cursor-pointer rounded-t-lg border-b-2 px-3 py-1.5 text-sm transition-colors ${
                    tab === t.id
                      ? 'border-amber-500 text-amber-300'
                      : 'border-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {t.label}
                </button>
              ))}
              {queueMsg && <span className="ml-auto pb-1.5 text-xs text-amber-400/90">{queueMsg}</span>}
            </div>

            <div className="p-4">
              {tab === 'search' && (
                <SearchPanel onPick={pickResult} onQueue={queueResult} />
              )}

              {tab === 'library' && (
                <LibraryPanel onPlay={playLibrary} onQueue={(f) => queueSource(librarySource(f))} />
              )}

              {tab === 'episodes' && episodesActive && (
                <div>
                  <h2 className="mb-2 text-sm font-semibold text-zinc-200">
                    Серии: <span className="text-zinc-400">{episodesFor}</span>
                  </h2>
                  {episodeError && (
                    <div className="mb-2 rounded-lg border border-red-900/50 bg-red-950/30 p-3">
                      <p className="text-sm text-red-400">{episodeError}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" onClick={openAuth} disabled={authBusy}>
                          {authBusy ? 'Открываем…' : 'Авторизоваться на сайте'}
                        </Button>
                        {streamPageUrl && (
                          <Button
                            size="sm" variant="outline"
                            onClick={() => window.open(streamPageUrl, '_blank', 'noopener')}
                          >
                            Открыть страницу серии
                          </Button>
                        )}
                      </div>
                      {streamPageUrl && (
                        <p className="mt-2 text-xs break-all text-zinc-500">{streamPageUrl}</p>
                      )}
                    </div>
                  )}
                  {streamLoading && <p className="mb-2 text-sm text-zinc-400">Получаем поток…</p>}
                  {episodes && episodes.length > 0 && (
                    <ul className="grid max-h-80 grid-cols-1 gap-1 overflow-y-auto pr-1 md:grid-cols-2">
                      {episodes.map((ep) => (
                        <li key={`${ep.season}-${ep.episode}`}>
                          <button
                            type="button"
                            onClick={() => pickEpisode(ep)}
                            disabled={streamLoading || !sync.canControl}
                            className="w-full cursor-pointer rounded-lg px-2 py-1.5 text-left text-sm text-zinc-200 transition-colors hover:bg-zinc-800/70 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-amber-500"
                          >
                            <span className="mr-2 font-mono text-xs text-amber-500/80">
                              S{String(ep.season).padStart(2, '0')}E{String(ep.episode).padStart(2, '0')}
                            </span>
                            {ep.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {tab === 'queue' && (
                <div>
                  <div className="flex gap-2">
                    <Input
                      value={queueUrl}
                      onChange={(e) => setQueueUrl(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addQueueUrl()}
                      placeholder="Ссылка — в очередь (Rutube, YouTube, mp4)…"
                      aria-label="Добавить ссылку в очередь"
                    />
                    <Button variant="outline" onClick={addQueueUrl} disabled={!queueUrl.trim() || !sync.canControl}>
                      +
                    </Button>
                    {sync.queue.length > 0 && sync.canControl && (
                      <Button variant="ghost" size="sm" onClick={sync.queueClear} className="text-zinc-500 hover:text-red-400">
                        Очистить
                      </Button>
                    )}
                  </div>

                  {sync.queue.length === 0 && (
                    <p className="mt-3 text-sm text-zinc-500">
                      Очередь пуста. Добавьте ссылки или нажмите «+» у результатов поиска — по окончании видео следующее включится само.
                    </p>
                  )}
                  {sync.queue.length > 0 && (
                    <ul className="mt-3 grid max-h-72 grid-cols-1 gap-1 overflow-y-auto pr-1 md:grid-cols-2">
                      {sync.queue.map((q, i) => (
                        <li key={q.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-800/70">
                          <span className="w-4 shrink-0 text-center text-xs text-zinc-500">{i + 1}</span>
                          <button
                            type="button"
                            onClick={() => playFromQueue(q.id, q.video)}
                            disabled={!sync.canControl}
                            title="Включить сейчас"
                            className="min-w-0 flex-1 cursor-pointer truncate text-left text-zinc-200 disabled:cursor-not-allowed"
                          >
                            {q.video.title ?? q.video.url}
                          </button>
                          {sync.canControl && (
                            <button
                              type="button"
                              onClick={() => sync.queueRemove(q.id)}
                              aria-label="Убрать из очереди"
                              className="shrink-0 cursor-pointer text-zinc-500 transition-colors hover:text-red-400"
                            >
                              ×
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* серии сезона Rutube-сериала (текущий и следующий сезон) */}
                  {currentSerial && (
                    <div className="mt-3 border-t border-zinc-800 pt-3">
                      <Button variant="outline" size="sm" onClick={loadSeasonPack} disabled={seasonLoading}>
                        {seasonLoading ? 'Ищем серии…' : `Серии сезона: ${currentSerial.base}`}
                      </Button>
                      {seasonPack && seasonPack.episodes.length > 0 && (
                        <div className="mt-2">
                          <div className="mb-1 flex items-center justify-between text-xs text-zinc-500">
                            <span>Найдено серий: {seasonPack.episodes.length} (сезоны {seasonPack.season}–{seasonPack.season! + 1})</span>
                            <button
                              type="button"
                              onClick={queueAllAfterCurrent}
                              className="cursor-pointer text-amber-400/90 transition-colors hover:text-amber-300"
                            >
                              + все после текущей
                            </button>
                          </div>
                          <ul className="grid max-h-72 grid-cols-1 gap-1 overflow-y-auto pr-1 md:grid-cols-2">
                            {seasonPack.episodes.map((ep) => {
                              const isPast = currentSerial && (ep.season < currentSerial.season
                                || (ep.season === currentSerial.season && ep.episode <= currentSerial.episode));
                              return (
                                <li key={`${ep.season}-${ep.episode}`} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-zinc-800/70">
                                  <span className="shrink-0 font-mono text-xs text-amber-500/80">
                                    S{ep.season}E{String(ep.episode).padStart(2, '0')}
                                  </span>
                                  <span className={`min-w-0 flex-1 truncate ${isPast ? 'text-zinc-600' : 'text-zinc-300'}`} title={ep.title}>
                                    {ep.title}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => queueSource({ kind: 'rutube', url: ep.url, title: ep.title, provider: 'rutube' })}
                                    disabled={!sync.canControl}
                                    aria-label="В очередь"
                                    title="В очередь"
                                    className="shrink-0 cursor-pointer text-zinc-400 transition-colors hover:text-amber-300 disabled:opacity-40"
                                  >
                                    +
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {tab === 'history' && (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs text-zinc-500">Всё, что смотрели в этой комнате. ✓ — досмотрено, иначе — где остановились.</p>
                    <button
                      type="button"
                      onClick={loadHistory}
                      className="cursor-pointer text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      Обновить
                    </button>
                  </div>
                  {history.length === 0 && (
                    <p className="text-sm text-zinc-500">История пуста — включите что-нибудь, и оно появится здесь.</p>
                  )}
                  <ul className="grid max-h-80 grid-cols-1 gap-1 overflow-y-auto pr-1 md:grid-cols-2">
                    {history.map((h) => (
                      <li key={h.video.url}>
                        <button
                          type="button"
                          onClick={() => playFromHistory(h)}
                          disabled={!sync.canControl}
                          className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-zinc-800/70 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <span className={`shrink-0 text-xs ${h.finished ? 'text-emerald-400' : 'text-zinc-500'}`}>
                            {h.finished ? '✓' : fmtPos(h.positionSec)}
                          </span>
                          <span className={`min-w-0 flex-1 truncate ${h.finished ? 'text-zinc-500' : 'text-zinc-200'}`}>
                            {h.video.title ?? h.video.url}
                          </span>
                          <span className="shrink-0 text-xs text-zinc-600">
                            {new Date(h.updatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {tab === 'stream' && (
                <div>
                  {!getDesktop() && (
                    <p className="text-sm text-zinc-400">
                      Вести трансляцию сайта может только десктопное приложение WatchTogether
                      (нужен захват окна). Смотреть трансляцию можно и из браузера.
                    </p>
                  )}
                  {getDesktop() && sync.canControl && !sync.streamInfo?.active && (
                    <div className="flex max-w-xl flex-col gap-2">
                      <Input
                        value={streamUrlInput}
                        onChange={(e) => {
                          const v = e.target.value;
                          setStreamUrlInput(v);
                          // YouTube/Rutube — сайты-видеохостинги: им нужна навигация
                          // (согласия, выбор следующей серии), «только плеер» их ломает.
                          if (/(?:youtube\.com|youtu\.be|rutube\.ru)/i.test(v)) setStreamPlayerOnly(false);
                        }}
                        placeholder="Страница для трансляции (YouTube, LostFilm, LordSerial…)"
                        aria-label="Ссылка на страницу для трансляции"
                      />
                      <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
                        <input
                          type="checkbox"
                          checked={streamPlayerOnly}
                          onChange={(e) => setStreamPlayerOnly(e.target.checked)}
                        />
                        Только плеер: заблокировать переходы по странице (для LostFilm/LordSerial)
                      </label>
                      <ProxyPicker value={streamProxy} onChange={setStreamProxy} />
                      <div>
                        <Button onClick={startStream} disabled={streamBusy || !streamUrlInput.trim()}>
                          {streamBusy ? 'Запускаем…' : 'Начать трансляцию'}
                        </Button>
                      </div>
                    </div>
                  )}
                  {sync.streamInfo?.active && (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-zinc-300">
                        Идёт трансляция: <span className="break-all text-zinc-400">{video?.title ?? ''}</span>
                      </p>
                      <p className="text-xs text-zinc-500">
                        {sync.streamInfo.playerOnly
                          ? 'Режим «только плеер»: навигация по странице заблокирована.'
                          : 'Свободная навигация по странице.'}
                        {sync.streamInfo.allowControl
                          ? ' Участники могут кликать по странице.'
                          : ' Управление страницей выключено.'}
                      </p>
                      {streamPageError && <p className="text-sm text-red-400">{streamPageError}</p>}
                      {amStreamHost && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant={sync.streamInfo.allowControl ? 'destructive' : 'outline'}
                            onClick={() => sync.getSocket()?.emit('stream:control', { allow: !sync.streamInfo?.allowControl })}
                          >
                            {sync.streamInfo.allowControl ? 'Запретить управление' : 'Разрешить управление мышью'}
                          </Button>
                          <Button
                            size="sm" variant="ghost" onClick={stopStream}
                            className="text-zinc-400 hover:text-red-400"
                          >
                            Остановить трансляцию
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* правая колонка: участники + чат на всю высоту */}
        <aside className="flex min-h-0 flex-col gap-4 lg:sticky lg:top-6 lg:h-[calc(100dvh-7.5rem)]">
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-xs font-semibold text-zinc-400">Участники</span>
              {sync.members.map((m) => (
                <span key={m.clientId} className="flex items-center gap-1.5 text-sm">
                  <span className={`h-2 w-2 rounded-full ${m.online ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                  <span className="text-zinc-200">{m.nickname}</span>
                  {sync.room?.hostClientId === m.clientId && (
                    <span className="rounded bg-amber-500/15 px-1.5 text-xs text-amber-300">хост</span>
                  )}
                </span>
              ))}
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <h2 className="mb-2 text-sm font-semibold text-zinc-200">Чат</h2>
            <Chat messages={sync.messages} onSend={sync.sendChat} connected={sync.connected} />
          </section>

          <VoicePanel getSocket={sync.getSocket} connected={sync.connected} />
        </aside>
      </div>

      {lostConn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-6 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-2xl">⚠️</div>
            <h2 className="text-lg font-semibold text-zinc-100">Соединение потеряно</h2>
            <p className="mt-2 text-sm text-zinc-400">
              Хост закрыл доступ, выключил приложение или пропала сеть.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button onClick={() => window.location.reload()}>Переподключиться</Button>
              <Button variant="outline" onClick={goHome}>На главную</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
