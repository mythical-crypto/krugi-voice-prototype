type CapturedAudio = { pcm: ArrayBuffer; rms: number };

export class AudioSession {
  private context = new AudioContext({ latencyHint: 'interactive' });
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private playback = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private closed = false;
  private muted = false;

  get playing() {
    return this.playback.size > 0;
  }

  async resume() {
    await this.context.resume();
  }

  async openMicrophone(onFrame: (frame: CapturedAudio) => void) {
    const request = navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const stream = await request.then((value) => {
      if (this.closed) {
        for (const track of value.getTracks()) track.stop();
        throw new Error('Запрос микрофона завершён.');
      }
      return value;
    });
    if (this.closed) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('Разговор завершён.');
    }
    this.stream = stream;
    await this.context.audioWorklet.addModule('/pcm-worklet.js');
    if (this.closed) return;
    this.capture = new AudioWorkletNode(this.context, 'pcm-capture');
    this.source = this.context.createMediaStreamSource(stream);
    this.capture.port.onmessage = (event: MessageEvent<CapturedAudio>) => {
      if (!this.closed)
        onFrame(
          this.muted ? { pcm: new ArrayBuffer(event.data.pcm.byteLength), rms: 0 } : event.data,
        );
    };
    this.source.connect(this.capture);
    this.capture.connect(this.context.destination);
  }

  mute(value: boolean) {
    this.muted = value;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !value;
  }

  play(base64: string, sampleRate: number, onIdle: () => void) {
    if (this.closed) return;
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) throw new Error('Получен некорректный аудиофрагмент.');
    const samples = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(1, bytes.length / 2, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) channel[i] = samples.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.playback.add(source);
    const when = Math.max(this.context.currentTime + 0.025, this.nextTime);
    this.nextTime = when + buffer.duration;
    source.onended = () => {
      this.playback.delete(source);
      source.disconnect();
      if (!this.playback.size) onIdle();
    };
    source.start(when);
  }

  interrupt() {
    for (const source of this.playback) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.playback.clear();
    this.nextTime = 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    this.capture?.disconnect();
    this.source?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context.close().catch(() => undefined);
  }
}

export function pcmToBase64(pcm: ArrayBuffer) {
  const bytes = new Uint8Array(pcm);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
