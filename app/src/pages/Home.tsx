// Главная. Сверху — два главных действия: «Новая комната» и «Подключиться к другу».
// Ниже вкладки: Комнаты, Медиатека (файлы этого ПК), Доступ для друзей
// (адрес в сети, ссылка через интернет, ZeroTier) и Источники (вход на сайты, зеркала).
// При первом запуске — приветствие с вопросом «как вас зовут».
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, librarySource, type LibraryFile, type RoomSummary } from '@/lib/api';
import { getClientId, getNickname, setNickname, getClientSecret } from '@/lib/identity';
import { getDesktop } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPanel } from '@/components/SettingsPanel';
import { LibraryPanel } from '@/components/LibraryPanel';
import { ProfileMenu } from '@/components/ProfileMenu';

interface Peer { id?: string; name: string; httpPort: number; from: string; addresses?: string[] }
type TabId = 'rooms' | 'library' | 'access' | 'sources';

const TAB_KEY = 'wt.homeTab';

// «сегодня 18:42», «вчера», «12 нояб» — компактно для списка комнат.
function fmtUpdated(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `сегодня ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function readTab(): TabId {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t === 'rooms' || t === 'library' || t === 'access' || t === 'sources') return t;
  } catch { /* приватный режим */ }
  return 'rooms';
}

function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  // По http://<ip> clipboard API нет — запасной путь через выделение.
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* noop */ }
  ta.remove();
}

const PlayIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>
);

const LockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-label="С паролем" role="img">
    <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 018 0v4" />
  </svg>
);

export default function Home() {
  const navigate = useNavigate();
  const [nick, setNick] = useState(getNickname());
  const [nickDraft, setNickDraft] = useState('');
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [newRoom, setNewRoom] = useState('');
  const [newRoomPassword, setNewRoomPassword] = useState('');
  const [controlMode, setControlMode] = useState<'all' | 'host'>('all');
  const [showRoomOptions, setShowRoomOptions] = useState(false);
  const [newRoomHidden, setNewRoomHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [tab, setTabState] = useState<TabId>(readTab);
  const [copied, setCopied] = useState<string | null>(null);
  const [serverInfo, setServerInfo] = useState<{ deviceName?: string; addresses?: string[]; id?: string; version?: string; httpsPort?: number | null } | null>(null);
  const [tunnel, setTunnel] = useState<{ active: boolean; url: string | null; provider?: string | null }>({ active: false, url: null });
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  // ZeroTier — виртуальная LAN поверх интернета («как Hamachi», есть Android/iOS).
  const [zt, setZt] = useState<{ installed: boolean; running: boolean } | null>(null);
  const [ztNetId, setZtNetId] = useState('');
  const [ztBusy, setZtBusy] = useState(false);
  const [ztMsg, setZtMsg] = useState<string | null>(null);
  // Автообновление: статус из main-процесса (idle/checking/downloading/ready/error).
  const [update, setUpdate] = useState<{ status: string; version: string | null }>({ status: 'idle', version: null });
  // Десктоп-приложение ушло на чужой сервер (Подключиться) — комнаты и
  // туннель там чужие; показываем баннер с возвратом на свой сервер.
  const desktop = getDesktop();
  const onRemoteHost = !!desktop && !['localhost', '127.0.0.1'].includes(location.hostname);

  const setTab = (t: TabId) => {
    setTabState(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* noop */ }
  };

  const reloadRooms = useCallback(() => {
    api.listRooms().then(setRooms).catch(() => setRooms([])).finally(() => setRoomsLoaded(true));
  }, []);

  useEffect(() => { reloadRooms(); }, [reloadRooms]);
  useEffect(() => { api.serverInfo().then(setServerInfo).catch(() => {}); }, []);
  // Версия и в заголовке окна ОС — видно при переключении окон.
  useEffect(() => {
    if (serverInfo?.version) document.title = `WatchTogether v${serverInfo.version}`;
  }, [serverInfo?.version]);
  useEffect(() => { getDesktop()?.tunnelStatus().then(setTunnel).catch(() => {}); }, []);
  useEffect(() => { getDesktop()?.ztStatus?.().then(setZt).catch(() => {}); }, []);
  // Автообновление: начальный статус + события из main-процесса.
  useEffect(() => {
    const d = getDesktop();
    if (!d?.onUpdate) return;
    d.updateStatus?.().then(setUpdate).catch(() => {});
    return d.onUpdate(setUpdate);
  }, []);
  // Туннель оборвался сам — показываем ошибку и возвращаем кнопку запуска.
  useEffect(() => {
    const d = getDesktop();
    if (!d?.onTunnelDown) return;
    return d.onTunnelDown(() => {
      setTunnel({ active: false, url: null });
      setTunnelError('Ссылка перестала работать: сервис Pinggy недоступен. Попробуйте позже или используйте ZeroTier.');
    });
  }, []);
  // Туннель (пере)поднялся — ссылка могла смениться (Pinggy обновляет её раз в час).
  useEffect(() => {
    const d = getDesktop();
    if (!d?.onTunnelUrl) return;
    return d.onTunnelUrl((s) => {
      setTunnel({ active: true, url: s.url, provider: s.provider });
      setTunnelError(null);
    });
  }, []);
  // Страховочный опрос статуса — вдруг событие пропустили.
  useEffect(() => {
    const d = getDesktop();
    if (!d) return;
    const t = setInterval(() => { d.tunnelStatus().then(setTunnel).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, []);

  const flashCopied = (key: string, text: string) => {
    copyText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };

  const saveNick = () => {
    const v = nickDraft.trim();
    if (!v) return;
    setNickname(v);
    setNick(v);
    setError(null);
  };

  const requireNick = (): boolean => {
    if (nick.trim()) return true;
    setError('Сначала представьтесь — так друзья увидят вас в комнате');
    return false;
  };

  const startTunnel = async () => {
    const d = getDesktop();
    if (!d) return;
    setTunnelBusy(true);
    setTunnelError(null);
    try {
      const res = await d.tunnelStart();
      if (res.ok && res.url) setTunnel({ active: true, url: res.url });
      else setTunnelError(res.error ?? 'Не удалось получить ссылку');
    } catch {
      setTunnelError('Не удалось получить ссылку');
    } finally {
      setTunnelBusy(false);
    }
  };

  const stopTunnel = async () => {
    await getDesktop()?.tunnelStop().catch(() => {});
    setTunnel({ active: false, url: null });
    setTunnelError(null);
  };

  // Подключение к ZeroTier-сети друга: разовый UAC, дальше наш LAN-поиск
  // сам найдёт хоста в виртуальной сети.
  const joinZt = async () => {
    const d = getDesktop();
    const id = ztNetId.trim();
    if (!d || !id) return;
    setZtBusy(true);
    setZtMsg(null);
    try {
      const res = await d.ztJoin(id);
      if (res.ok) {
        setZtMsg('Готово. Если сеть приватная — хост подтверждает ваше устройство на my.zerotier.com (Members → галочка Auth). Через минуту хост найдётся кнопкой «Найти в сети».');
        setTimeout(() => setZtMsg(null), 20000);
      } else {
        setZtMsg(res.error ?? 'Не удалось подключиться к сети');
      }
    } finally {
      setZtBusy(false);
    }
  };

  const createRoom = async (name: string, play?: ReturnType<typeof librarySource>) => {
    const roomName = name.trim();
    if (!roomName || !requireNick()) return;
    try {
      const { id } = await api.createRoom(
        roomName.slice(0, 100), play ? 'all' : controlMode, getClientId(), getClientSecret(),
        play ? undefined : newRoomPassword.trim() || undefined,
        play ? false : newRoomHidden,
      );
      navigate(`/room/${id}`, play ? { state: { play } } : undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать комнату');
    }
  };

  // «Смотреть» в медиатеке: новая комната с этим фильмом — останется только позвать друзей.
  const watchFile = (f: LibraryFile) => {
    void createRoom(f.title, librarySource(f));
  };

  const join = (id: string) => {
    if (!requireNick()) return;
    navigate(`/room/${id}`);
  };

  // Подключение к серверу друга: сначала проверяем, что там живой
  // WatchTogether (fetch с таймаутом), и только потом уходим на его origin —
  // иначе браузер зависает на сером экране мёртвого адреса.
  const [connecting, setConnecting] = useState<string | null>(null);
  const connectAbort = useRef<AbortController | null>(null);
  const connectToHost = async (addr: string) => {
    const url = addr.match(/^https?:\/\//) ? addr : `http://${addr}`;
    const ac = new AbortController();
    connectAbort.current = ac;
    setConnecting(url);
    setError(null);
    try {
      const res = await fetch(`${url}/api/server-info`, {
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(8000)]),
      });
      const info = await res.json().catch(() => null) as { name?: string; httpsPort?: number | null } | null;
      if (!res.ok || info?.name !== 'WatchTogether') throw new Error('not-watchtogether');
      // Приложение сразу идёт на https-порт друга: только там работает микрофон
      // (свой самоподписанный сертификат приложение принимает для адресов в локальной сети).
      const target = new URL(url);
      if (desktop && info.httpsPort && target.protocol === 'http:') {
        const secure = new URL(target.toString());
        secure.protocol = 'https:';
        secure.port = String(info.httpsPort);
        const ok = await fetch(`${secure.origin}/api/server-info`, { signal: AbortSignal.timeout(4000) })
          .then((r) => r.ok).catch(() => false);
        if (ok) { window.location.href = secure.origin; return; }
      }
      window.location.href = url; // сервер жив — переходим на него целиком
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError('Сервер по этому адресу не отвечает. Проверьте адрес и что у друга запущен WatchTogether.');
      }
    } finally {
      setConnecting(null);
      connectAbort.current = null;
    }
  };
  const cancelConnect = () => connectAbort.current?.abort();

  const discover = async () => {
    setDiscovering(true);
    try {
      const { peers } = await api.discover();
      // Себя не показываем: у свежих серверов сравниваем id запуска,
      // у старых (без id) — имя устройства + порт.
      setPeers(peers.filter((p) => {
        if (p.id && serverInfo?.id) return p.id !== serverInfo.id;
        return !(p.name === serverInfo?.deviceName && location.host.endsWith(`:${p.httpPort}`));
      }));
    } catch {
      setPeers([]);
    } finally {
      setDiscovering(false);
    }
  };

  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  const lanLinks = (serverInfo?.addresses ?? []).map((a) => `http://${a}:${port}`);
  const lanSecureLinks = serverInfo?.httpsPort
    ? (serverInfo.addresses ?? []).map((a) => `https://${a}:${serverInfo.httpsPort}`)
    : [];
  const playingNow = rooms.filter((r) => r.state === 'playing').length;

  const tabs: { id: TabId; label: string; hint?: string }[] = [
    { id: 'rooms', label: 'Комнаты', hint: rooms.length ? String(rooms.length) : undefined },
    { id: 'library', label: 'Медиатека' },
    { id: 'access', label: 'Доступ для друзей' },
    { id: 'sources', label: 'Источники' },
  ];

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6">
      {/* шапка: логотип, устройство, ник */}
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-zinc-950 shadow-lg shadow-amber-500/20">
          <PlayIcon size={22} />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-bold leading-tight tracking-tight text-zinc-50">
            WatchTogether
            {serverInfo?.version && (
              <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 align-middle text-xs font-normal text-zinc-400">v{serverInfo.version}</span>
            )}
          </h1>
          <p className="truncate text-xs text-zinc-500">
            {onRemoteHost ? `Сервер друга · ${location.host}` : `Этот компьютер · ${serverInfo?.deviceName ?? 'сервер'}`}
          </p>
        </div>
        {nick && (
          <div className="ml-auto">
            <ProfileMenu
              nick={nick}
              onNickChange={(v) => { setNickname(v); setNick(v); }}
              serverVersion={serverInfo?.version}
            />
          </div>
        )}
      </header>

      {/* первый запуск: знакомство */}
      {!nick && (
        <section className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-transparent p-5">
          <h2 className="text-base font-semibold text-zinc-50">Добро пожаловать! Как вас зовут?</h2>
          <p className="mt-1 text-sm text-zinc-400">Имя увидят друзья в комнате и в чате. Поменять можно в любой момент.</p>
          <div className="mt-3 flex max-w-md gap-2">
            <Input
              autoFocus value={nickDraft} maxLength={32}
              onChange={(e) => setNickDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveNick()}
              placeholder="Например, Макс"
              aria-label="Ваше имя"
            />
            <Button onClick={saveNick} disabled={!nickDraft.trim()}>Продолжить</Button>
          </div>
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>
      )}

      {/* автообновление (десктоп): готово → предложить перезапуск */}
      {update.status === 'ready' && update.version && (
        <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4">
          <p className="min-w-0 flex-1 text-sm text-emerald-200">
            Доступна версия {update.version}. Установка займёт несколько секунд, приложение откроется само.
          </p>
          <Button size="sm" className="shrink-0" onClick={() => { void getDesktop()?.updateInstall(); }}>
            Обновить и перезапустить
          </Button>
        </section>
      )}

      {/* десктоп-приложение, подключённое к чужому серверу: возврат на свой */}
      {onRemoteHost && (
        <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-sky-500/40 bg-sky-500/10 p-4">
          <p className="min-w-0 flex-1 text-sm text-sky-200">
            Вы на сервере друга ({location.host}): здесь его комнаты и его медиатека.
          </p>
          <Button
            variant="outline" size="sm" className="shrink-0"
            onClick={() => { window.location.href = `http://localhost:${desktop!.localPort}/`; }}
          >
            Вернуться к себе
          </Button>
        </section>
      )}

      {/* два главных действия */}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 className="text-base font-semibold text-zinc-50">Новая комната</h2>
          <p className="mt-1 text-sm text-zinc-400">Выберите фильм, позовите друзей — пауза и перемотка общие для всех.</p>
          <div className="mt-4 flex gap-2">
            <Input
              value={newRoom} onChange={(e) => setNewRoom(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createRoom(newRoom)}
              placeholder="Название, напр. «Пятничное кино»"
              aria-label="Название комнаты"
            />
            <Button onClick={() => createRoom(newRoom)} disabled={!newRoom.trim()} className="shrink-0">Создать</Button>
          </div>
          <button
            type="button"
            onClick={() => setShowRoomOptions((s) => !s)}
            aria-expanded={showRoomOptions}
            className="mt-3 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={`transition-transform ${showRoomOptions ? 'rotate-90' : ''}`} aria-hidden>
              <path d="M9 6l6 6-6 6" />
            </svg>
            Пароль и кто управляет
            {(controlMode === 'host' || newRoomPassword || newRoomHidden) && <span className="text-amber-400">· изменено</span>}
          </button>
          {showRoomOptions && (
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
              <fieldset>
                <legend className="mb-1.5 text-xs text-zinc-400">Кто может ставить на паузу и перематывать</legend>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['all', 'Все', 'Удобно для компании друзей'],
                    ['host', 'Только я', 'Остальные просто смотрят'],
                  ] as const).map(([m, label, hint]) => (
                    <button
                      key={m} type="button" onClick={() => setControlMode(m)} aria-pressed={controlMode === m}
                      className={`cursor-pointer rounded-lg border p-2 text-left transition-colors ${
                        controlMode === m ? 'border-amber-500/60 bg-amber-500/10' : 'border-zinc-800 hover:border-zinc-600'
                      }`}
                    >
                      <span className={`block text-sm ${controlMode === m ? 'text-amber-300' : 'text-zinc-200'}`}>{label}</span>
                      <span className="block text-xs text-zinc-500">{hint}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="flex flex-col gap-1.5 text-xs text-zinc-400">
                Пароль (необязательно)
                <Input
                  type="password"
                  value={newRoomPassword} onChange={(e) => setNewRoomPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom(newRoom)}
                  placeholder="Без пароля войдёт любой, у кого есть ссылка"
                />
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
                <input type="checkbox" className="mt-0.5 accent-amber-500" checked={newRoomHidden}
                  onChange={(e) => setNewRoomHidden(e.target.checked)} />
                <span>
                  <span className="text-sm text-zinc-200">Скрыть из списка комнат</span><br />
                  Другие не увидят её на главной — только по ссылке-приглашению.
                </span>
              </label>
            </div>
          )}
        </section>

        <section className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
          <h2 className="text-base font-semibold text-zinc-50">Подключиться к другу</h2>
          <p className="mt-1 text-sm text-zinc-400">Его компьютер в вашей сети — найдём сами. Иначе вставьте адрес или ссылку, которую он прислал.</p>
          <div className="mt-4 flex gap-2">
            <Input
              value={host} onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && host.trim() && connectToHost(host.trim())}
              placeholder="192.168.1.10:9345 или https://…"
              aria-label="Адрес компьютера друга"
            />
            {connecting ? (
              <Button variant="outline" onClick={cancelConnect} className="shrink-0">Отмена</Button>
            ) : (
              <Button variant="outline" onClick={() => host.trim() && connectToHost(host.trim())} disabled={!host.trim()} className="shrink-0">
                Подключиться
              </Button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm" onClick={discover} disabled={discovering} className="-ml-2">
              {discovering ? 'Ищем устройства…' : 'Найти в сети'}
            </Button>
            {peers?.map((p) => {
              // from может оказаться виртуальным адаптером (WSL и т.п.) —
              // берём лучший адрес из ответа, он уже отранжирован.
              const addr = p.addresses?.[0] ?? p.from;
              return (
                <button
                  key={`${p.id ?? p.from}:${p.httpPort}`}
                  type="button"
                  onClick={() => connectToHost(`${addr}:${p.httpPort}`)}
                  className="cursor-pointer rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-300 transition-colors hover:bg-amber-500/20"
                >
                  {p.name && p.name !== 'WatchTogether' ? p.name : addr}
                </button>
              );
            })}
            {peers && peers.length === 0 && !discovering && (
              <span className="text-xs text-zinc-500">Никого не нашли — проверьте, что у друга запущен WatchTogether</span>
            )}
          </div>
          {connecting && (
            <p className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-400" />
              Проверяем {connecting}…
            </p>
          )}
        </section>
      </div>

      {/* вкладки */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40">
        <div role="tablist" aria-label="Разделы" className="flex flex-wrap gap-1 border-b border-zinc-800 px-3 pt-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`cursor-pointer rounded-t-lg border-b-2 px-3 py-2 text-sm transition-colors ${
                tab === t.id ? 'border-amber-500 text-amber-300' : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {t.label}
              {t.hint && <span className="ml-1.5 rounded-full bg-zinc-800 px-1.5 text-xs text-zinc-400">{t.hint}</span>}
            </button>
          ))}
        </div>

        <div className="p-4 sm:p-5" role="tabpanel">
          {/* ── комнаты ── */}
          {tab === 'rooms' && (
            roomsLoaded && rooms.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-zinc-500"><PlayIcon size={22} /></div>
                <p className="text-sm text-zinc-300">Комнат пока нет</p>
                <p className="max-w-sm text-xs text-zinc-500">
                  Создайте комнату выше или откройте «Медиатеку» и нажмите на фильм — комната с ним создастся сама.
                </p>
              </div>
            ) : (
              <>
                {playingNow > 0 && (
                  <p className="mb-3 text-xs text-emerald-300">Сейчас смотрят: {playingNow}</p>
                )}
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {rooms.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button" onClick={() => join(r.id)}
                        className="group flex h-full w-full cursor-pointer flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3.5 text-left transition-colors hover:border-amber-500/50 focus-visible:outline-2 focus-visible:outline-amber-500"
                      >
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{r.name}</span>
                          {r.hidden && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">скрыта</span>}
                          {r.isOwner && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">моя</span>}
                          {r.hasPassword && <span className="text-zinc-500"><LockIcon /></span>}
                        </span>
                        <span className="line-clamp-2 min-h-8 text-xs text-zinc-400">
                          {r.hasPassword ? 'Комната с паролем' : r.video ? (r.video.title ?? r.video.url) : 'Фильм ещё не выбран'}
                        </span>
                        <span className="mt-auto flex items-center gap-2 text-xs text-zinc-500">
                          <span className={`h-2 w-2 rounded-full ${r.state === 'playing' ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                          {r.state === 'playing' ? 'идёт просмотр' : 'на паузе'}
                          <span aria-hidden>·</span>{r.members} уч.
                          <span className="ml-auto">{fmtUpdated(r.updatedAt)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )
          )}

          {/* ── медиатека ── */}
          {tab === 'library' && (
            <LibraryPanel onPlay={watchFile} playLabel="Смотреть в новой комнате" />
          )}

          {/* ── доступ для друзей ── */}
          {tab === 'access' && (
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
                <h3 className="text-sm font-semibold text-zinc-100">Дома, в одной Wi-Fi сети</h3>
                <p className="text-xs text-zinc-400">
                  Телефон, ноутбук, телевизор с браузером — откройте на нём этот адрес. Ничего устанавливать не нужно.
                </p>
                {onRemoteHost ? (
                  <p className="text-xs text-zinc-500">Адреса показывает компьютер, на котором запущен сервер.</p>
                ) : lanLinks.length === 0 ? (
                  <p className="text-xs text-zinc-500">Компьютер не подключён к сети.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {lanLinks.map((link) => (
                      <li key={link} className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200">{link}</code>
                        <Button size="sm" variant="outline" className="shrink-0" onClick={() => flashCopied(link, link)}>
                          {copied === link ? 'Скопировано' : 'Копировать'}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {lanSecureLinks.length > 0 && !onRemoteHost && (
                  <div className="mt-1 flex flex-col gap-1.5 border-t border-zinc-800 pt-2">
                    <p className="text-xs text-zinc-300">С голосовым чатом (браузер даёт микрофон только по https):</p>
                    {lanSecureLinks.map((link) => (
                      <div key={link} className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1.5 text-xs text-emerald-200">{link}</code>
                        <Button size="sm" variant="outline" className="shrink-0" onClick={() => flashCopied(link, link)}>
                          {copied === link ? 'Скопировано' : 'Копировать'}
                        </Button>
                      </div>
                    ))}
                    <p className="text-xs text-zinc-500">
                      Браузер один раз предупредит, что сертификат не проверен, — это ваш компьютер, нажмите «Дополнительно» → «Перейти на сайт».
                    </p>
                  </div>
                )}
                {lanLinks.length > 1 && !onRemoteHost && (
                  <p className="text-xs text-zinc-500">Адресов несколько (Wi-Fi, кабель, VPN) — если первый не открылся, попробуйте следующий.</p>
                )}
              </div>

              <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
                <h3 className="text-sm font-semibold text-zinc-100">Через интернет — ссылкой</h3>
                <p className="text-xs text-zinc-400">
                  Одна кнопка — и у вас ссылка, которую можно отправить другу в мессенджер. Работает с телефона на мобильном интернете.
                </p>
                {!desktop || onRemoteHost ? (
                  <p className="text-xs text-zinc-500">Ссылку создаёт приложение WatchTogether на компьютере-хосте.</p>
                ) : (
                  <>
                    {!tunnel.active ? (
                      <Button size="sm" onClick={startTunnel} disabled={tunnelBusy} className="w-fit">
                        {tunnelBusy ? 'Создаём и проверяем ссылку…' : 'Получить ссылку'}
                      </Button>
                    ) : tunnel.url && (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <code className="min-w-0 flex-1 break-all rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5 text-xs text-emerald-300">
                            {tunnel.url}
                          </code>
                          <Button size="sm" variant="outline" className="shrink-0" onClick={() => flashCopied('tunnel', tunnel.url!)}>
                            {copied === 'tunnel' ? 'Скопировано' : 'Копировать'}
                          </Button>
                        </div>
                        <Button size="sm" variant="ghost" onClick={stopTunnel} className="-ml-2 w-fit">Закрыть доступ</Button>
                      </div>
                    )}
                    {tunnelError && <p className="text-xs text-red-400">{tunnelError}</p>}
                    <p className="text-xs text-zinc-500">
                      Ссылка меняется примерно раз в час — здесь всегда актуальная. Друг один раз увидит страницу Pinggy: нужно нажать «Enter site».
                      Поставьте на комнату пароль — ссылку может открыть любой, у кого она есть.
                    </p>
                  </>
                )}
              </div>

              <div className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
                <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-100">
                  Постоянная компания — ZeroTier
                  {zt?.installed && (
                    <span className={`rounded px-1.5 py-0.5 text-xs font-normal ${zt.running ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                      {zt.running ? 'работает' : 'служба остановлена'}
                    </span>
                  )}
                </h3>
                <p className="text-xs text-zinc-400">
                  Как Hamachi: общая «домашняя сеть» через интернет, без ссылок, которые меняются. Есть для Windows, Android и iPhone.
                </p>
                {!desktop ? (
                  <p className="text-xs text-zinc-500">Настраивается в приложении WatchTogether на компьютере.</p>
                ) : zt && !zt.installed ? (
                  <>
                    <ol className="list-decimal space-y-1 pl-4 text-xs text-zinc-400">
                      <li>Установите ZeroTier One.</li>
                      <li>Хост создаёт сеть на my.zerotier.com и присылает друзьям её ID.</li>
                      <li>Каждый вводит ID здесь.</li>
                    </ol>
                    <Button size="sm" variant="outline" className="w-fit" onClick={() => { void desktop.ztDownload(); }}>
                      Скачать ZeroTier
                    </Button>
                  </>
                ) : zt?.installed ? (
                  <>
                    <div className="flex gap-2">
                      <Input
                        value={ztNetId} onChange={(e) => setZtNetId(e.target.value)}
                        placeholder="ID сети, 16 символов"
                        aria-label="ID сети ZeroTier"
                        className="h-8 text-xs"
                      />
                      <Button size="sm" variant="outline" className="shrink-0" onClick={joinZt} disabled={ztBusy || !ztNetId.trim()}>
                        {ztBusy ? 'Подключаем…' : 'Войти в сеть'}
                      </Button>
                    </div>
                    <p className="text-xs text-zinc-500">Windows спросит права администратора — это нормально. Потом друг найдётся кнопкой «Найти в сети».</p>
                    {ztMsg && <p className="text-xs text-amber-300">{ztMsg}</p>}
                  </>
                ) : (
                  <p className="text-xs text-zinc-500">Проверяем, установлен ли ZeroTier…</p>
                )}
              </div>
            </div>
          )}

          {/* ── источники ── */}
          {tab === 'sources' && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-zinc-400">
                Где искать фильмы. Для RuTracker и LostFilm войдите на сайт — вход сохранится на этом компьютере.
              </p>
              <SettingsPanel />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
