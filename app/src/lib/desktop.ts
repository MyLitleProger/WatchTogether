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
}

export function getDesktop(): WtDesktop | null {
  return (window as unknown as { wtDesktop?: WtDesktop }).wtDesktop ?? null;
}
