// Capture stays active during playback. Browser AEC receives the same AudioContext output.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sum = 0;
    this.count = 0;
    this.position = 0;
    this.index = 0;
    this.energy = 0;
    this.frame = new Int16Array(1280);
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const input = inputs[0]?.[0];
    if (!input) return true;
    const ratio = sampleRate / 16000;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.position++;
      if (this.position >= ratio) {
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.frame[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
        this.energy += value * value;
        this.sum = 0;
        this.count = 0;
        this.position -= ratio;
        if (this.index === this.frame.length) {
          this.port.postMessage(
            { pcm: this.frame.buffer, rms: Math.sqrt(this.energy / this.frame.length) },
            [this.frame.buffer],
          );
          this.frame = new Int16Array(1280);
          this.index = 0;
          this.energy = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
