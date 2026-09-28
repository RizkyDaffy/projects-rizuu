import { Elysia, t } from "elysia";
import { getDb } from "../lib/db";
import { ok } from "../lib/utils";

type TelemetryLog = {
  id: string;
  client_key_id: string | null;
  upstream_id: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number | null;
  status: number | null;
  created_at: string;
};

export const telemetryRoutes = new Elysia({ prefix: "/api/telemetry" })
  // GET /api/telemetry/active
  .get("/active", () => {
    const db = getDb();
    // Active = logs from last 5 minutes
    const rows = db.prepare(
      "SELECT COUNT(*) as active_requests FROM telemetry_logs WHERE created_at >= datetime('now', '-5 minutes')"
    ).get() as { active_requests: number };
    return ok({ activeRequests: rows.active_requests });
  })

  // GET /api/telemetry/stats?hours=&since=&all=
  .get(
    "/stats",
    ({ query }) => {
      const db = getDb();
      let where = "";
      if (!query.all) {
        const hours = query.hours ? parseInt(query.hours) : 24;
        if (query.since) {
          where = `WHERE created_at >= '${query.since}'`;
        } else {
          where = `WHERE created_at >= datetime('now', '-${hours} hours')`;
        }
      }

      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_requests,
          SUM(prompt_tokens) as total_prompt_tokens,
          SUM(completion_tokens) as total_completion_tokens,
          SUM(total_tokens) as total_tokens,
          AVG(latency_ms) as avg_latency_ms,
          MIN(latency_ms) as min_latency_ms,
          MAX(latency_ms) as max_latency_ms
        FROM telemetry_logs ${where}
      `).get() as any;

      const byModel = db.prepare(`
        SELECT model, COUNT(*) as requests, SUM(total_tokens) as tokens
        FROM telemetry_logs ${where}
        GROUP BY model ORDER BY requests DESC
      `).all();

      return ok({ stats, byModel });
    },
    { query: t.Optional(t.Object({ hours: t.Optional(t.String()), since: t.Optional(t.String()), all: t.Optional(t.String()) })) }
  )

  // GET /api/telemetry/logs?limit=&offset=
  .get(
    "/logs",
    ({ query }) => {
      const db = getDb();
      const limit = query.limit ? parseInt(query.limit) : 50;
      const offset = query.offset ? parseInt(query.offset) : 0;
      const rows = db.prepare(
        "SELECT * FROM telemetry_logs ORDER BY created_at DESC LIMIT ? OFFSET ?"
      ).all(limit, offset) as TelemetryLog[];
      const total = (db.prepare("SELECT COUNT(*) as c FROM telemetry_logs").get() as { c: number }).c;
      return ok({ logs: rows, total, limit, offset });
    },
    { query: t.Optional(t.Object({ limit: t.Optional(t.String()), offset: t.Optional(t.String()) })) }
  );
