// Interview mode publishes only complete answers; drafts stay in the backend.
(function (root) {
  function shouldPublishHint(event) {
    return event.type === 'assist' && (event.phase === 'final' || (event.phase === 'error' && !event.draft));
  }
  function nextHintText(previous, event) {
    if (!['final', 'error'].includes(event.phase) || (event.phase === 'error' && event.draft)) return previous;
    if (typeof event.text !== 'string' || !event.text.trim()) return previous;
    return event.text;
  }
  root.nextHintText = nextHintText;
  root.shouldPublishHint = shouldPublishHint;
})(globalThis);
