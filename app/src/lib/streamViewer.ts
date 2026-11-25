// Зритель трансляции сайта: запрашивает поток у ведущего (stream:watch),
// отвечает на оффер, принимает видео/звук, шлёт клики при разрешённом управлении.
// Офферы инициирует только ведущий — зритель всегда отвечает.
import type { Socket } from 'socket.io-client';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
};

interface SignalPayload {
  from: string;
  data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
}

export class StreamViewer {
  private socket: Socket;
  private hostId: string;
  private pc: RTCPeerConnection | null = null;
  private disposed = false;

  onStream: (s: MediaStream | null) => void = () => {};
  onClosed: () => void = () => {};

  constructor(socket: Socket, hostId: string) {
    this.socket = socket;
    this.hostId = hostId;
    socket.on('stream:signal', this.handleSignal);
  }

  watch(): void {
    this.socket.emit('stream:watch');
  }

  sendInput(p: { kind: 'click' | 'wheel'; x: number; y: number; deltaY?: number }): void {
    this.socket.emit('stream:input', p);
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pc?.close();
    this.pc = null;
    this.onStream(null);
    this.socket.off('stream:signal', this.handleSignal);
  }

  private ensurePeer(): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    pc.ontrack = (e) => this.onStream(e.streams[0] ?? null);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('stream:signal', { to: this.hostId, data: { candidate: e.candidate.toJSON() } });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.onStream(null);
        this.onClosed();
      }
    };
    return pc;
  }

  private handleSignal = async ({ from, data }: SignalPayload) => {
    if (this.disposed || from !== this.hostId) return;
    try {
      if (data.description) {
        const pc = this.ensurePeer();
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this.socket.emit('stream:signal', {
            to: this.hostId,
            data: { description: pc.localDescription!.toJSON() },
          });
        }
      } else if (data.candidate && this.pc) {
        await this.pc.addIceCandidate(data.candidate);
      }
    } catch (e) {
      console.warn('[stream-view] signal:', e);
    }
  };
}
