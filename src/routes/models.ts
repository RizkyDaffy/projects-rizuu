import { Elysia, t } from "elysia";
import { getDb } from "../lib/db";
import { ok, newId } from "../lib/utils";
import { endpointFor, authStyleFor } from "../lib/providers";

type Upstream = {
  id: string;
  name: string;
  provider: string;
  prefix: string | null;
  base_url: string | null;
  weight: number;
  round_robin: number;
  follow_upstream: number;
  is_active: number;
  models: string;
  created_at: string;
  updated_at: string;
};

type ParsedModel = {
  id: string;
  name?: string;
  enabled: boolean;
};

type TelemetryRow = {
  model: string | null;
  status: number;
  latency_ms: number;
  created_at: string;
};

function inferTags(modelId: string, provider: string): string[] {
  const tags: string[] = [];
  const lower = modelId.toLowerCase();

  if (lower.includes("claude") || provider === "anthropic") {
    tags.push("claude_native");
  }
  if (!lower.includes("embed") && !lower.includes("tts") && !lower.includes("dall") && !lower.includes("image")) {
    tags.push("chat");
    tags.push("responses");
  }
  if (lower.includes("vision") || lower.includes("4o") || lower.includes("opus") || lower.includes("sonnet")) {
    tags.push("vision");
  }
  if (lower.includes("code") || lower.includes("coder")) {
    tags.push("coding");
  }
  if (lower.includes("embed")) {
    tags.push("embeddings");
  }

  return Array.from(new Set(tags)).slice(0, 3);
}

/**
 * 100% Real Chronological Time-Bucket Generator
 * Slices the monitoring window (24h or 1h) into exactly 60 chronological intervals.
 * Maps actual database records from telemetry_logs into their matching time slots.
 */
function generateRealHistoryBars(
  modelLogs: TelemetryRow[],
  windowHours: number = 24
) {
  const barsCount = 60;
  const nowMs = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  const bucketMs = windowMs / barsCount;

  // Initialize 60 empty buckets
  const bars: {
    status: "success" | "warning" | "error" | "idle";
    latency: number;
    requests: number;
    errors: number;
    warnings: number;
    time: string;
  }[] = [];

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
      errors: 0,
      warnings: 0,
      time: timeLabel,
    });
  }

  // Populate buckets from real DB records
  for (const log of modelLogs) {
    // Parse UTC timestamp from SQLite datetime('now')
    const logMs = new Date(log.created_at.includes("Z") ? log.created_at : log.created_at + "Z").getTime();
    const ageMs = nowMs - logMs;

    if (ageMs >= 0 && ageMs < windowMs) {
      // 0 is start of window, 59 is current latest bucket
      const idx = Math.min(barsCount - 1, Math.max(0, Math.floor((windowMs - ageMs) / bucketMs)));
      const b = bars[idx];
      b.requests++;
      b.latency += log.latency_ms || 0;

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

export const modelsRoutes = new Elysia({ prefix: "/api/models" })
  // GET /api/models/management?window=24h|1h
  .get(
    "/management",
    ({ query }) => {
      const db = getDb();
      const windowHours = query?.window === "1h" ? 1 : 24;

      const upstreams = db.prepare("SELECT * FROM upstreams").all() as Upstream[];

      // Query real telemetry logs from SQLite
      const logs = db.prepare(`
        SELECT model, status, latency_ms, created_at 
        FROM telemetry_logs 
        WHERE created_at >= datetime('now', '-${windowHours} hours')
        ORDER BY created_at ASC
      `).all() as TelemetryRow[];

      // Overall window success rate
      const totalLogs = logs.length;
      const successLogs = logs.filter((l) => l.status >= 200 && l.status < 400).length;
      const overallSuccessRate = totalLogs > 0
        ? Number(((successLogs / totalLogs) * 100).toFixed(2))
        : 100;

      // Group logs by model
      const logsByModel = new Map<string, TelemetryRow[]>();
      for (const l of logs) {
        if (!l.model) continue;
        const arr = logsByModel.get(l.model) ?? [];
        arr.push(l);
        logsByModel.set(l.model, arr);
      }

      const modelList: any[] = [];
      let enabledCount = 0;
      let totalCount = 0;

      for (const u of upstreams) {
        let parsedModels: ParsedModel[] = [];
        try {
          parsedModels = JSON.parse(u.models || "[]");
        } catch (_) {
          parsedModels = [];
        }

        for (const m of parsedModels) {
          totalCount++;
          const isEnabled = !!u.is_active && m.enabled;
          if (isEnabled) enabledCount++;

          const modelLogs = logsByModel.get(m.id) ?? [];
          const modelTotal = modelLogs.length;
          const modelSuccess = modelLogs.filter((l) => l.status >= 200 && l.status < 400).length;

          let availability: number;
          let avgLatency: number;
          let ttftP90: number;
          let status: "normal" | "demote" | "offline";

          if (!isEnabled) {
            status = "offline";
            availability = 0;
            avgLatency = 0;
            ttftP90 = 0;
          } else if (modelTotal > 0) {
            // Strictly real values from actual requests
            availability = Number(((modelSuccess / modelTotal) * 100).toFixed(2));
            const totalLat = modelLogs.reduce((acc, curr) => acc + (curr.latency_ms || 0), 0);
            avgLatency = Math.round(totalLat / modelTotal);
            const sortedLat = [...modelLogs].map((l) => l.latency_ms || 0).sort((a, b) => a - b);
            ttftP90 = sortedLat[Math.floor(sortedLat.length * 0.9)] || avgLatency;
            status = availability < 95 || avgLatency > 20000 ? "demote" : "normal";
          } else {
            // No traffic yet for this model in the window
            status = "normal";
            availability = 100;
            avgLatency = 0;
            ttftP90 = 0;
          }

          const tags = inferTags(m.id, u.provider);
          // Strictly real time-bucketed activity bars
          const history = generateRealHistoryBars(modelLogs, windowHours);

          modelList.push({
            id: m.id,
            name: m.name || m.id,
            upstreamId: u.id,
            upstreamName: u.name,
            provider: u.provider,
            enabled: m.enabled,
            upstreamActive: !!u.is_active,
            status,
            availability,
            ttftP90,
            avgLatency,
            totalRequests: modelTotal,
            tags,
            history,
          });
        }
      }

      return ok({
        summary: {
          successRate24h: overallSuccessRate,
          availableModels: enabledCount,
          totalModels: totalCount,
          activeUpstreams: upstreams.filter((u) => u.is_active).length,
          totalRequestsWindow: totalLogs,
          window: `${windowHours}h`,
        },
        models: modelList,
      });
    },
    {
      query: t.Optional(
        t.Object({
          window: t.Optional(t.String()),
        })
      ),
    }
  )

  // POST /api/models/test
  // Real-time live ping/test that runs an upstream request and logs directly to telemetry_logs
  .post(
    "/test",
    async ({ body, set }) => {
      const db = getDb();
      const up = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(body.upstreamId) as Upstream | undefined;
      if (!up) {
        set.status = 404;
        return { success: false, error: "Upstream not found" };
      }
      const key = db.prepare("SELECT key FROM upstream_keys WHERE upstream_id = ? AND is_active = 1 LIMIT 1").get(up.id) as { key: string } | undefined;
      if (!key) {
        return { success: false, error: "No active key configured for this upstream" };
      }

      const start = Date.now();
      let status = 500;
      let okResp = false;
      let errMessage = "";

      try {
        const baseUrl = up.base_url ?? endpointFor(up.provider);
        if (!baseUrl) throw new Error(`No endpoint configured for ${up.provider}`);

        const isAnthropic = authStyleFor(up.provider) === "anthropic";
        const url = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`;
        const headers: Record<string, string> = isAnthropic
          ? { "x-api-key": key.key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
          : { Authorization: `Bearer ${key.key}`, "Content-Type": "application/json" };

        const payload = isAnthropic
          ? { model: body.modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }
          : { model: body.modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 5 };

        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(2500),
        });

        status = res.status;
        okResp = res.ok;
        if (!res.ok) {
          const text = await res.text();
          errMessage = text.slice(0, 150);
        }
      } catch (e) {
        errMessage = String(e);
        status = 503;
      }

      const latency_ms = Date.now() - start;

      // Write genuine telemetry log to SQLite database
      db.prepare(`
        INSERT INTO telemetry_logs
          (id, client_key_id, upstream_id, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newId(), null, up.id, body.modelId, 5, 2, 7, latency_ms, status);

      return ok({
        success: okResp,
        statusCode: status,
        latency_ms,
        error: errMessage || undefined,
      });
    },
    {
      body: t.Object({
        upstreamId: t.String(),
        modelId: t.String(),
      }),
    }
  )

  // POST /api/models/sync-all
  .post("/sync-all", async () => {
    const db = getDb();
    const upstreams = db.prepare("SELECT * FROM upstreams WHERE is_active = 1").all() as Upstream[];
    let totalSynced = 0;
    const errors: string[] = [];

    for (const up of upstreams) {
      const key = db.prepare("SELECT key FROM upstream_keys WHERE upstream_id = ? AND is_active = 1 LIMIT 1").get(up.id) as { key: string } | undefined;
      if (!key) continue;

      try {
        const baseUrl = up.base_url ?? endpointFor(up.provider);
        if (!baseUrl) continue;
        const headers = authStyleFor(up.provider) === "anthropic"
          ? { "x-api-key": key.key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${key.key}` };

        const res = await fetch(`${baseUrl}/v1/models`, { headers });
        if (!res.ok) continue;
        const json = await res.json().catch(() => ({}));
        const rawModels = json.data ?? json.models ?? [];
        if (Array.isArray(rawModels) && rawModels.length > 0) {
          const existingModels: ParsedModel[] = JSON.parse(up.models || "[]");
          const existingMap = new Map(existingModels.map((m) => [m.id, m.enabled]));
          const merged = rawModels.map((m: any) => ({
            id: m.id,
            name: m.id,
            enabled: existingMap.has(m.id) ? existingMap.get(m.id)! : true,
          }));
          db.prepare("UPDATE upstreams SET models = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(merged), up.id);
          totalSynced += merged.length;
        }
      } catch (e) {
        errors.push(`${up.name}: ${String(e)}`);
      }
    }

    return ok({ success: true, totalSynced, errors });
  })

  // POST /api/models/toggle
  .post(
    "/toggle",
    ({ body, set }) => {
      const db = getDb();
      const up = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(body.upstreamId) as Upstream | undefined;
      if (!up) {
        set.status = 404;
        return { success: false, error: "Upstream not found" };
      }
      const models: ParsedModel[] = JSON.parse(up.models || "[]");
      const target = models.find((m) => m.id === body.modelId);
      if (target) {
        target.enabled = body.enabled !== undefined ? body.enabled : !target.enabled;
        db.prepare("UPDATE upstreams SET models = ?, updated_at = datetime('now') WHERE id = ?").run(
          JSON.stringify(models),
          body.upstreamId
        );
      }
      return ok({ success: true, modelId: body.modelId, enabled: target?.enabled });
    },
    {
      body: t.Object({
        upstreamId: t.String(),
        modelId: t.String(),
        enabled: t.Optional(t.Boolean()),
      }),
    }
  );
