import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TurnRecord } from './recorder.js';
import { summarizeLatency } from './stats.js';

const dataDir = resolve('data');
const files = (await readdir(dataDir)).filter((name) => name.endsWith('.jsonl'));
const turns: TurnRecord[] = [];
for (const file of files) {
  const content = await readFile(resolve(dataDir, file), 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    const row = JSON.parse(line) as TurnRecord;
    if (row.type === 'turn') turns.push(row);
  }
}

const latencies = turns
  .map((turn) => turn.total_perceived_latency_ms)
  .filter((value): value is number => typeof value === 'number')
  .sort((a, b) => a - b);

const summary = {
  generated_at: new Date().toISOString(),
  ...summarizeLatency(latencies),
};
await writeFile(resolve(dataDir, 'latency-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

