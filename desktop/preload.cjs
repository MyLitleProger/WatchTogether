// Preload: мост между клиентом (веб) и Electron main.
// window.wtDesktop.openAuth(providerId, url) — открыть встроенное окно входа
// на сайт провайдера; после закрытия окна куки сессии уходят на сервер.
// window.wtDesktop.sniffStream({pageUrl, season, episode}) — открыть страницу
// сериала в скрытом окне, выбрать серию и перехватить сетевой запрос плеера
// (m3u8/mpd/mp4) — работает даже с обфусцированными плеерами.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wtDesktop', {
  isDesktop: true,
  openAuth: (providerId, url) => ipcRenderer.invoke('wt:open-auth', { providerId, url }),
  clearAuth: (providerId) => ipcRenderer.invoke('wt:clear-auth', { providerId }),
  sniffStream: (opts) => ipcRenderer.invoke('wt:sniff-stream', opts),
  streamOpen: (url, playerOnly) => ipcRenderer.invoke('wt:stream-open', { url, playerOnly }),
  streamClose: () => ipcRenderer.invoke('wt:stream-close'),
  streamInput: (payload) => ipcRenderer.invoke('wt:stream-input', payload),
  // События загрузки страницы трансляции: {loading: boolean, error?: string}.
  // Возвращает функцию отписки.
  onStreamLoading: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('wt:stream-loading', listener);
    return () => ipcRenderer.removeListener('wt:stream-loading', listener);
  },
  tunnelStart: () => ipcRenderer.invoke('wt:tunnel-start'),
  tunnelStop: () => ipcRenderer.invoke('wt:tunnel-stop'),
  tunnelStatus: () => ipcRenderer.invoke('wt:tunnel-status'),
  // ZeroTier («Hamachi-style» виртуальная LAN): статус установки/сервиса,
  // подключение к сети по ID (запросит права администратора через UAC),
  // открытие страницы загрузки во внешнем браузере.
  ztStatus: () => ipcRenderer.invoke('wt:zt-status'),
  ztJoin: (networkId) => ipcRenderer.invoke('wt:zt-join', { networkId }),
  ztLeave: (networkId) => ipcRenderer.invoke('wt:zt-leave', { networkId }),
  ztDownload: () => ipcRenderer.invoke('wt:zt-download'),
  // Прокси для страниц трансляции (YouTube и пр. через VPN с раздельным
  // туннелированием): 'socks5://127.0.0.1:10808' или '' — отключить.
  setProxy: (rules) => ipcRenderer.invoke('wt:set-proxy', { rules }),
  // Автообновления из GitHub Releases.
  updateStatus: () => ipcRenderer.invoke('wt:update-status'),
  updateCheck: () => ipcRenderer.invoke('wt:update-check'),
  updateInstall: () => ipcRenderer.invoke('wt:update-install'),
  // Событие смены статуса обновления: {status, version}. Возвращает отписку.
  onUpdate: (cb) => {
    const listener = (_e, s) => cb(s);
    ipcRenderer.on('wt:update', listener);
    return () => ipcRenderer.removeListener('wt:update', listener);
  },
  // Порт встроенного сервера на ЭТОМ компьютере — чтобы вернуться на свой
  // сервер после подключения к чужому (клиент переходит целиком на хост).
  localPort: Number(process.env.WT_PORT ?? 9345),
  // Туннель оборвался сам (сеть/DPI), не по кнопке «Закрыть доступ». Возвращает отписку.
  onTunnelDown: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('wt:tunnel-down', listener);
    return () => ipcRenderer.removeListener('wt:tunnel-down', listener);
  },
  // Туннель (пере)поднялся с новой ссылкой: {url, provider}. Возвращает отписку.
  onTunnelUrl: (cb) => {
    const listener = (_e, s) => cb(s);
    ipcRenderer.on('wt:tunnel-url', listener);
    return () => ipcRenderer.removeListener('wt:tunnel-url', listener);
  },
});
