export class PracticeTranscript {
  private lines = new Map<string, { speaker: string; text: string }>();
  private question = 0;
  hasAnswer(id: string): boolean { return this.lines.has(`answer:${id}`); }
  answer(id: string, text: string): void {
    if (text.trim()) this.lines.set(`answer:${id}`, { speaker: '我的回答', text: text.trim() });
  }
  ask(text: string): void {
    if (text.trim()) this.lines.set(`question:${++this.question}`, { speaker: 'AI 面试官', text: text.trim() });
  }
  answers(): string {
    return [...this.lines.values()].filter(line => line.speaker === '我的回答').map(line => line.text).join('\n');
  }
  export(): string {
    return [...this.lines.values()].map(line => `${line.speaker}：${line.text}`).join('\n\n');
  }
}

export class PracticeAudio {
  private context = new AudioContext();
  private destination = this.context.createMediaStreamDestination();
  private recorder: MediaRecorder;
  private chunks: Blob[] = [];
  private bytes = 0;
  private mic?: MediaStreamAudioSourceNode;
  private track?: MediaStreamTrack;
  private done: Promise<Blob>;
  constructor(onLimit: () => void) {
    try {
      this.recorder = new MediaRecorder(this.destination.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 });
    } catch (error) {
      void this.context.close().catch(() => {});
      throw error;
    }
    this.done = new Promise(resolve => this.recorder.addEventListener('stop', () =>
      resolve(new Blob(this.chunks, { type: 'audio/webm' })), { once: true }));
    this.recorder.addEventListener('dataavailable', event => {
      if (!event.data.size) return;
      this.bytes += event.data.size;
      if (this.bytes <= 48 * 1024 * 1024) this.chunks.push(event.data);
      else if (this.recorder.state !== 'inactive') { this.recorder.stop(); onLimit(); }
    });
    void this.context.resume().catch(() => {});
    this.recorder.start(1000);
  }
  microphone(track?: MediaStreamTrack): void {
    if (track === this.track) return;
    this.mic?.disconnect();
    this.track = track;
    this.mic = track ? this.context.createMediaStreamSource(new MediaStream([track])) : undefined;
    this.mic?.connect(this.destination);
  }
  question(audio: HTMLAudioElement): () => void {
    if (this.context.state !== 'running' || this.recorder.state === 'inactive') return () => {};
    const source = this.context.createMediaElementSource(audio);
    source.connect(this.context.destination);
    source.connect(this.destination);
    return () => source.disconnect();
  }
  pause(): void { if (this.recorder.state === 'recording') this.recorder.pause(); }
  resume(): void { if (this.recorder.state === 'paused') this.recorder.resume(); }
  async finish(): Promise<Blob> {
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    try { return await this.done; }
    finally { this.mic?.disconnect(); await this.context.close(); }
  }
}
