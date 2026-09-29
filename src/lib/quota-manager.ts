import { getDb } from "./db";
import { getKeyInFlight, isKeyInCooldown } from "./key-balancer";

export type PhysicalPoolStatus = {
  capacity: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  utilizationPercent: number;
};

// In-memory sliding-window request tracker for WFQ dynamic rate limiting
type UserWindow = {
  timestamps: number[];
  inFlight: number;
};

const userWindows = new Map<string, UserWindow>();

/**
 * Get physical provider pool status (separated from virtual user balances).
 * Default capacity: 50,000,000 tokens (configurable in settings).
 */
export function getPhysicalPoolStatus(db: ReturnType<typeof getDb>): PhysicalPoolStatus {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'physical_provider_quota_pool'").get() as { value: string } | undefined;
  const parsed = row?.value !== undefined ? parseInt(row.value, 10) : NaN;
  const capacity = !isNaN(parsed) ? Math.max(0, parsed) : 50_000_000;

  // Total physical tokens consumed across all upstream provider requests
  const usageRow = db.prepare("SELECT COALESCE(SUM(total_tokens), 0) as total FROM telemetry_logs").get() as { total: number } | undefined;
  const used = usageRow?.total ?? 0;
  const remaining = Math.max(0, capacity - used);
  const exhausted = capacity === 0 || used >= capacity;
  const utilizationPercent = capacity > 0 ? Number(((used / capacity) * 100).toFixed(2)) : 100;

  return {
    capacity,
    used,
    remaining,
    exhausted,
    utilizationPercent,
  };
}

/**
 * Set physical provider pool capacity.
 */
export function setPhysicalPoolCapacity(db: ReturnType<typeof getDb>, capacity: number): void {
  db.prepare("INSERT INTO settings (key, value) VALUES ('physical_provider_quota_pool', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(Math.max(0, capacity)));
}

export type UpstreamQuotaStatus = {
  upstreamId: string;
  mode: "dedicated" | "global";
  capacity: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  utilizationPercent: number;
};

/**
 * Smart Hybrid Upstream Quota Decider:
 * - If upstream keys have individual quota_limit > 0: aggregates provider global quota = K1 + K2 + K3...
 * - If upstream has dedicated quota_limit > 0: enforces dedicated per-provider token capacity.
 * - Otherwise falls back to global physical token pool.
 */
export function getUpstreamQuotaStatus(
  upstreamId: string,
  db: ReturnType<typeof getDb>
): UpstreamQuotaStatus {
  const up = db
    .prepare("SELECT id, quota_limit, quota_baseline FROM upstreams WHERE id = ?")
    .get(upstreamId) as { id: string; quota_limit: number | null; quota_baseline: number } | undefined;

  // 1. Check if upstream keys have individual quota_limits defined (K1 + K2 + K3...)
  const keysRow = db
    .prepare("SELECT COALESCE(SUM(quota_limit), 0) as total_keys_quota, COUNT(CASE WHEN quota_limit IS NOT NULL AND quota_limit > 0 THEN 1 END) as count_with_quota FROM upstream_keys WHERE upstream_id = ? AND is_active = 1")
    .get(upstreamId) as { total_keys_quota: number; count_with_quota: number } | undefined;

  let capacity: number | null = null;
  let mode: "dedicated" | "global" = "global";

  if (keysRow && keysRow.count_with_quota > 0 && keysRow.total_keys_quota > 0) {
    // Multi-key aggregated provider global quota: K1 + K2 + K3...
    capacity = keysRow.total_keys_quota;
    mode = "dedicated";
  } else if (up && up.quota_limit !== null && up.quota_limit > 0) {
    capacity = up.quota_limit;
    mode = "dedicated";
  }

  if (capacity !== null && capacity > 0) {
    const usageRow = db
      .prepare("SELECT COALESCE(SUM(total_tokens), 0) as total FROM telemetry_logs WHERE upstream_id = ?")
      .get(upstreamId) as { total: number } | undefined;
    const used = Math.max(usageRow?.total ?? 0, up?.quota_baseline ?? 0);
    const remaining = Math.max(0, capacity - used);
    const exhausted = used >= capacity;
    const utilizationPercent = Number(((used / capacity) * 100).toFixed(2));

    return {
      upstreamId,
      mode,
      capacity,
      used,
      remaining,
      exhausted,
      utilizationPercent,
    };
  }

  const globalPool = getPhysicalPoolStatus(db);
  return {
    upstreamId,
    mode: "global",
    ...globalPool,
  };
}

export type ProviderGlobalQuotaInfo = {
  upstreamId: string;
  providerGlobalQuota: number;
  keys: {
    id: string;
    name: string | null;
    quotaLimit: number | null;
    inFlight: number;
    inCooldown: boolean;
  }[];
  used: number;
  remaining: number;
  exhausted: boolean;
  mode: "dedicated" | "global";
};

/**
 * Returns provider global quota breakdown: aggregate total + per-key status.
 */
export function getProviderGlobalQuota(
  upstreamId: string,
  db: ReturnType<typeof getDb>
): ProviderGlobalQuotaInfo {
  const status = getUpstreamQuotaStatus(upstreamId, db);
  const keys = db
    .prepare("SELECT id, name, quota_limit FROM upstream_keys WHERE upstream_id = ? AND is_active = 1")
    .all(upstreamId) as { id: string; name: string | null; quota_limit: number | null }[];

  return {
    upstreamId,
    providerGlobalQuota: status.capacity,
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      quotaLimit: k.quota_limit,
      inFlight: getKeyInFlight(k.id),
      inCooldown: isKeyInCooldown(k.id),
    })),
    used: status.used,
    remaining: status.remaining,
    exhausted: status.exhausted,
    mode: status.mode,
  };
}

export type ClientKeyData = {
  id: string;
  name: string;
  key: string;
  is_active: number;
  token_limit: number | null;
  used_tokens: number;
  rate_limit: number | null;
};

export type WFQCheckResult =
  | { allowed: true }
  | { allowed: false; status: number; message: string; code: string; meta?: Record<string, unknown> };

/**
 * Dynamic Weighted Fair Queueing (WFQ) & Over-subscription Quota Arbiter.
 *
 * 1. Over-subscription separation:
 *    Virtual user balances (e.g. 3 users with 50M each = 150M virtual)
 *    are checked against the shared physical provider capacity (50M pool).
 *
 * 2. Dynamic Weighted Fair Queueing (WFQ):
 *    Calculates each user's weight Wi = activeBalance_i / totalActiveBalances.
 *    Allocates fair dynamic concurrency and request rate per user to prevent
 *    a single user from draining the shared pool.
 */
export function checkUserQuotaAndWFQ(
  clientKey: ClientKeyData,
  db: ReturnType<typeof getDb>,
  targetUpstreamId?: string
): WFQCheckResult {
  // 1. Key active check
  if (!clientKey.is_active) {
    return {
      allowed: false,
      status: 403,
      message: "API key is inactive.",
      code: "key_inactive",
    };
  }

  // 2. Virtual User Balance check
  if (clientKey.token_limit !== null) {
    const userRemaining = clientKey.token_limit - clientKey.used_tokens;
    if (userRemaining <= 0) {
      return {
        allowed: false,
        status: 402,
        message: "Your virtual quota has been exhausted. Purchase additional tokens to continue.",
        code: "quota_exhausted",
        meta: {
          tokenLimit: clientKey.token_limit,
          usedTokens: clientKey.used_tokens,
          remainingTokens: 0,
        },
      };
    }
  }

  // 3. Physical Provider Pool capacity check (Smart Hybrid: dedicated upstream pool or global fallback)
  const pool = targetUpstreamId
    ? getUpstreamQuotaStatus(targetUpstreamId, db)
    : getPhysicalPoolStatus(db);

  if (pool.exhausted) {
    const mode = "mode" in pool ? pool.mode : "global";
    return {
      allowed: false,
      status: 503,
      message: mode === "dedicated"
        ? "Dedicated provider token capacity is exhausted for this upstream."
        : "Shared provider quota pool is exhausted. Physical capacity limit reached.",
      code: "provider_pool_exhausted",
      meta: {
        mode,
        poolCapacity: pool.capacity,
        poolUsed: pool.used,
      },
    };
  }

  // 4. Dynamic Weighted Fair Queueing (WFQ)
  // Calculate dynamic weight based on remaining balance
  const activeKeys = db.prepare(
    "SELECT id, token_limit, used_tokens FROM client_keys WHERE is_active = 1"
  ).all() as { id: string; token_limit: number | null; used_tokens: number }[];

  const userBalance = clientKey.token_limit !== null
    ? Math.max(0, clientKey.token_limit - clientKey.used_tokens)
    : 10_000_000; // default virtual balance if unlimited

  let totalVirtualRemaining = 0;
  for (const k of activeKeys) {
    const bal = k.token_limit !== null ? Math.max(0, k.token_limit - k.used_tokens) : 10_000_000;
    totalVirtualRemaining += bal;
  }

  const weight = totalVirtualRemaining > 0 ? userBalance / totalVirtualRemaining : 1 / Math.max(1, activeKeys.length);

  // Dynamic concurrency limit based on WFQ weight (min 2, max 25)
  const maxConcurrency = Math.max(2, Math.min(25, Math.round(weight * 30)));

  const win = userWindows.get(clientKey.id) ?? { timestamps: [], inFlight: 0 };
  if (win.inFlight >= maxConcurrency) {
    return {
      allowed: false,
      status: 429,
      message: "WFQ concurrency limit reached for your active fair share balance. Please wait for in-flight requests to complete.",
      code: "wfq_concurrency_throttled",
      meta: {
        inFlight: win.inFlight,
        maxConcurrency,
        weight: Number(weight.toFixed(4)),
      },
    };
  }

  // Sliding window rate limit (60s)
  const now = Date.now();
  win.timestamps = win.timestamps.filter((ts) => now - ts < 60_000);

  // Dynamic Rate Limit RPM scaled by fair share weight
  // Base 60 RPM scaled by weight (minimum 10 RPM, max 300 RPM)
  const baseRPM = clientKey.rate_limit ? clientKey.rate_limit * 60 : 60;
  const dynamicRPM = Math.max(10, Math.min(300, Math.round(baseRPM * (weight * Math.max(1, activeKeys.length)))));

  // If shared pool utilization is high (> 60%), strictly enforce WFQ rate limits
  if (pool.utilizationPercent > 60 && win.timestamps.length >= dynamicRPM) {
    return {
      allowed: false,
      status: 429,
      message: "Fair share rate limit: Request throttled by Dynamic WFQ to protect shared provider pool from starvation.",
      code: "wfq_rate_throttled",
      meta: {
        poolUtilization: pool.utilizationPercent,
        dynamicRPM,
        currentRPM: win.timestamps.length,
        weight: Number(weight.toFixed(4)),
      },
    };
  }

  return { allowed: true };
}

/**
 * Acquire in-flight slot for client key (for WFQ in-flight tracking)
 */
export function acquireClientKeySlot(clientKeyId: string): void {
  const win = userWindows.get(clientKeyId) ?? { timestamps: [], inFlight: 0 };
  win.inFlight++;
  win.timestamps.push(Date.now());
  userWindows.set(clientKeyId, win);
}

/**
 * Release in-flight slot for client key
 */
export function releaseClientKeySlot(clientKeyId: string): void {
  const win = userWindows.get(clientKeyId);
  if (win) {
    win.inFlight = Math.max(0, win.inFlight - 1);
  }
}
