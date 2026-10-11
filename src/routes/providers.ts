import { Elysia } from "elysia";
import { getDb } from "../lib/db";
import { ok } from "../lib/utils";
import { loadProviders, endpointFor } from "../lib/providers";
import { getUpstreamQuotaStatus } from "../lib/quota-manager";
import { getKeyInFlight, isKeyInCooldown } from "../lib/key-balancer";
import { generateRealHistoryBars, TelemetryRow } from "../lib/telemetry-bars";

export const providersRoutes = new Elysia({ prefix: "/api/providers" })
  // GET /api/providers/ — provider registry from provider.json (hot-reload on file change)
  .get("/", () => ok(loadProviders()))

  // GET /api/providers/overview — Provider Overview with Multi-Key Quotas & Load Partitioning
  .get("/overview", ({ query }) => {
    const db = getDb();
    const windowHours = query?.window === "1h" ? 1 : 24;

    const upstreams = db.prepare("SELECT * FROM upstreams").all() as any[];
    const allTelemetry = db.prepare(
      `SELECT upstream_id, status, latency_ms, total_tokens, created_at 
       FROM telemetry_logs 
       WHERE datetime(created_at) >= datetime('now', '-' || ? || ' hours')`
    ).all(windowHours) as TelemetryRow[];

    // Group logs by upstream_id
    const logsByUpstream = new Map<string, TelemetryRow[]>();
    for (const log of allTelemetry) {
      if (!log.upstream_id) continue;
      const arr = logsByUpstream.get(log.upstream_id) ?? [];
      arr.push(log);
      logsByUpstream.set(log.upstream_id, arr);
    }

    let totalAllocatedTokens = 0;
    let totalUsedTokens = 0;
    let totalRemainingTokens = 0;
    let activeKeysCount = 0;
    let totalInFlightCount = 0;

    const providers = upstreams.map((up) => {
      const quota = getUpstreamQuotaStatus(up.id, db);
      totalAllocatedTokens += quota.capacity;
      totalUsedTokens += quota.used;
      totalRemainingTokens += quota.remaining;

      const keys = db.prepare(
        "SELECT id, name, key, quota_limit, is_active, created_at, live_quota_used, live_quota_total, live_quota_name, live_quota_status, live_quota_exp_date, live_quota_checked_at FROM upstream_keys WHERE upstream_id = ?"
      ).all(up.id) as any[];

      const upLogs = logsByUpstream.get(up.id) ?? [];
      const history = generateRealHistoryBars(upLogs, windowHours);

      const mappedKeys = keys.map((k, idx) => {
        if (k.is_active) activeKeysCount++;
        const inFlight = getKeyInFlight(k.id);
        totalInFlightCount += inFlight;
        const inCooldown = isKeyInCooldown(k.id);

        // Partition range: 1–3, 4–6, 7–10, etc.
        const startReq = idx * 3 + 1;
        const endReq = (idx + 1) * 3 + (idx === keys.length - 1 && idx > 1 ? 1 : 0);
        const partitionRange = `Requests ${startReq}–${endReq}`;

        // Mask key: sk-...xxxx
        const raw = k.key || "";
        const masked = raw.length > 8 ? `${raw.slice(0, 4)}...${raw.slice(-4)}` : "sk-••••••••";

        // Label: Primary (1), Key 1 (2), Key 2 (3)...
        const defaultName = idx === 0 ? `Primary (${idx + 1})` : `Key ${idx} (${idx + 1})`;
        const name = k.name && k.name.trim() ? `${k.name} (${idx + 1})` : defaultName;

        return {
          id: k.id,
          name,
          keyMasked: masked,
          quotaLimit: k.quota_limit ?? null,
          inFlight,
          inCooldown,
          isActive: !!k.is_active,
          partitionRange,
          // Live provider-reported quota (captured from quota-gate responses by the proxy)
          liveQuota: k.live_quota_checked_at
            ? {
                used: k.live_quota_used ?? 0,
                total: k.live_quota_total ?? 0,
                name: k.live_quota_name ?? null,
                status: k.live_quota_status ?? null,
                expDate: k.live_quota_exp_date ?? null,
                checkedAt: k.live_quota_checked_at,
              }
            : null,
        };
      });

      const usedTokens = quota.used;
      const capacity = quota.capacity;
      const remainingTokens = quota.remaining;
      const usedPercent = capacity > 0 ? Number(((usedTokens / capacity) * 100).toFixed(1)) : 0;
      const availablePercent = Number(Math.max(0, 100 - usedPercent).toFixed(1));

      // Calculate availability and average latency from real history
      let successfulReqs = 0;
      let totalReqs = 0;
      let totalLatency = 0;
      for (const bar of history) {
        totalReqs += bar.requests;
        successfulReqs += (bar.requests - bar.errors);
        totalLatency += (bar.latency * bar.requests);
      }
      const availability = totalReqs > 0 ? Number(((successfulReqs / totalReqs) * 100).toFixed(1)) : 100;
      const avgLatency = totalReqs > 0 ? Math.round(totalLatency / totalReqs) : 0;

      return {
        id: up.id,
        name: up.name,
        provider: up.provider,
        endpoint: up.base_url || endpointFor(up.provider) || "Custom",
        weight: up.weight,
        roundRobin: !!up.round_robin,
        isActive: !!up.is_active,
        modelsCount: JSON.parse(up.models || "[]").length,
        availability,
        avgLatency,
        globalQuota: {
          capacity,
          used: usedTokens,
          remaining: remainingTokens,
          usedPercent,
          availablePercent,
          exhausted: quota.exhausted,
          mode: quota.mode,
        },
        keys: mappedKeys,
        history,
      };
    });

    const summary = {
      totalAllocatedTokens,
      totalUsedTokens,
      totalRemainingTokens,
      totalProviders: upstreams.length,
      activeProviders: upstreams.filter((u) => u.is_active).length,
      activeKeysCount,
      totalInFlightCount,
    };

    return ok({ summary, providers });
  });
