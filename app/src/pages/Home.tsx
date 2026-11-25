// Главная: ник в шапке, создание комнаты, компактный список комнат,
// подключение к устройствам (LAN-поиск или адрес туннеля), настройки источников.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, type RoomSummary } from '@/lib/api';
import { getClientId, getNickname, setNickname } from '@/lib/identity';
import { getDesktop } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPanel } from '@/components/SettingsPanel';

interface Peer { id?: string; name: string; httpPort: number; from: string; addresses?: string[] }

// «сегодня 18:42», «вчера», «12 нояб» — компактно для списка комнат.
function fmtUpdated(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `сегодня ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export default function Home() {
  const navigate = useNavigate();
  const [nick, setNick] = useState(getNickname());
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [newRoom, setNewRoom] = useState('');
  const [newRoomPassword, setNewRoomPassword] = useState('');
  const [controlMode, setControlMode] = useState<'all' | 'host'>('all');
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [serverInfo, setServerInfo] = useState<{ deviceName?: string; addresses?: string[]; id?: string; version?: string } | null>(null);
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
  const onRemoteHost = !!getDesktop()
    && !['localhost', '127.0.0.1'].includes(location.hostname);

  const reloadRooms = useCallback(() => {
    api.listRooms().then(setRooms).catch(() => setRooms([]));
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
      setTunnelError('Туннель не смог подняться через Pinggy. Попробуйте позже или используйте ZeroTier ниже.');
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
  // Страховочный опрос статуса — вдруг событие пропустили (свершаем состояние с main).
  useEffect(() => {
    const d = getDesktop();
    if (!d) return;
    const t = setInterval(() => { d.tunnelStatus().then(setTunnel).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, []);

  const startTunnel = async () => {
    const d = getDesktop();
    if (!d) return;
    setTunnelBusy(true);
    setTunnelError(null);
    try {
      const res = await d.tunnelStart();
      if (res.ok && res.url) setTunnel({ active: true, url: res.url });
      else setTunnelError(res.error ?? 'Не удалось поднять туннель');
    } catch {
      setTunnelError('Не удалось поднять туннель');
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
        setZtMsg('Готово. Если сеть приватная — попросите хоста подтвердить ваше устройство на my.zerotier.com (Members → галочка Auth). Через минуту хост появится в списке «Устройства в сети» выше.');
        setTimeout(() => setZtMsg(null), 20000);
      } else {
        setZtMsg(res.error ?? 'Не удалось подключиться к сети');
      }
    } finally {
      setZtBusy(false);
    }
  };

  const createRoom = async () => {
    const name = newRoom.trim();
    if (!name) return;
    if (!nick.trim()) { setError('Сначала укажите ник'); return; }
    setNickname(nick);
    try {
      const { id } = await api.createRoom(name, controlMode, getClientId(), newRoomPassword.trim() || undefined);
      navigate(`/room/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать комнату');
    }
  };

  const join = (id: string) => {
    if (!nick.trim()) { setError('Сначала укажите ник'); return; }
    setNickname(nick);
    navigate(`/room/${id}`);
  };

  // Подключение к серверу друга: сначала проверяем, что там живой
  // WatchTogether (fetch с таймаутом), и только потом уходим на его origin —
  // иначе браузер зависает на сером экране мёртвого адреса до перезапуска.
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
      const text = await res.text();
      if (!res.ok || !text.includes('"WatchTogether"')) throw new Error('not-watchtogether');
      window.location.href = url; // сервер жив — переходим на него целиком
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError('Сервер по этому адресу не отвечает. Проверьте адрес и что у друга запущено приложение (и та же версия).');
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

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-5 px-4 py-6">
      {/* шапка: логотип + ник одной строкой */}
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500 text-zinc-950">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-bold leading-tight tracking-tight text-zinc-50">
            WatchTogether
            {serverInfo?.version && (
              <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 align-middle text-xs font-normal text-zinc-400">v{serverInfo.version}</span>
            )}
          </h1>
          <p className="truncate text-xs text-zinc-500">
            {serverInfo?.deviceName ?? 'Совместный просмотр'}
            {serverInfo?.addresses?.[0] ? ` · http://${serverInfo.addresses[0]}:${location.port}` : ''}
          </p>
        </div>
        <div className="ml-auto w-44">
          <Input
            id="nick" value={nick} maxLength={32}
            onChange={(e) => { setNick(e.target.value); setNickname(e.target.value); }}
            placeholder="Ваш ник"
            aria-label="Ваш ник"
          />
        </div>
      </header>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* баннер автообновления (десктоп): готово → предложить перезапуск */}
      {update.status === 'ready' && update.version && (
        <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4">
          <p className="min-w-0 flex-1 text-sm text-emerald-200">
            Готово обновление до версии {update.version} — скачано, осталось перезапустить.
          </p>
          <Button size="sm" className="shrink-0" onClick={() => { void getDesktop()?.updateInstall(); }}>
            Обновить и перезапустить
          </Button>
        </section>
      )}
      {update.status === 'downloading' && update.version && (
        <p className="text-xs text-zinc-500">Качаем обновление {update.version} в фоне…</p>
      )}

      {/* десктоп-приложение, подключённое к чужому серверу: возврат на свой */}
      {onRemoteHost && (
        <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-sky-500/40 bg-sky-500/10 p-4">
          <p className="min-w-0 flex-1 text-sm text-sky-200">
            Вы подключены к чужому серверу ({location.host}) — это его комнаты и его туннель.
          </p>
          <Button
            variant="outline" size="sm" className="shrink-0"
            onClick={() => { window.location.href = `http://localhost:${getDesktop()!.localPort}/`; }}
          >
            Вернуться к моему серверу
          </Button>
        </section>
      )}

      {/* создать комнату */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newRoom} onChange={(e) => setNewRoom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createRoom()}
            placeholder="Название комнаты, напр. «Пятничный киносеанс»"
            aria-label="Название комнаты"
          />
          <Button onClick={createRoom} disabled={!newRoom.trim()} className="shrink-0">Создать</Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border border-zinc-700 text-xs">
            {(['all', 'host'] as const).map((m) => (
              <button
                key={m} type="button" onClick={() => setControlMode(m)}
                className={`cursor-pointer px-2.5 py-1.5 transition-colors ${
                  controlMode === m ? 'bg-amber-500 text-zinc-950' : 'text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                {m === 'all' ? 'Все управляют' : 'Только хост'}
              </button>
            ))}
          </div>
          <Input
            type="password"
            value={newRoomPassword} onChange={(e) => setNewRoomPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createRoom()}
            placeholder="Пароль (необязательно)"
            aria-label="Пароль комнаты (необязательно)"
            className="h-8 flex-1 text-xs sm:max-w-52"
          />
        </div>
      </section>

      {/* комнаты этого сервера — самая свежая сверху */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-300">Комнаты на этом сервере</h2>
        {rooms.length === 0 ? (
          <p className="text-sm text-zinc-500">Пока пусто — создайте первую комнату.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {rooms.map((r) => (
              <li key={r.id}>
                <button
                  type="button" onClick={() => join(r.id)}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 text-left transition-colors hover:border-amber-500/50 focus-visible:outline-2 focus-visible:outline-amber-500"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${
                    r.state === 'playing' ? 'bg-emerald-400' : 'bg-zinc-600'
                  }`} title={r.state === 'playing' ? 'Идёт просмотр' : 'Пауза'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-100">{r.name}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {r.video ? (r.video.title ?? r.video.url) : 'Видео не выбрано'}
                      {' · '}{r.members} уч. · {fmtUpdated(r.updatedAt)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-amber-400/80">→</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* подключение к другому устройству — одной строкой */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={host} onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && host.trim() && connectToHost(host.trim())}
            placeholder="Адрес хоста: 192.168.1.10:9345 или из туннеля"
            aria-label="Адрес хоста"
          />
          <div className="flex shrink-0 gap-2">
            {connecting ? (
              <Button variant="outline" onClick={cancelConnect} className="shrink-0">
                ✕ Отмена
              </Button>
            ) : (
              <Button variant="outline" onClick={() => host.trim() && connectToHost(host.trim())} disabled={!host.trim()}>
                Подключиться
              </Button>
            )}
            <Button variant="outline" onClick={discover} disabled={discovering} title="Поиск устройств в локальной сети">
              {discovering ? 'Поиск…' : 'Найти в сети'}
            </Button>
          </div>
        </div>
        {connecting && (
          <p className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-400" />
            Проверяем {connecting} … если адрес мёртвый — просто нажмите «Отмена».
          </p>
        )}
        {peers.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {peers.map((p) => {
              // from может оказаться виртуальным адаптером (WSL и т.п.) —
              // берём лучший LAN-адрес из ответа, он уже отранжирован.
              const addr = p.addresses?.[0] ?? p.from;
              return (
                <li key={`${p.id ?? p.from}:${p.httpPort}`}>
                  <button
                    type="button"
                    onClick={() => connectToHost(`${addr}:${p.httpPort}`)}
                    className="cursor-pointer rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-300 transition-colors hover:bg-amber-500/20"
                  >
                    {p.name && p.name !== 'WatchTogether' ? `${p.name} · ` : ''}{addr}:{p.httpPort}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* доступ из интернета через туннель (только десктоп, только свой сервер) */}
      {getDesktop() && !onRemoteHost && (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-zinc-300">Доступ из интернета</h2>
              <p className="mt-0.5 text-xs text-zinc-500">
                Туннель через Pinggy до вашего сервера — без своего VPS, аккаунта и статического IP.
                По https-ссылке у гостей заработает и микрофон в браузере. Ссылку откроет любой,
                у кого она есть — ставьте пароли на комнаты. Для постоянной компании удобнее
                виртуальная сеть ZeroTier — блок ниже.
              </p>
            </div>
            {!tunnel.active ? (
              <Button variant="outline" size="sm" onClick={startTunnel} disabled={tunnelBusy} className="shrink-0">
                {tunnelBusy ? 'Поднимаем и проверяем…' : 'Открыть доступ'}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={stopTunnel} className="shrink-0">Закрыть доступ</Button>
            )}
          </div>
          {tunnelError && <p className="mt-2 text-xs text-red-400">{tunnelError}</p>}
          {tunnel.active && tunnel.url && (
            <div className="mt-2 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-1.5 text-xs text-emerald-300">
                  {tunnel.url}
                </code>
                <Button
                  size="sm" variant="outline" className="shrink-0"
                  onClick={() => { navigator.clipboard?.writeText(tunnel.url!).catch(() => {}); }}
                >
                  Копировать
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                Работает через Pinggy. У гостей один раз появится страница предупреждения Pinggy — нужно нажать «Enter site». Ссылка обновляется примерно раз в час: здесь она сменится сама, гостям отправляйте свежую.
              </p>
            </div>
          )}
        </section>
      )}

      {/* виртуальная сеть ZeroTier («как Hamachi», работает в РФ, есть Android/iOS) */}
      {getDesktop() && (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-zinc-300">
                Виртуальная сеть ZeroTier
                {zt?.installed && (
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-normal ${zt.running ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                    {zt.running ? 'запущен' : 'установлен, служба не запущена'}
                  </span>
                )}
              </h2>
              <p className="mt-0.5 text-xs text-zinc-500">
                Аналог Hamachi: общая виртуальная локальная сеть поверх интернета. Работает на ПК
                и телефонах (Android/iOS), не заблокирован в РФ. Устройства в одной сети сами
                находят друг друга в списке «Устройства в сети» выше — без ссылок и туннелей.
              </p>
            </div>
            {zt && !zt.installed && (
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => { void getDesktop()?.ztDownload(); }}>
                Скачать ZeroTier
              </Button>
            )}
          </div>

          {zt && !zt.installed && (
            <p className="mt-2 text-xs text-zinc-500">
              Установите ZeroTier One на этом ПК — после установки этот блок покажет статус службы.
              Хост один раз создаёт сеть на <span className="text-zinc-400">my.zerotier.com</span> (кнопка «Create A Network»)
              и диктует друзьям её ID — 16 символов.
            </p>
          )}

          {zt?.installed && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex max-w-xl items-center gap-2">
                <Input
                  value={ztNetId}
                  onChange={(e) => setZtNetId(e.target.value)}
                  placeholder="ID сети ZeroTier (16 символов, напр. 1d71939404a1b2c3)"
                  aria-label="ID сети ZeroTier"
                />
                <Button variant="outline" size="sm" className="shrink-0" onClick={joinZt} disabled={ztBusy || !ztNetId.trim()}>
                  {ztBusy ? 'Подключаем…' : 'Подключиться к сети'}
                </Button>
              </div>
              <p className="text-xs text-zinc-500">
                Windows спросит права администратора (UAC) — это нужно zerotier-cli.
                Хосту: создайте сеть на my.zerotier.com и подтверждайте новые устройства в разделе Members.
              </p>
              {ztMsg && <p className="text-xs text-amber-300">{ztMsg}</p>}
            </div>
          )}
        </section>
      )}

      {/* источники */}
      <section>
        <button
          type="button"
          onClick={() => setShowSettings((s) => !s)}
          aria-expanded={showSettings}
          className="mb-2 flex cursor-pointer items-center gap-2 text-sm font-semibold text-zinc-300 transition-colors hover:text-amber-300"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={`transition-transform ${showSettings ? 'rotate-90' : ''}`} aria-hidden>
            <path d="M9 6l6 6-6 6"/>
          </svg>
          Источники контента
        </button>
        {showSettings && <SettingsPanel />}
      </section>
    </div>
  );
}
