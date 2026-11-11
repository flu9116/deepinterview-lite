// Resample to 16 kHz mono PCM16, preserving the fractional phase across blocks.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.ratio = sampleRate / 16000; this.phase = 0; this.sum = 0; this.count = 0;
    this.pcm = new Int16Array(1600); this.index = 0;
    this.port.onmessage = event => {
      if (event.data !== 'flush') return;
      if (this.index > 0) {
        this.port.postMessage(this.pcm.buffer, [this.pcm.buffer]);
        this.pcm = new Int16Array(1600); this.index = 0;
      }
      this.port.postMessage({ type: 'flushed' });
    };
  }
  process(inputs, outputs) {
    const channels = inputs[0];
    if (channels?.length) for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      this.sum += sample; this.count++; this.phase++;
      if (this.phase >= this.ratio) {
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.pcm[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
        this.phase -= this.ratio; this.sum = 0; this.count = 0;
        if (this.index === this.pcm.length) {
          this.port.postMessage(this.pcm.buffer, [this.pcm.buffer]);
          this.pcm = new Int16Array(1600); this.index = 0;
        }
      }
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
