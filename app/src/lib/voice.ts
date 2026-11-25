// Голосовая комната: WebRTC-меш между участниками, сигналинг через Socket.IO.
// Медиа идёт напрямую между устройствами (в LAN — без сервера), сервер лишь
// знает список участников и пересылает SDP/ICE. Микрофон и «не слышать никого» —
// локальные состояния, наружу уходит только флаг для отображения иконок.
import type { Socket } from 'socket.io-client';

export interface VoicePeerInfo {
  clientId: string;
  nickname: string;
  muted: boolean;
  deafened: boolean;
}

interface SignalPayload {
  from: string;
  data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], // для туннелей; в LAN хватит host-кандидатов
};

export class VoiceManager {
  private pcs = new Map<string, RTCPeerConnection>();
  private audios = new Map<string, HTMLAudioElement>();
  private makingOffer = new Map<string, boolean>();
  private ignoreOffer = new Map<string, boolean>();
  private local: MediaStream | null = null;
  private deafened = false;
  private disposed = false;

  onPeers: (peers: VoicePeerInfo[]) => void = () => {};
  onError: (msg: string) => void = () => {};
  // Изменился набор говорящих прямо сейчас (по уровню звука в потоках).
  onSpeaking: (ids: string[]) => void = () => {};

  private socket: Socket;
  private clientId: string;

  // Измерители громкости: своя микрофония + каждый удалённый поток.
  private audioCtx: AudioContext | null = null;
  private analysers = new Map<string, { analyser: AnalyserNode; speaking: boolean }>();
  private levelTimer: ReturnType<typeof setInterval> | null = null;

  constructor(socket: Socket, clientId: string) {
    this.socket = socket;
    this.clientId = clientId;
    socket.on('voice:peers', this.handlePeers);
    socket.on('voice:signal', this.handleSignal);
  }

  get joined() { return this.local !== null; }

  async join(): Promise<void> {
    if (this.local) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('insecure-context');
    }
    this.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.socket.emit('voice:join');
    // Свой поток тоже меряем — видно, когда говоришь сам.
    this.watchStream(this.clientId, this.local);
  }

  leave(): void {
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
    this.makingOffer.clear();
    this.ignoreOffer.clear();
    for (const a of this.audios.values()) { a.srcObject = null; a.remove(); }
    this.audios.clear();
    this.stopLevelMeter();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.socket.emit('voice:leave');
  }

  setMuted(muted: boolean): void {
    this.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    this.socket.emit('voice:state', { muted });
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    for (const a of this.audios.values()) a.muted = deafened;
    this.socket.emit('voice:state', { deafened });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.leave();
    this.socket.off('voice:peers', this.handlePeers);
    this.socket.off('voice:signal', this.handleSignal);
  }

  // К серверу: SDP/ICE конкретному пиру.
  private send(to: string, data: SignalPayload['data']) {
    this.socket.emit('voice:signal', { to, data });
  }

  // ── Индикатор «кто говорит»: RMS по AnalyserNode каждые 200 мс ──
  private watchStream(id: string, stream: MediaStream) {
    try {
      this.audioCtx ??= new AudioContext();
      void this.audioCtx.resume().catch(() => {});
      const src = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this.analysers.set(id, { analyser, speaking: false });
      if (this.levelTimer === null) {
        this.levelTimer = setInterval(() => this.pollLevels(), 200);
      }
    } catch (e) {
      console.warn('[voice] meter:', e);
    }
  }

  private unwatchStream(id: string) {
    const entry = this.analysers.get(id);
    if (!entry) return;
    try { entry.analyser.disconnect(); } catch { /* noop */ }
    this.analysers.delete(id);
    if (entry.speaking) this.onSpeaking([...this.analysers].filter(([, a]) => a.speaking).map(([k]) => k));
  }

  private pollLevels() {
    const buf = new Uint8Array(512);
    let changed = false;
    for (const [, entry] of this.analysers) {
      entry.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
        n++;
      }
      const rms = Math.sqrt(sum / n);
      // Гистерезис: включается на 0.02, отключается на 0.01 — без мерцания.
      const speaking = entry.speaking ? rms > 0.01 : rms > 0.02;
      if (speaking !== entry.speaking) { entry.speaking = speaking; changed = true; }
    }
    if (changed) {
      const ids: string[] = [];
      for (const [id, entry] of this.analysers) if (entry.speaking) ids.push(id);
      this.onSpeaking(ids);
    }
  }

  private stopLevelMeter() {
    if (this.levelTimer !== null) { clearInterval(this.levelTimer); this.levelTimer = null; }
    for (const [, entry] of this.analysers) {
      try { entry.analyser.disconnect(); } catch { /* noop */ }
    }
    this.analysers.clear();
    this.onSpeaking([]);
  }

  private handlePeers = ({ peers }: { peers: VoicePeerInfo[] }) => {
    this.onPeers(peers);
    if (!this.local) return; // сам не в голосе — соединения не нужны
    const ids = new Set(peers.map((p) => p.clientId).filter((id) => id !== this.clientId));
    // Закрываем соединения с ушедшими
    for (const [id, pc] of this.pcs) {
      if (!ids.has(id)) {
        pc.close();
        this.pcs.delete(id);
        const a = this.audios.get(id);
        if (a) { a.srcObject = null; a.remove(); }
        this.audios.delete(id);
        this.unwatchStream(id);
      }
    }
    // Создаём соединения с новыми (обе стороны создают — glare решает политeness)
    for (const id of ids) {
      if (!this.pcs.has(id)) this.createPeer(id);
    }
  };

  private createPeer(remoteId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pcs.set(remoteId, pc);
    this.makingOffer.set(remoteId, false);
    // Perfect negotiation: «вежливая» сторона (бóльший clientId) уступает
    // при коллизии офферов — применяется в handleSignal.

    for (const track of this.local?.getTracks() ?? []) {
      pc.addTrack(track, this.local!);
    }

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer.set(remoteId, true);
        await pc.setLocalDescription();
        this.send(remoteId, { description: pc.localDescription!.toJSON() });
      } catch (e) {
        console.warn('[voice] negotiationneeded:', e);
      } finally {
        this.makingOffer.set(remoteId, false);
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) this.send(remoteId, { candidate: e.candidate.toJSON() });
    };

    pc.ontrack = (e) => {
      let audio = this.audios.get(remoteId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        this.audios.set(remoteId, audio);
      }
      audio.muted = this.deafened;
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
      this.watchStream(remoteId, e.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
    };

    return pc;
  }

  private handleSignal = async ({ from, data }: SignalPayload) => {
    if (!this.local) return; // сигнал чужого голоса, когда мы не в голосе — игнор
    let pc = this.pcs.get(from);
    if (!pc) pc = this.createPeer(from);
    const polite = this.clientId < from;

    try {
      if (data.description) {
        const desc = data.description;
        const collision =
          desc.type === 'offer' &&
          (this.makingOffer.get(from) || pc.signalingState !== 'stable');
        this.ignoreOffer.set(from, !polite && collision);
        if (this.ignoreOffer.get(from)) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          this.send(from, { description: pc.localDescription!.toJSON() });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!this.ignoreOffer.get(from)) throw e; // rollback-кандидаты отбрасываем
        }
      }
    } catch (e) {
      console.warn('[voice] signal:', e);
    }
  };
}
