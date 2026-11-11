const { writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { RecordingStore } = require('../desktop/recording-store.cjs');
const root = join(__dirname, '..');
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
(async () => {
  const store = new RecordingStore(join(root, 'recordings'));
  const groups = {};
  for (const session of await store.list()) {
    const events = await store.readLog(session.id);
    const language = events.find(e => e.type === 'live-config')?.language;
    if (!language) continue;
    const group = groups[language] ??= { sessions: 0, questions: 0, generationFailures: 0, latencyMs: [], llmTtftMs: [] };
    group.sessions++;
    group.questions += events.filter(e => e.type === 'question').length;
    group.generationFailures += events.filter(e => e.type === 'assist' && e.phase === 'error' && !e.draft).length;
    for (const event of events) {
      if (event.type !== 'assist' || event.phase !== 'final') continue;
      if (Number.isFinite(event.firstPointLatencyMs) && event.firstPointLatencyMs >= 0) group.latencyMs.push(event.firstPointLatencyMs);
      if (Number.isFinite(event.llmTtftMs)) group.llmTtftMs.push(event.llmTtftMs);
    }
  }
  const report = { generatedAt: new Date().toISOString(),
    method: 'Production recording sessions only; provider-smoke outputs excluded. Latency is backend first complete point minus PCM-timeline last recognized word. Includes STT endpointing and generation; excludes UI rendering. First point uses sentence/line heuristic, not human usability rating.',
    groups: Object.fromEntries(Object.entries(groups).map(([language, group]) => [language, {
      sessions: group.sessions, questions: group.questions, generationFailures: group.generationFailures,
      successfulLatencySamples: group.latencyMs.length,
      p50Ms: percentile(group.latencyMs, 0.5), p95Ms: percentile(group.latencyMs, 0.95), worstMs: percentile(group.latencyMs, 1),
      llmTtftP50Ms: percentile(group.llmTtftMs, 0.5),
      note: group.latencyMs.length < 20 ? 'Small descriptive sample; failures and cancelled requests are not filled with latency values.' : '',
    }])) };
  await mkdir(join(root, 'outputs'), { recursive: true });
  await writeFile(join(root, 'outputs', 'desktop-latency-summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error('Report failed:', error.name); process.exitCode = 1; });
