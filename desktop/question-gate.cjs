function localQuestionState(text) {
  const value = text.replace(/\s/g, '').replace(/[。.!！?？]+$/, '');
  if (!value) return 'incomplete';
  if (/(?:ですか|ますか|でしょうか|ください|下さい|お願いします|お願いできますか|いただけますか|か教えて|请介绍|请说明|请谈谈|吗|呢)$/.test(value)) return 'complete';
  if (/(?:志望動機|転職理由|希望年収|入社可能時期|自己紹介)(?:について)?(?:を)?(?:お)?伺います$/.test(value)) return 'complete';
  if (/(?:について|に関して)(?:少し|詳しく)?(?:お)?(?:伺います|聞きます|聞かせていただきます|質問します)$/.test(value)) return 'intro';
  if (/(?:が|を|に|と|の|ので|から|けれど|けれども|ですが|そのうえで|について|場合は|たとえば|例えば|具体的には)$/.test(value)) return 'incomplete';
  return 'uncertain';
}

class QuestionGate {
  constructor({ getText, hasInterim, onReady, onCancel, onDecision, classify, timing = {} }) {
    Object.assign(this, { getText, hasInterim, onReady, onCancel, onDecision, classify });
    this.timing = { quiet: 1100, settle: 650, intro: 4500, uncertain: 2500, incomplete: 7000, ...timing };
    this.version = 0; this.latestWordEnd = -1; this.lastVoiceAt = 0; this.lastTextAt = 0;
    this.lastText = ''; this.timer = null; this.pending = null; this.closed = false;
  }
  invalidate() {
    this.version++;
    this.pending = null;
    this.classifyController?.abort();
    this.onCancel?.();
  }
  voice() {
    const now = Date.now();
    if (this.pending || now - this.lastVoiceAt > 250) this.invalidate();
    this.lastVoiceAt = now;
    this.schedule();
  }
  update(text, wordEnd) {
    if (Number.isFinite(wordEnd)) this.latestWordEnd = Math.max(this.latestWordEnd, wordEnd);
    if (text !== this.lastText) {
      this.invalidate(); this.lastText = text; this.lastTextAt = Date.now();
    }
    this.schedule();
  }
  boundary(lastWordEnd) {
    if (lastWordEnd === -1 || (Number.isFinite(lastWordEnd) && lastWordEnd + 0.05 < this.latestWordEnd)) {
      this.onDecision?.({ reason: 'stale-boundary-ignored', lastWordEnd, latestWordEnd: this.latestWordEnd });
      return;
    }
    this.schedule();
  }
  schedule(delay = 50) {
    if (this.closed || this.pending || this.timer || !this.getText()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check().catch(() => {
        this.onDecision?.({ reason: 'question-check-failed' });
      });
    }, Math.max(1, delay));
  }
  async check() {
    if (this.closed || this.pending) return;
    const text = this.getText();
    if (!text) return;
    const now = Date.now();
    const quiet = now - Math.max(this.lastVoiceAt, this.lastTextAt);
    if (this.hasInterim()) {
      if (quiet < this.timing.incomplete) this.schedule(200);
      else this.onDecision?.({ reason: 'waiting-for-final-transcript' });
      return;
    }
    if (quiet < this.timing.quiet) { this.schedule(this.timing.quiet - quiet); return; }
    const version = this.version;
    let state = localQuestionState(text);
    if (state === 'uncertain') {
      if (this.classifiedText === text) state = this.classifiedState;
      else {
        if (this.classifyingText === text) return;
        this.classifyingText = text;
        this.classifyController = new AbortController();
        const controller = this.classifyController;
        try { state = await this.classify(text, this.classifyController.signal); }
        catch { state = 'uncertain'; }
        finally { if (this.classifyController === controller) this.classifyingText = null; }
        if (version !== this.version || this.closed) return;
        if (!['intro', 'incomplete', 'complete', 'uncertain'].includes(state)) state = 'uncertain';
        this.classifiedText = text; this.classifiedState = state;
      }
    }
    if (version !== this.version || this.closed) return;
    const elapsed = Date.now() - Math.max(this.lastVoiceAt, this.lastTextAt);
    const threshold = state === 'intro' ? this.timing.intro : state === 'uncertain' ? this.timing.uncertain : this.timing.quiet;
    if (state === 'incomplete') {
      if (elapsed < this.timing.incomplete) this.schedule(this.timing.incomplete - elapsed);
      else this.onDecision?.({ reason: 'incomplete-question-held', text });
      return;
    }
    if (elapsed < threshold || Date.now() - this.lastTextAt < this.timing.settle) {
      this.schedule(Math.max(threshold - elapsed, this.timing.settle - (Date.now() - this.lastTextAt)));
      return;
    }
    this.pending = { version, text, reason: state === 'intro' ? 'intro-wait-limit' : state };
    this.onDecision?.({ reason: 'question-ready', state, waitedMs: elapsed });
    this.onReady(this.pending);
  }
  isCurrent(token) { return !this.closed && token?.version === this.version && this.pending === token; }
  accept(token) {
    if (!this.isCurrent(token)) return false;
    this.pending = null; this.lastText = ''; this.classifiedText = '';
    clearTimeout(this.timer); this.timer = null;
    return true;
  }
  reset() {
    this.invalidate(); clearTimeout(this.timer); this.timer = null;
    this.lastText = ''; this.lastVoiceAt = 0; this.lastTextAt = 0; this.latestWordEnd = -1;
    this.classifiedText = '';
    this.classifyingText = null; this.classifyController = null;
  }
  close() { this.closed = true; this.reset(); }
}
module.exports = { QuestionGate, localQuestionState };
