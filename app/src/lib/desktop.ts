// Мост к Electron-обёртке (preload.cjs). В браузере window.wtDesktop отсутствует.
export interface SniffResult {
  ok: boolean;
  streamUrl?: string;
  referer?: string;
  format?: 'hls' | 'dash' | 'mp4';
  error?: string;
}

export interface WtDesktop {
  isDesktop: true;
  // Порт встроенного сервера на этом компьютере (для возврата на свой сервер).
  localPort: number;
  openAuth(providerId: string, url: string): Promise<{ opened: boolean; cookiesSaved?: number; reason?: string }>;
  clearAuth(providerId: string): Promise<{ cleared: boolean }>;
  sniffStream(opts: { pageUrl: string; season: number; episode: number }): Promise<SniffResult>;
  // Трансляция сайта: скрытое окно → захват через getDisplayMedia в рендерере.
  streamOpen(url: string, playerOnly: boolean): Promise<{ ok: boolean; error?: string }>;
  streamClose(): Promise<{ ok: boolean }>;
  streamInput(payload: { kind: 'click' | 'wheel'; x: number; y: number; deltaY?: number }): Promise<{ ok: boolean }>;
  // События загрузки страницы трансляции (только на машине ведущего). Возвращает отписку.
  onStreamLoading(cb: (state: { loading: boolean; error?: string }) => void): () => void;
  // Туннель в интернет (Pinggy): публичная https-ссылка на сервер.
  tunnelStart(): Promise<{ ok: boolean; url?: string; provider?: string; error?: string }>;
  tunnelStop(): Promise<{ ok: boolean }>;
  tunnelStatus(): Promise<{ active: boolean; url: string | null; provider?: string | null }>;
  // Туннель оборвался сам (не по кнопке). Возвращает функцию отписки.
  onTunnelDown(cb: () => void): () => void;
  // Туннель (пере)поднялся с новой ссылкой. Возвращает функцию отписки.
  onTunnelUrl(cb: (s: { url: string; provider: string }) => void): () => void;
  // ZeroTier (виртуальная LAN «как Hamachi»).
  ztStatus(): Promise<{ installed: boolean; running: boolean }>;
  ztJoin(networkId: string): Promise<{ ok: boolean; error?: string }>;
  ztLeave(networkId: string): Promise<{ ok: boolean; error?: string }>;
  ztDownload(): Promise<{ ok: boolean }>;
  // Медиатека: системный диалог выбора папки.
  pickFolder?(): Promise<{ ok: boolean; path?: string }>;
  // RuTracker: magnet → торрент-клиент этого ПК (error: 'no-client' — клиент не установлен).
  openMagnet?(magnet: string, title?: string): Promise<{ ok: boolean; error?: string }>;
  // Прокси для страниц трансляции: 'socks5://127.0.0.1:10808' или '' — выкл.
  setProxy(rules: string): Promise<{ ok: boolean; error?: string }>;
  // Поиск прокси: настройки Windows (их использует браузер) + найденные локальные прокси.
  proxyScan?(): Promise<ProxyScanResult>;
  // Проверка выбора ('system' | 'direct' | 'socks5://…'): открывается ли YouTube и за сколько.
  proxyTest?(rules: string): Promise<{ ok: boolean; ms?: number; error?: string }>;
  // Автообновления из GitHub Releases.
  updateStatus(): Promise<{ status: string; version: string | null }>;
  updateCheck(): Promise<{ ok: boolean; error?: string }>;
  updateInstall(): Promise<void>;
  // Смена статуса обновления: idle | checking | downloading | ready | error.
  onUpdate(cb: (s: { status: string; version: string | null }) => void): () => void;
}

export interface FoundProxy {
  port: number;
  pid: number;
  process: string;
  label: string | null;   // «V2Ray / Xray», «Clash»… по имени программы
  type: 'socks5' | 'http';
  auth: boolean;          // требует логин/пароль — так не подойдёт
  rules: string;          // готовое правило: socks5://127.0.0.1:10808
  isSystem: boolean;      // этот же прокси указан в настройках Windows
}

export interface ProxyScanResult {
  ok: boolean;
  error?: string;
  system?: { enabled: boolean; server: string | null; pac: string | null; rules: string | null };
  found: FoundProxy[];
}

export function getDesktop(): WtDesktop | null {
  return (window as unknown as { wtDesktop?: WtDesktop }).wtDesktop ?? null;
}
