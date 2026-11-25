// Ведущий трансляции сайта: захват окна через getDisplayMedia (источник окна
// подставляет Electron main), раздача потока зрителям WebRTC-мешем.
// Только ведущий инициирует офферы — коллизий не бывает.
import type { Socket } from 'socket.io-client';
import { getDesktop } from './desktop';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
};

interface SignalPayload {
  from: string;
  data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
}

export class StreamHost {
  private socket: Socket;
  private pcs = new Map<string, RTCPeerConnection>();
  private stream: MediaStream | null = null;
  private disposed = false;
  private unsubLoading: (() => void) | null = null;

  // Локальный поток захвата — для превью у ведущего.
  onStream: (s: MediaStream) => void = () => {};
  // Захват остановлен из системного UI — надо завершить трансляцию в комнате.
  onEnded: () => void = () => {};

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('stream:watch', this.handleWatch);
    socket.on('stream:signal', this.handleSignal);
    socket.on('stream:input', this.handleInput);
  }

  async start(url: string, playerOnly: boolean): Promise<void> {
    const d = getDesktop();
    if (!d) throw new Error('no-desktop');
    const res = await d.streamOpen(url, playerOnly);
    if (!res.ok) throw new Error(res.error ?? 'no-source');
    // Явно просим 30 fps и полный кадр: без ограничений Chromium может
    // захватывать окно с низкой частотой, и трансляция выглядит слайд-шоу.
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => this.onEnded());
    this.onStream(this.stream);
    // Загрузка страницы в скрытом окне → зрителям, чтобы показать спиннер вместо белого экрана.
    this.unsubLoading = d.onStreamLoading?.((s) => {
      this.socket.emit('stream:loading', { loading: s.loading, error: s.error });
    }) ?? null;
    this.socket.emit('stream:start', { url, title: url, playerOnly });
  }

  stop(): void {
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void getDesktop()?.streamClose();
    this.socket.emit('stream:stop');
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.unsubLoading?.();
    this.unsubLoading = null;
    this.socket.off('stream:watch', this.handleWatch);
    this.socket.off('stream:signal', this.handleSignal);
    this.socket.off('stream:input', this.handleInput);
  }

  private send(to: string, data: SignalPayload['data']) {
    this.socket.emit('stream:signal', { to, data });
  }

  private handleWatch = ({ from }: { from: string }) => {
    if (this.stream) this.createPeer(from);
  };

  // Клики/колесо зрителей → в скрытое окно со страницей.
  private handleInput = (p: { kind: 'click' | 'wheel'; x: number; y: number; deltaY?: number }) => {
    void getDesktop()?.streamInput(p);
  };

  private createPeer(remoteId: string): void {
    if (!this.stream) return;
    this.pcs.get(remoteId)?.close();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pcs.set(remoteId, pc);
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        this.send(remoteId, { description: pc.localDescription!.toJSON() });
      } catch (e) {
        console.warn('[stream] offer:', e);
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send(remoteId, { candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        pc.close();
        this.pcs.delete(remoteId);
      }
    };
  }

  private handleSignal = async ({ from, data }: SignalPayload) => {
    if (this.disposed) return;
    const pc = this.pcs.get(from);
    if (!pc) return;
    try {
      if (data.description) {
        await pc.setRemoteDescription(data.description); // ответ зрителя
      } else if (data.candidate) {
        await pc.addIceCandidate(data.candidate);
      }
    } catch (e) {
      console.warn('[stream] signal:', e);
    }
  };
}
