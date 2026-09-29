export type TelemetryRow = {
  model?: string | null;
  upstream_id?: string | null;
  upstream_key_id?: string | null;
  status: number;
  latency_ms: number;
  total_tokens?: number;
  created_at: string;
};

export type HistoryBar = {
  status: "success" | "warning" | "error" | "idle";
  latency: number;
  requests: number;
  tokens: number;
  errors: number;
  warnings: number;
  time: string;
};

/**
 * 100% Real Chronological Time-Bucket Generator
 * Slices monitoring window (24h or 1h) into exactly 60 chronological intervals.
 * Maps actual database records from telemetry_logs into their matching time slots.
 */
export function generateRealHistoryBars(
  logs: TelemetryRow[],
  windowHours: number = 24
): HistoryBar[] {
  const barsCount = 60;
  const nowMs = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const bucketMs = windowMs / barsCount;

  // Initialize 60 empty buckets
  const bars: HistoryBar[] = [];

  for (let i = 0; i < barsCount; i++) {
    const bucketStartMs = nowMs - (barsCount - i) * bucketMs;
    const date = new Date(bucketStartMs);
    const hours = date.getHours().toString().padStart(2, "0");
    const mins = date.getMinutes().toString().padStart(2, "0");
    const timeLabel = `${hours}:${mins}`;

    bars.push({
      status: "idle",
      latency: 0,
      requests: 0,
      tokens: 0,
      errors: 0,
      warnings: 0,
      time: timeLabel,
    });
  }

  // Populate buckets from real DB records
  for (const log of logs) {
    const logMs = new Date(log.created_at.includes("Z") ? log.created_at : log.created_at + "Z").getTime();
    const ageMs = nowMs - logMs;

    if (ageMs >= 0 && ageMs < windowMs) {
      const idx = Math.min(barsCount - 1, Math.max(0, Math.floor((windowMs - ageMs) / bucketMs)));
      const b = bars[idx];
      b.requests++;
      b.latency += log.latency_ms || 0;
      b.tokens += log.total_tokens || 0;

      if (log.status >= 500) {
        b.errors++;
      } else if (log.status >= 400 || (log.latency_ms && log.latency_ms > 3000)) {
        b.warnings++;
      }
    }
  }

  // Evaluate final status per bucket
  for (const b of bars) {
    if (b.requests === 0) {
      b.status = "idle";
      b.latency = 0;
    } else {
      const avgLat = Math.round(b.latency / b.requests);
      b.latency = avgLat;
      if (b.errors > 0) {
        b.status = "error"; // red
      } else if (b.warnings > 0 || avgLat > 3000) {
        b.status = "warning"; // amber
      } else {
        b.status = "success"; // green
      }
    }
  }

  return bars;
}
