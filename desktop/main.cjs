// WatchTogether — точка входа Electron.
// Поднимает встроенный сервер (Node внутри Electron через ELECTRON_RUN_AS_NODE)
// и открывает окно с клиентом. В packaged-режиме БД лежит в userData —
// комнаты и позиции переживают обновления установщика.
const { app, BrowserWindow, shell, ipcMain, session, desktopCapturer, dialog, safeStorage } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');


const PORT = Number(process.env.WT_PORT ?? 9345);
const AUTH_PARTITION = 'persist:wt-auth';
// Окно трансляции живёт в своей сессии: прокси трансляции не затрагивает
// основное окно, а сайты трансляции не делят куки с клиентом.
const STREAM_PARTITION = 'persist:wt-stream';
const LOCAL_ORIGIN = `http://localhost:${PORT}`;

let serverProcess = null;
let mainWindow = null;
let authWindow = null;
let quitting = false;

// ─── Кто вызывает мост wtDesktop ───
// Подключаясь к чужому серверу, основное окно целиком переходит на его origin,
// а preload-мост остаётся. Поэтому каждый IPC-вызов проверяет, откуда он:
// свой сервер (localhost) — доверяем; чужой — опасные вызовы запрещены,
// а трансляция/вход/прокси требуют явного подтверждения пользователя.
function senderOrigin(e) {
  try { return new URL(e.senderFrame?.url ?? '').origin; } catch { return null; }
}

function isLocalSender(e) {
  return senderOrigin(e) === LOCAL_ORIGIN;
}

const remoteApprovals = new Set(); // `${origin}|${что}` — разрешено до перезапуска

async function confirmRemote(e, key, message, detail) {
  if (isLocalSender(e)) return true;
  const origin = senderOrigin(e);
  if (!origin || origin === 'null') return false;
  const k = `${origin}|${key}`;
  if (remoteApprovals.has(k)) return true;
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['Отмена', 'Разрешить'],
    defaultId: 0,
    cancelId: 0,
    title: 'WatchTogether',
    message,
    detail: `Запрос пришёл от сервера ${origin}.\n\n${detail}\n\nРазрешайте, только если доверяете этому серверу.`,
  });
  if (response !== 1) return false;
  remoteApprovals.add(k);
  return true;
}

// Обработчик только для своего сервера; чужим — denied (без исключения в UI).
function handleLocalOnly(channel, handler, denied = { ok: false, error: 'forbidden' }) {
  ipcMain.handle(channel, (e, ...args) => (isLocalSender(e) ? handler(e, ...args) : denied));
}

function isHttpUrl(u) {
  try { return /^https?:$/.test(new URL(String(u)).protocol); } catch { return false; }
}

function hostOf(u) {
  try { return new URL(String(u)).host; } catch { return String(u); }
}

// Сессиям сайтов (вход, трансляция) — только безобидные разрешения:
// по умолчанию Electron выдаёт любому сайту камеру, микрофон, геолокацию и т.д.
function restrictPermissions(ses, allowed) {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

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

// Ключ шифрования секретов в БД сервера (куки сайтов-провайдеров).
// Сам ключ лежит в userData зашифрованным safeStorage (DPAPI — привязан к
// учётной записи Windows), серверу передаётся через переменную окружения.
let secretKeyCache;
function serverSecretKey() {
  if (secretKeyCache !== undefined) return secretKeyCache;
  secretKeyCache = null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const file = path.join(app.getPath('userData'), 'wt-secret.key');
    if (fs.existsSync(file)) {
      secretKeyCache = safeStorage.decryptString(fs.readFileSync(file));
    } else {
      const key = require('node:crypto').randomBytes(32).toString('base64');
      fs.writeFileSync(file, safeStorage.encryptString(key));
      secretKeyCache = key;
    }
  } catch (err) {
    // Файл ключа испорчен или от другой учётной записи — не перезаписываем его,
    // просто работаем без шифрования (сохранённые входы на сайты придётся повторить).
    console.error('[secret] ключ шифрования недоступен:', err?.message ?? err);
  }
  return secretKeyCache;
}

function startServer(p) {
  const secretKey = serverSecretKey();
  serverProcess = spawn(process.execPath, [p.serverEntry], {
    cwd: p.serverCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WT_PORT: String(PORT),
      WT_CLIENT_DIST: p.clientDist,
      WT_DB_PATH: p.dbPath,
      ...(secretKey ? { WT_SECRET_KEY: secretKey } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => {
    console.log(`[server] завершился с кодом ${code}`);
    serverProcess = null;
    // Сервер упал сам (не выход из приложения) — поднимаем заново,
    // но не чаще 5 раз за минуту, чтобы не крутиться в цикле падений.
    if (quitting) return;
    const now = Date.now();
    serverRestarts = serverRestarts.filter((t) => now - t < 60000);
    if (serverRestarts.length >= 5) {
      console.error('[server] слишком много падений подряд — перезапуск остановлен');
      return;
    }
    serverRestarts.push(now);
    setTimeout(() => { if (!quitting && !serverProcess) startServer(p); }, 1000);
  });
}

let serverRestarts = [];

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
  // Внешние ссылки — в системный браузер, не в окне приложения. Новое окно
  // приложения (с preload-мостом) — только для своего сервера; сравниваем
  // origin целиком (подстрока пропускала https://evil.com/?localhost:9345).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let origin = null;
    try { origin = new URL(url).origin; } catch { /* битая ссылка */ }
    if (origin === LOCAL_ORIGIN) return { action: 'allow' };
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://localhost:${PORT}/`);
}

app.whenReady().then(async () => {
  // Микрофон для голосовой комнаты, буфер обмена и ПОЛНЫЙ ЭКРАН (без него
  // кнопка «во весь экран» молча не работает — Chromium ждёт разрешения,
  // а наш фильтр по умолчанию всё отклонял).
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  const SITE_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
  restrictPermissions(session.fromPartition(STREAM_PARTITION), SITE_PERMISSIONS);
  // Окно трансляции по умолчанию ходит в сеть как браузер — через системный прокси Windows.
  session.fromPartition(STREAM_PARTITION).setProxy({ mode: 'system' }).catch(() => {});
  restrictPermissions(session.fromPartition(AUTH_PARTITION), SITE_PERMISSIONS);

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
  setupAutoUpdate();

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
  ipcMain.handle('wt:open-auth', async (e, { providerId, url } = {}) => {
    if (!isHttpUrl(url) || typeof providerId !== 'string') return { opened: false, reason: 'bad-url' };
    const allowed = await confirmRemote(e, `auth|${hostOf(url)}`,
      'Открыть окно входа на сайт?', `Сайт: ${hostOf(url)}`);
    if (!allowed) return { opened: false, reason: 'denied' };
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
      // Сторонние ссылки из окна авторизации — в системный браузер, только
      // http(s): иные схемы (ms-msdt:, search-ms: и т.п.) — путь к запуску кода.
      authWindow.webContents.setWindowOpenHandler(({ url: u }) => {
        if (isHttpUrl(u)) shell.openExternal(u);
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

  handleLocalOnly('wt:clear-auth', async (_e, { providerId } = {}) => {
    const ses = session.fromPartition(AUTH_PARTITION);
    await ses.clearStorageData();
    await fetch(`http://localhost:${PORT}/api/providers/${providerId}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: '' }),
    });
    return { cleared: true };
  });

  // Перехват потока разрешён и с чужого сервера (гость смотрит серию у друга):
  // окно скрыто, наружу уходит только найденная ссылка на медиа. Но только http(s).
  ipcMain.handle('wt:sniff-stream', async (_e, { pageUrl, season, episode } = {}) => {
    if (!isHttpUrl(pageUrl)) return { ok: false, error: 'bad-url' };
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

ipcMain.handle('wt:stream-open', async (e, { url, playerOnly } = {}) => {
  if (!isHttpUrl(url)) return { ok: false, error: 'bad-url' };
  const allowed = await confirmRemote(e, `stream|${hostOf(url)}`,
    'Начать трансляцию страницы с вашего компьютера?',
    `Страница ${url} откроется в скрытом окне, и её изображение и звук увидят участники комнаты.`);
  if (!allowed) return { ok: false, error: 'denied' };
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
    webPreferences: { backgroundThrottling: false, partition: STREAM_PARTITION },
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

handleLocalOnly('wt:tunnel-start', async () => {
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

handleLocalOnly('wt:tunnel-stop', () => {
  stopTunnel();
  return { ok: true };
});

handleLocalOnly('wt:tunnel-status', () => ({ active: !!tunnelUrl, url: tunnelUrl, provider: tunnelProvider }),
  { active: false, url: null, provider: null });

// Прокси для окна трансляции: у многих VPN — раздельное туннелирование по
// приложениям или вообще расширение браузера, поэтому скрытое окно трансляции
// идёт мимо VPN (YouTube показывает «Нет подключения к интернету»). Хост
// указывает локальный прокси своего VPN-клиента (например socks5://127.0.0.1:10808),
// и страницы трансляции идут через него. Локальные адреса обходят прокси,
// чтобы не ломать связь с нашим сервером и LAN-гостями.
// Значение выбора:
//   'system' (или пусто) — как в Windows/браузере: системный прокси и PAC. По умолчанию.
//   'direct'             — напрямую, мимо любых прокси.
//   'socks5://127.0.0.1:10808' и т.п. — конкретный прокси (одна запись, без PAC).
// Раньше пустая строка превращалась в setProxy({}) = «напрямую»: окно трансляции
// шло мимо системного прокси, через который работает браузер, — отсюда
// «в браузере открывается, в трансляции нет».
const PROXY_RULE = /^(socks5|socks4|socks|http|https):\/\/[a-z0-9.\-[\]:]+:\d{1,5}$/i;
const PROXY_BYPASS = 'localhost;127.0.0.1;<local>;192.168.*;10.*;169.254.*';

function proxyConfigFor(choice) {
  const r = String(choice ?? '').trim();
  if (!r || r === 'system') return { mode: 'system' };
  if (r === 'direct') return { mode: 'direct' };
  if (PROXY_RULE.test(r)) return { mode: 'fixed_servers', proxyRules: r, proxyBypassRules: PROXY_BYPASS };
  return null;
}

ipcMain.handle('wt:set-proxy', async (e, { rules } = {}) => {
  const r = String(rules ?? '').trim();
  const config = proxyConfigFor(r);
  if (!config) return { ok: false, error: 'Формат прокси: socks5://127.0.0.1:10808' };
  // «Как в Windows» и «напрямую» безопасны всегда; конкретный прокси по просьбе
  // чужого сервера — с подтверждением.
  if (config.mode === 'fixed_servers' && !(await confirmRemote(e, `proxy|${r}`,
    'Пустить страницы трансляции через прокси?', `Прокси: ${r}`))) {
    return { ok: false, error: 'denied' };
  }
  try {
    // Только сессия окна трансляции: основное окно и обновления идут как шли.
    await session.fromPartition(STREAM_PARTITION).setProxy(config);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
});

// Поиск прокси в системе (см. proxy-scan.cjs). Только для своего сервера:
// список локальных портов — не дело чужих серверов.
const { scanProxies } = require('./proxy-scan.cjs');
handleLocalOnly('wt:proxy-scan', () => scanProxies({
  ownPids: new Set([process.pid, serverProcess?.pid, ...app.getAppMetrics().map((m) => m.pid)].filter(Boolean)),
  skipPort: PORT,
}), { ok: false, error: 'forbidden', found: [] });

// ─── Проверка: открывается ли YouTube через выбранный вариант ───
let proxyTestSeq = 0;
handleLocalOnly('wt:proxy-test', async (_e, { rules } = {}) => {
  const config = proxyConfigFor(rules);
  if (!config) return { ok: false, error: 'Неверный формат прокси' };
  // Своя временная (не сохраняемая) сессия на каждую проверку — проверки идут параллельно.
  const ses = session.fromPartition(`wt-proxytest-${++proxyTestSeq}`);
  const target = 'https://www.youtube.com/generate_204';
  const started = Date.now();
  try {
    await ses.setProxy(config);
    await ses.closeAllConnections?.();
    const res = await ses.fetch(target, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
    const ms = Date.now() - started;
    return res.status === 204 || res.ok
      ? { ok: true, ms }
      : { ok: false, ms, error: `YouTube ответил HTTP ${res.status}` };
  } catch (err) {
    const msg = String(err?.message ?? err);
    return {
      ok: false,
      ms: Date.now() - started,
      error: /abort|timeout/i.test(msg) ? 'Не ответил за 10 с' : msg.replace(/^net::/, '').slice(0, 120),
    };
  }
}, { ok: false, error: 'forbidden' });

// ─── Автообновления из GitHub Releases ───
// electron-updater смотрит latest.yml релиза MyLitleProger/WatchTogether:
// свежая версия качается в фоне, UI получает событие и предлагает перезапуск.
// Работает только в установленном приложении (в dev-режиме — молча выключено).
let updateState = { status: 'idle', version: null };

function notifyUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wt:update', updateState);
  }
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('[update] electron-updater недоступен:', e?.message ?? e);
    return;
  }
  // Скачиваем в фоне, а ставим только по кнопке «Обновить и перезапустить»:
  // без согласия пользователя обновление не устанавливается (и при выходе тоже).
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => {
    if (updateState.status === 'idle') { updateState = { status: 'checking', version: null }; }
  });
  autoUpdater.on('update-available', (info) => {
    updateState = { status: 'downloading', version: info.version };
    notifyUpdate();
  });
  autoUpdater.on('update-not-available', () => {
    if (updateState.status === 'checking') updateState = { status: 'idle', version: null };
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = { status: 'ready', version: info.version };
    notifyUpdate();
  });
  autoUpdater.on('error', (e) => {
    console.error('[update]', e?.message ?? e);
    updateState = { status: 'error', version: null };
    notifyUpdate();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 4 * 60 * 60 * 1000); // каждые 4 часа
}

ipcMain.handle('wt:update-status', () => updateState);
ipcMain.handle('wt:update-check', async () => {
  if (!app.isPackaged) return { ok: false, error: 'dev' };
  try {
    const { autoUpdater } = require('electron-updater');
    updateState = { status: 'checking', version: null };
    notifyUpdate();
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});
ipcMain.handle('wt:update-install', () => {
  if (updateState.status !== 'ready') return { ok: false, error: 'not-ready' };
  try {
    const { autoUpdater } = require('electron-updater');
    // Тихая установка: quitAndInstall() без аргументов запускает установщик NSIS
    // с окнами мастера. (true, true) = ключ /S (без окон) + --force-run
    // (приложение само запустится после установки, в тот же каталог).
    quitting = true; // сервер гасим без автоперезапуска — его файлы будет заменять установщик
    autoUpdater.quitAndInstall(true, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
});

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

handleLocalOnly('wt:zt-status', async () => {
  const cli = findZtCli();
  if (!cli) return { installed: false, running: false };
  const state = await ztServiceState();
  return { installed: true, running: state === 'running' };
}, { installed: false, running: false });

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

handleLocalOnly('wt:zt-join', (_e, { networkId } = {}) => {
  const id = String(networkId ?? '').trim().toLowerCase();
  if (!ZT_NET_ID.test(id)) return { ok: false, error: 'ID сети — 16 hex-символов (например 1d71939404a1b2c3)' };
  return ztElevatedCli(['join', id]);
});

handleLocalOnly('wt:zt-leave', (_e, { networkId } = {}) => {
  const id = String(networkId ?? '').trim().toLowerCase();
  if (!ZT_NET_ID.test(id)) return { ok: false, error: 'ID сети — 16 hex-символов' };
  return ztElevatedCli(['leave', id]);
});

ipcMain.handle('wt:zt-download', () => {
  shell.openExternal('https://www.zerotier.com/download/');
  return { ok: true };
});

// ─── Медиатека: выбор папки с видео (только для своего сервера) ───
handleLocalOnly('wt:pick-folder', async () => {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const res = await dialog.showOpenDialog(parent, {
    title: 'Папка с видео для медиатеки',
    properties: ['openDirectory'],
  });
  return res.canceled || !res.filePaths[0] ? { ok: false } : { ok: true, path: res.filePaths[0] };
});

// ─── RuTracker: magnet-ссылка → торрент-клиент этого ПК ───
// Только настоящие magnet-ссылки BitTorrent; с чужого сервера — с подтверждением.
const MAGNET_RE = /^magnet:\?xt=urn:btih:[a-z0-9]{32,40}(&[^\s]*)?$/i;
ipcMain.handle('wt:open-magnet', async (e, { magnet, title } = {}) => {
  const m = String(magnet ?? '');
  if (!MAGNET_RE.test(m) || m.length > 8192) return { ok: false, error: 'bad-magnet' };
  const allowed = await confirmRemote(e, `magnet|${m.slice(20, 60)}`,
    'Открыть раздачу в торрент-клиенте?', `Раздача: ${String(title ?? '').slice(0, 200) || 'без названия'}`);
  if (!allowed) return { ok: false, error: 'denied' };
  try {
    await shell.openExternal(m);
    return { ok: true };
  } catch {
    return { ok: false, error: 'no-client' };
  }
});

app.on('window-all-closed', () => {
  quitting = true;
  closeStreamWindow();
  stopTunnel();
  if (serverProcess) serverProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  closeStreamWindow();
  stopTunnel();
  if (serverProcess) serverProcess.kill();
});
