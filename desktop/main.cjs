// WatchTogether — точка входа Electron.
// Поднимает встроенный сервер (Node внутри Electron через ELECTRON_RUN_AS_NODE)
// и открывает окно с клиентом. В packaged-режиме БД лежит в userData —
// комнаты и позиции переживают обновления установщика.
const { app, BrowserWindow, shell, ipcMain, session, desktopCapturer } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');


const PORT = Number(process.env.WT_PORT ?? 9345);
const AUTH_PARTITION = 'persist:wt-auth';

let serverProcess = null;
let mainWindow = null;
let authWindow = null;

function resolvePaths() {
  if (app.isPackaged) {
    return {
      serverCwd: path.join(process.resourcesPath, 'server'),
      serverEntry: path.join(process.resourcesPath, 'server', 'dist', 'index.js'),
      clientDist: path.join(process.resourcesPath, 'client'),
      dbPath: path.join(app.getPath('userData'), 'watchtogether.db'),
    };
  }
  const root = path.join(__dirname, '..');
  return {
    serverCwd: path.join(root, 'server'),
    serverEntry: path.join(root, 'server', 'dist', 'index.js'),
    clientDist: path.join(root, 'app', 'dist'),
    dbPath: path.join(root, 'server', 'watchtogether.db'),
  };
}

function startServer(p) {
  serverProcess = spawn(process.execPath, [p.serverEntry], {
    cwd: p.serverCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WT_PORT: String(PORT),
      WT_CLIENT_DIST: p.clientDist,
      WT_DB_PATH: p.dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => {
    console.log(`[server] завершился с кодом ${code}`);
    serverProcess = null;
  });
}

function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.end(); resolve(); });
      sock.once('error', () => {
        if (Date.now() > deadline) reject(new Error('Сервер не поднялся за 15 с'));
        else setTimeout(tryConnect, 200);
      });
    };
    tryConnect();
  });
}

// Окно трансляции живёт за пределами экрана (x: -32000). Без этих флагов
// Chromium считает его «полностью перекрытым» и останавливает отрисовку,
// а таймеры душит до 1/с — зрители видят белый экран, страницы грузятся
// в десятки раз дольше, чем в обычном браузере. Отключаем и occlusion-
// детекцию Windows (CalculateNativeWinOcclusion), и троттлинг фоновых окон.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0e0c12',
    title: 'WatchTogether',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // Внешние ссылки — в системный браузер, не в окне приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.includes(`localhost:${PORT}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  await mainWindow.loadURL(`http://localhost:${PORT}/`);
}

app.whenReady().then(async () => {
  // Микрофон для голосовой комнаты: разрешаем запросы media без системного диалога.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  // Захват окна трансляции: когда рендерер зовёт getDisplayMedia, отдаём ему
  // заранее найденное окно со стримом + системный звук (loopback, Windows).
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    if (!streamSourceId) return callback({});
    desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        const src = sources.find((s) => s.id === streamSourceId);
        callback(src ? { video: src, audio: 'loopback' } : {});
      })
      .catch(() => callback({}));
  });

  const p = resolvePaths();
  startServer(p);
  try {
    await waitForPort(PORT);
  } catch (err) {
    console.error(err);
    app.quit();
    return;
  }
  registerAuthHandlers();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// --- Авторизация на сайтах провайдеров ---
// Открываем сайт во встроенном окне (отдельная persist-сессия). Когда окно
// закрывают, собираем куки доменов провайдера и отдаём их серверу — повторная
// попытка получить поток пойдёт уже с авторизацией.
async function saveProviderCookies(providerId, pageUrl) {
  const ses = session.fromPartition(AUTH_PARTITION);
  // Домены: хост открытой страницы + все зеркала провайдера (логин мог быть на любом).
  const hosts = new Set([new URL(pageUrl).hostname]);
  try {
    const res = await fetch(`http://localhost:${PORT}/api/providers`);
    const providers = await res.json();
    const prov = providers.find((x) => x.id === providerId);
    for (const m of prov?.config?.mirrors ?? []) hosts.add(new URL(m).hostname);
  } catch { /* зеркала не критичны, хватает хоста страницы */ }

  const all = await ses.cookies.get({});
  const matched = all.filter((c) => {
    const domain = c.domain.replace(/^\./, '');
    return [...hosts].some((h) => h === domain || h.endsWith('.' + domain));
  });
  const header = matched.map((c) => `${c.name}=${c.value}`).join('; ');
  await fetch(`http://localhost:${PORT}/api/providers/${providerId}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies: header }),
  });
  return matched.length;
}

// --- Перехват потока через скрытое окно ---
// Когда статический разбор страницы поток не находит (плееры обфусцированы),
// открываем страницу сериала в скрытом окне, кликаем нужную серию как
// пользователь и слушаем сетевые запросы: реальный плеер сам запросит
// манифест (m3u8/mpd) или mp4 — мы его и отдаём. Окно делит persist-сессию
// с окном авторизации, так что вход на сайт действует и здесь.
let sniffWindow = null;
let sniffBusy = false;

function sniffStream({ pageUrl, season, episode }) {
  return new Promise((resolve) => {
    const ses = session.fromPartition(AUTH_PARTITION);
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      autoHideMenuBar: true,
      title: 'WatchTogether — поиск потока',
      webPreferences: {
        partition: AUTH_PARTITION,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    sniffWindow = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const wc = win.webContents;
    let done = false;
    const candidates = []; // {url, referer, type}
    const typeOf = (u) => (/\.m3u8(\?|#|$)/i.test(u) ? 'hls' : /\.mpd(\?|#|$)/i.test(u) ? 'dash' : 'mp4');

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ses.webRequest.onBeforeRequest(null); } catch { /* noop */ }
      if (!win.isDestroyed()) win.destroy();
      if (sniffWindow === win) sniffWindow = null;
      resolve(result);
    };

    const MEDIA_RE = /\.(m3u8|mpd|mp4)(\?|#|$)/i;
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      try {
        if (!done && details.webContentsId === wc.id && MEDIA_RE.test(details.url)) {
          candidates.push({ url: details.url, referer: details.referrer, type: typeOf(details.url) });
        }
      } catch { /* noop */ }
      cb({});
    });

    // Ждём: плееру нужно время загрузиться и запросить манифест выбранной серии.
    const timer = setTimeout(() => {
      const priority = { hls: 3, dash: 2, mp4: 1 };
      const best = [...candidates].sort((a, b) => priority[b.type] - priority[a.type]);
      const pick = best.find((c) => c.type === 'hls') ?? best[0];
      if (pick) finish({ ok: true, streamUrl: pick.url, referer: pick.referer || '', format: pick.type });
      else finish({ ok: false, error: 'not-found' });
    }, 30000);

    win.loadURL(pageUrl).catch(() => finish({ ok: false, error: 'load-failed' }));
    wc.once('did-finish-load', () => {
      // Кликаем нужную серию в списке — как это делает пользователь на сайте.
      const s = Number(season) || 1;
      const e = Number(episode) || 1;
      const js = `(() => {
        try {
          const seasons = document.querySelectorAll('.episodes-season');
          for (const blk of seasons) {
            const icon = blk.querySelector('.episodes-season__icon');
            if (!icon || icon.textContent.trim() !== '${s}') continue;
            for (const it of blk.querySelectorAll('.episodes-item')) {
              const numEl = it.querySelector('.episodes-item__num');
              if (parseInt(numEl ? numEl.textContent : '', 10) === ${e}) {
                it.click();
                return 'clicked';
              }
            }
          }
          // Запасной путь: выставить атрибуты веб-компонента плеера напрямую.
          const vp = document.querySelector('#cdnvideohubvideoplayer, video-player');
          if (vp) {
            vp.setAttribute('season', '${s}');
            vp.setAttribute('episode', '${e}');
            return 'attrs';
          }
          return 'not-found';
        } catch (err) { return 'error:' + err.message; }
      })()`;
      wc.executeJavaScript(js)
        .then((r) => console.log('[sniff] выбор серии:', r))
        .catch(() => {});
    });
  });
}

function registerAuthHandlers() {
  ipcMain.handle('wt:open-auth', (_e, { providerId, url }) => {
    if (authWindow) {
      authWindow.focus();
      return { opened: false, reason: 'already-open' };
    }
    return new Promise((resolve) => {
      authWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        parent: mainWindow,
        autoHideMenuBar: true,
        title: 'Авторизация — WatchTogether',
        webPreferences: { partition: AUTH_PARTITION },
      });
      // Сторонние ссылки из окна авторизации — в системный браузер.
      authWindow.webContents.setWindowOpenHandler(({ url: u }) => {
        shell.openExternal(u);
        return { action: 'deny' };
      });
      authWindow.on('closed', async () => {
        authWindow = null;
        try {
          const count = await saveProviderCookies(providerId, url);
          resolve({ opened: true, cookiesSaved: count });
        } catch (err) {
          console.error('[auth] не удалось сохранить куки:', err);
          resolve({ opened: true, cookiesSaved: 0 });
        }
      });
      authWindow.loadURL(url);
    });
  });

  ipcMain.handle('wt:clear-auth', async (_e, { providerId }) => {
    const ses = session.fromPartition(AUTH_PARTITION);
    await ses.clearStorageData();
    await fetch(`http://localhost:${PORT}/api/providers/${providerId}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: '' }),
    });
    return { cleared: true };
  });

  ipcMain.handle('wt:sniff-stream', async (_e, { pageUrl, season, episode }) => {
    if (sniffBusy) return { ok: false, error: 'busy' };
    sniffBusy = true;
    try {
      return await sniffStream({ pageUrl, season, episode });
    } catch (err) {
      console.error('[sniff] ошибка:', err);
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      sniffBusy = false;
    }
  });
}

// --- Трансляция сайта ---
// Сайт открывается в окне за пределами экрана: оно рендерится и доступно
// desktopCapturer, но не мешает пользователю. Источник захвата находим по
// маркерному заголовку ДО загрузки страницы (потом сайт перепишет title).
let streamWindow = null;
let streamSourceId = null;

function closeStreamWindow() {
  if (streamWindow && !streamWindow.isDestroyed()) streamWindow.destroy();
  streamWindow = null;
  streamSourceId = null;
}

ipcMain.handle('wt:stream-open', async (_e, { url, playerOnly }) => {
  closeStreamWindow();
  const marker = `WT Stream ${Date.now()}`;
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    x: -32000,
    y: -32000,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    title: marker,
    // Тёмный фон вместо белого: при навигации страница мгновение не нарисована,
    // и без этого зрители видят белую вспышку на каждом переходе.
    backgroundColor: '#0a0a0a',
    webPreferences: { backgroundThrottling: false },
  });
  streamWindow = win;
  win.setMenu(null);
  // Сайты капризничают к UA Electron — маскируемся под обычный десктопный Chrome.
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );
  // Индикатор загрузки страницы → в основное окно; дальше ведущий покажет
  // спиннер у себя и разошлёт состояние зрителям по комнате.
  const sendLoading = (loading, error) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wt:stream-loading', { loading, error });
    }
  };
  win.webContents.on('did-start-loading', () => sendLoading(true));
  win.webContents.on('did-stop-loading', () => sendLoading(false));
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    // -3 (ERR_ABORTED) — это переадресация/отменённый подзапрос, не ошибка страницы.
    if (code !== -3) sendLoading(false, desc || `ошибка ${code}`);
  });
  if (playerOnly) {
    // «Только плеер»: навигация заблокирована, КРОМЕ переходов внутри того же
    // сайта (например youtube.com → consent.youtube.com → обратно на видео).
    // Иначе согласительные редиректы оставляли зрителям вечный белый экран.
    const siteDomain = new URL(url).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
    win.webContents.on('will-navigate', (e, navUrl) => {
      try {
        const h = new URL(navUrl).hostname.replace(/^www\./, '');
        if (h === siteDomain || h.endsWith(`.${siteDomain}`)) return; // внутри сайта — можно
      } catch { /* noop */ }
      e.preventDefault();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } else {
    // Обычный режим (YouTube): переходы открываем в том же окне трансляции.
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (/^https?:/i.test(u)) win.loadURL(u).catch(() => {});
      return { action: 'deny' };
    });
  }
  win.on('closed', () => {
    if (streamWindow === win) { streamWindow = null; streamSourceId = null; }
  });
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources.find((s) => s.name === marker);
  if (!src) {
    closeStreamWindow();
    return { ok: false, error: 'no-source' };
  }
  streamSourceId = src.id;
  win.loadURL(url).catch(() => {});
  return { ok: true };
});

ipcMain.handle('wt:stream-close', () => {
  closeStreamWindow();
  return { ok: true };
});

// Ввод мыши от зрителей: относительные координаты (0..1) → события в окне.
ipcMain.handle('wt:stream-input', (_e, p) => {
  const win = streamWindow;
  if (!win || win.isDestroyed()) return { ok: false };
  const [w, h] = win.getContentSize();
  const x = Math.round((Number(p.x) || 0) * w);
  const y = Math.round((Number(p.y) || 0) * h);
  if (p.kind === 'click') {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  } else if (p.kind === 'wheel') {
    win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.round(Number(p.deltaY) || 0) });
  }
  return { ok: true };
});

// --- Туннель в интернет ---
// Туннель в интернет — Pinggy (SSH-проброс через порт 443, чистый Node через
// ssh2 — внешний ssh.exe не нужен). Бесплатная сессия живёт ~60 минут — при
// обрыве перезапускаем сами и присылаем в UI новую ссылку (wt:tunnel-url).
// Публичная https-ссылка заодно снимает ограничение браузеров на микрофон.
// Cloudflare Quick Tunnel убран (v0.8.0): trycloudflare.com стабильно режется
// DPI/блокировками в РФ и с их стороны — нежизнеспособен.
const { Client: SshClient } = require('ssh2');

let tunnelSsh = null;          // ssh2-клиент (pinggy)
let tunnelUrl = null;
let tunnelProvider = null;     // 'pinggy'
let tunnelWanted = false;      // пользователь хочет активный туннель
let tunnelRestartTimer = null;
let tunnelStartedAt = 0;
let tunnelRetries = 0;         // подряд неудачных попыток поднять туннель

function notifyTunnelUrl() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wt:tunnel-url', { url: tunnelUrl, provider: tunnelProvider });
  }
}

function notifyTunnelDown() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('wt:tunnel-down');
}

function stopTunnel() {
  tunnelWanted = false;
  clearTimeout(tunnelRestartTimer);
  tunnelRestartTimer = null;
  if (tunnelSsh) {
    try { tunnelSsh.end(); } catch { /* уже закрыт */ }
    tunnelSsh = null;
  }
  tunnelUrl = null;
  tunnelProvider = null;
}

// Туннель работал и оборвался — перезапускаем через 4 с (ссылка будет новой).
function scheduleTunnelRestart() {
  if (!tunnelWanted) return;
  clearTimeout(tunnelRestartTimer);
  tunnelRestartTimer = setTimeout(() => { void runTunnel(); }, 4000);
}

// URL от провайдера ≠ рабочий туннель: сервис может напечатать ссылку,
// даже когда трафик уже режется DPI. Проверяем полный путь: сами ходим
// по публичной ссылке до своего же /api/server-info. Заголовок
// X-Pinggy-No-Screen обходит анти-абузную страницу Pinggy (она — только
// для браузеров), нестандартный UA — дополнительная страховка.
async function verifyTunnel(url) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && tunnelWanted) {
    try {
      const res = await fetch(`${url}/api/server-info`, {
        headers: { 'X-Pinggy-No-Screen': '1', 'User-Agent': 'WatchTogether-HealthCheck' },
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      if (res.ok && text.includes('"WatchTogether"')) return true;
    } catch { /* пробуем ещё до дедлайна */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function runPinggy() {
  return new Promise((resolve) => {
    const conn = new SshClient();
    tunnelSsh = conn;
    tunnelProvider = 'pinggy';
    tunnelStartedAt = Date.now();
    let resolved = false;
    const done = (ok) => { if (!resolved) { resolved = true; clearTimeout(timeout); resolve(ok); } };
    const timeout = setTimeout(() => { try { conn.end(); } catch { /* noop */ } done(false); }, 45000);

    conn.on('keyboard-interactive', (_n, _i, _l, _p, cb) => cb([]));
    conn.on('ready', () => {
      // Обратный проброс: сервер слушает автовыбранный порт, трафик приходит сюда.
      conn.forwardIn('127.0.0.1', 0, () => {});
      // Баннер с публичным URL приходит в shell-сессию (вперемешку с ANSI-кодами).
      conn.shell((err, stream) => {
        if (err) return done(false);
        stream.on('data', (d) => {
          const text = String(d).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
          const m = text.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.free\.pinggy\.net/)
            ?? text.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.pinggy-free\.link/);
          if (m) {
            tunnelUrl = m[0];
            done(true);
          }
        });
      });
    });
    // Входящее соединение из туннеля → на локальный сервер.
    conn.on('tcp connection', (_info, accept) => {
      const remote = accept();
      const local = net.connect(PORT, '127.0.0.1');
      remote.pipe(local).pipe(remote);
      remote.on('error', () => local.destroy());
      local.on('error', () => remote.destroy());
    });
    conn.on('error', () => done(false));
    conn.on('close', () => {
      if (tunnelSsh === conn) tunnelSsh = null;
      const hadUrl = resolved && tunnelUrl;
      if (hadUrl) {
        tunnelUrl = null;
        // Перезапуск, только если Pinggy всё ещё текущий провайдер.
        if (tunnelProvider === 'pinggy') scheduleTunnelRestart();
      } else {
        done(false);
      }
    });
    conn.connect({
      host: 'a.pinggy.io',
      port: 443,
      username: 'watchtogether',
      password: 'watchtogether',
      tryKeyboard: true,
      readyTimeout: 30000,
    });
  });
}

// Ссылка считается рабочей только после реальной проверки через туннель.
async function runTunnel() {
  if (!tunnelWanted) return false;
  if (await runPinggy()) {
    if (await verifyTunnel(tunnelUrl)) return true;
    tunnelProvider = null;
    if (tunnelSsh) { try { tunnelSsh.end(); } catch { /* noop */ } }
    tunnelUrl = null;
  }
  return false;
}

ipcMain.handle('wt:tunnel-start', async () => {
  if (tunnelUrl) return { ok: true, url: tunnelUrl, provider: tunnelProvider };
  tunnelWanted = true;
  tunnelRetries = 0;
  clearTimeout(tunnelRestartTimer);
  const ok = await runTunnel();
  if (ok) {
    tunnelRetries = 0;
    notifyTunnelUrl();
    return { ok: true, url: tunnelUrl, provider: tunnelProvider };
  }
  // Провайдер молчит — до 3 фоновых повторов; если поднимется,
  // UI получит wt:tunnel-url, иначе в конце — wt:tunnel-down.
  const retry = () => {
    if (!tunnelWanted) return;
    tunnelRetries += 1;
    if (tunnelRetries > 3) {
      tunnelWanted = false;
      notifyTunnelDown();
      return;
    }
    tunnelRestartTimer = setTimeout(async () => {
      if (await runTunnel()) {
        tunnelRetries = 0;
        notifyTunnelUrl();
      } else {
        retry();
      }
    }, 8000);
  };
  retry();
  return { ok: false, error: 'Туннель не поднялся. Пробуем ещё в фоне — если получится, ссылка появится сама.' };
});

ipcMain.handle('wt:tunnel-stop', () => {
  stopTunnel();
  return { ok: true };
});

ipcMain.handle('wt:tunnel-status', () => ({ active: !!tunnelUrl, url: tunnelUrl, provider: tunnelProvider }));

// ─── ZeroTier (виртуальная LAN «как Hamachi») ───
// Друзья в одной ZeroTier-сети получают общий виртуальный сегмент, и наш
// LAN-поиск сам находит хоста по directed broadcast в этой сети — без
// каких-либо ссылок и туннелей. Здесь только статус установки и join/leave
// через zerotier-cli (ему нужны права администратора → разовый UAC).
const ZT_DIRS = [
  'C:\\Program Files (x86)\\ZeroTier\\One',
  'C:\\Program Files\\ZeroTier\\One',
];
const ZT_SERVICE = 'ZeroTierOneService';

function findZtCli() {
  for (const dir of ZT_DIRS) {
    const cli = path.join(dir, 'zerotier-cli.bat');
    if (fs.existsSync(cli)) return cli;
  }
  return null;
}

function ztServiceState() {
  return new Promise((resolve) => {
    execFile('sc.exe', ['query', ZT_SERVICE], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve('unknown');
      const m = String(stdout).match(/STATE\s*:\s*\d+\s+(\w+)/);
      resolve(m ? m[1].toLowerCase() : 'unknown');
    });
  });
}

ipcMain.handle('wt:zt-status', async () => {
  const cli = findZtCli();
  if (!cli) return { installed: false, running: false };
  const state = await ztServiceState();
  return { installed: true, running: state === 'running' };
});

function ztElevatedCli(args) {
  return new Promise((resolve) => {
    const cli = findZtCli();
    if (!cli) { resolve({ ok: false, error: 'ZeroTier не установлен' }); return; }
    // zerotier-cli требует администратора: разовый запуск через UAC.
    const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(', ');
    const ps = `$p = Start-Process -Verb RunAs -WindowStyle Hidden -Wait -PassThru -FilePath '${cli.replace(/'/g, "''")}' -ArgumentList ${argList}; exit $p.ExitCode`;
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 120000 }, (err) => {
      if (err) resolve({ ok: false, error: 'Команда не выполнена — возможно, отменён запрос прав администратора (UAC)' });
      else resolve({ ok: true });
    });
  });
}

const ZT_NET_ID = /^[0-9a-f]{16}$/;

ipcMain.handle('wt:zt-join', (_e, { networkId }) => {
  const id = String(networkId ?? '').trim().toLowerCase();
  if (!ZT_NET_ID.test(id)) return { ok: false, error: 'ID сети — 16 hex-символов (например 1d71939404a1b2c3)' };
  return ztElevatedCli(['join', id]);
});

ipcMain.handle('wt:zt-leave', (_e, { networkId }) => {
  const id = String(networkId ?? '').trim().toLowerCase();
  if (!ZT_NET_ID.test(id)) return { ok: false, error: 'ID сети — 16 hex-символов' };
  return ztElevatedCli(['leave', id]);
});

ipcMain.handle('wt:zt-download', () => {
  shell.openExternal('https://www.zerotier.com/download/');
  return { ok: true };
});

app.on('window-all-closed', () => {
  closeStreamWindow();
  stopTunnel();
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  closeStreamWindow();
  stopTunnel();
  if (serverProcess) serverProcess.kill();
});
