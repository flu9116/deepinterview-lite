export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))] ?? null;
}

export function summarizeLatency(values: number[]) {
  return {
    sample_size: values.length,
    p50_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
    worst_ms: values.length ? Math.max(...values) : null,
    note:
      values.length < 20
        ? 'Small sample: descriptive only; no statistical significance claimed.'
        : undefined,
  };
}

