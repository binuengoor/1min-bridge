// ============================================================================
// 1min-bridge — In-memory Metrics (Prometheus-compatible)
// ============================================================================

interface CounterEntry {
  labels: Record<string, string>;
  value: number;
}

interface HistogramBucket {
  le: number;
  count: number;
}

interface HistogramEntry {
  labels: Record<string, string>;
  buckets: HistogramBucket[];
  sum: number;
  count: number;
}

const counters: Map<string, CounterEntry[]> = new Map();
const histograms: Map<string, HistogramEntry[]> = new Map();

const HISTOGRAM_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function incrementCounter(
  name: string,
  labels: Record<string, string>,
): void {
  if (!counters.has(name)) counters.set(name, []);
  const entries = counters.get(name)!;
  const key = JSON.stringify(labels);
  const existing = entries.find((e) => JSON.stringify(e.labels) === key);
  if (existing) {
    existing.value++;
  } else {
    entries.push({ labels, value: 1 });
  }
}

export function observeHistogram(
  name: string,
  labels: Record<string, string>,
  value: number,
): void {
  if (!histograms.has(name)) histograms.set(name, []);
  const entries = histograms.get(name)!;
  const key = JSON.stringify(labels);
  let existing = entries.find((e) => JSON.stringify(e.labels) === key);
  if (!existing) {
    existing = {
      labels,
      buckets: HISTOGRAM_BUCKETS.map((le) => ({ le, count: 0 })),
      sum: 0,
      count: 0,
    };
    entries.push(existing);
  }
  existing.sum += value;
  existing.count++;
  for (const bucket of existing.buckets) {
    if (value <= bucket.le) bucket.count++;
  }
}

function formatLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

export function getMetricsText(): string {
  const lines: string[] = [];

  // Counters
  for (const [name, entries] of counters) {
    lines.push(`# HELP ${name} Total count`);
    lines.push(`# TYPE ${name} counter`);
    for (const entry of entries) {
      lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
    }
  }

  // Histograms
  for (const [name, entries] of histograms) {
    lines.push(`# HELP ${name} Duration in seconds`);
    lines.push(`# TYPE ${name} histogram`);
    for (const entry of entries) {
      for (const bucket of entry.buckets) {
        const labels = { ...entry.labels, le: String(bucket.le) };
        lines.push(`${name}_bucket${formatLabels(labels)} ${bucket.count}`);
      }
      const infLabels = { ...entry.labels, le: "+Inf" };
      lines.push(`${name}_bucket${formatLabels(infLabels)} ${entry.count}`);
      lines.push(`${name}_sum${formatLabels(entry.labels)} ${entry.sum.toFixed(6)}`);
      lines.push(`${name}_count${formatLabels(entry.labels)} ${entry.count}`);
    }
  }

  return lines.join("\n") + "\n";
}
