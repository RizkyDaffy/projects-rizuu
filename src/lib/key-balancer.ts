export type UpstreamKeyEntry = {
  id: string;
  upstream_id: string;
  name?: string | null;
  key: string;
  is_active: number;
  quota_limit?: number | null;
};

// In-flight active requests tracking per key
const inFlightPerKey = new Map<string, number>();

// Key cooldown tracking (timestamp in ms until when key is in cooldown)
const keyCooldowns = new Map<string, { until: number; reason: string }>();

// Default partition chunk size: 3 concurrent requests per key
export const DEFAULT_PARTITION_CHUNK_SIZE = 3;

/**
 * Get the current number of in-flight requests for a given key.
 */
export function getKeyInFlight(keyId: string): number {
  return inFlightPerKey.get(keyId) ?? 0;
}

/**
 * Get all current key in-flight counts as a record (for telemetry/monitoring).
 */
export function getAllKeysInFlight(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [k, v] of inFlightPerKey.entries()) {
    if (v > 0) result[k] = v;
  }
  return result;
}

/**
 * Check if a key is currently in cooldown (e.g. following a 429 or 5xx).
 */
export function isKeyInCooldown(keyId: string): boolean {
  const cd = keyCooldowns.get(keyId);
  if (!cd) return false;
  if (Date.now() >= cd.until) {
    keyCooldowns.delete(keyId);
    return false;
  }
  return true;
}

/**
 * Record a failure on an upstream key and put it into cooldown.
 * For 429 (rate-limit) or provider quota error: cooldown 60s.
 * For 5xx: cooldown 30s.
 */
export function recordKeyFailure(keyId: string, statusCode: number, reason: string): void {
  const durationMs = statusCode === 429 ? 60_000 : 30_000;
  keyCooldowns.set(keyId, {
    until: Date.now() + durationMs,
    reason: `${statusCode}: ${reason.slice(0, 100)}`,
  });
}

/**
 * Clear cooldown on key (e.g. after a successful response or manual reset).
 */
export function clearKeyCooldown(keyId: string): void {
  keyCooldowns.delete(keyId);
}

/**
 * Dynamic Load Partitioning Key Selector (Requirement 3):
 *
 * When an upstream provider experiences high demand / concurrency,
 * partition and distribute requests across active keys:
 *   Requests 1–3  -> Key A (first key with inFlight < 3)
 *   Requests 4–6  -> Key B (second key with inFlight < 3)
 *   Requests 7–10 -> Key C (third key with inFlight < 3)
 *
 * Real-time in-flight request tracking ensures balanced distribution.
 */
export function selectKeyWithPartitioning(
  keys: UpstreamKeyEntry[],
  partitionSize: number = DEFAULT_PARTITION_CHUNK_SIZE
): UpstreamKeyEntry | null {
  if (!keys.length) return null;

  const now = Date.now();
  // Filter active keys and prune expired cooldowns
  const availableKeys = keys.filter((k) => {
    if (!k.is_active) return false;
    const cd = keyCooldowns.get(k.id);
    if (cd && now < cd.until) return false;
    if (cd && now >= cd.until) keyCooldowns.delete(k.id);
    return true;
  });

  // If all active keys are in cooldown, fallback to all active keys (best-effort)
  const candidatePool = availableKeys.length > 0 ? availableKeys : keys.filter((k) => k.is_active);
  if (!candidatePool.length) return null;

  // 1. Partitioned allocation: distribute load across active keys
  // Requests 1–3 to Key A, 4–6 to Key B, 7–10 to Key C (with partition chunk size 3)
  for (let idx = 0; idx < candidatePool.length; idx++) {
    const k = candidatePool[idx];
    const isLast = idx === candidatePool.length - 1;
    const limit = isLast && candidatePool.length > 1 ? partitionSize + 1 : partitionSize;
    const active = getKeyInFlight(k.id);
    if (active < limit) {
      return k;
    }
  }

  // 2. High saturation fallback (> partitionSize * numKeys, e.g. 10+ requests):
  // Pick the key with the lowest in-flight connections (least-connections)
  let bestKey = candidatePool[0];
  let minInFlight = getKeyInFlight(bestKey.id);

  for (let i = 1; i < candidatePool.length; i++) {
    const k = candidatePool[i];
    const inf = getKeyInFlight(k.id);
    if (inf < minInFlight) {
      minInFlight = inf;
      bestKey = k;
    }
  }

  return bestKey;
}

/**
 * Get ordered failover keys for an upstream (Requirement 2):
 * Returns candidate keys ordered starting from the preferred key,
 * followed by remaining available keys sorted by active in-flight count.
 */
export function getFailoverKeysOrder(
  keys: UpstreamKeyEntry[],
  primaryKeyId?: string,
  partitionSize: number = DEFAULT_PARTITION_CHUNK_SIZE
): UpstreamKeyEntry[] {
  const activeKeys = keys.filter((k) => k.is_active);
  if (!activeKeys.length) return [];

  const now = Date.now();
  // Sort non-cooldown keys first, then cooldown keys
  const nonCooldown = activeKeys.filter((k) => {
    const cd = keyCooldowns.get(k.id);
    return !cd || now >= cd.until;
  });
  const inCooldown = activeKeys.filter((k) => {
    const cd = keyCooldowns.get(k.id);
    return cd && now < cd.until;
  });

  const preferred = primaryKeyId ? nonCooldown.find((k) => k.id === primaryKeyId) : selectKeyWithPartitioning(nonCooldown, partitionSize);

  const order: UpstreamKeyEntry[] = [];
  if (preferred) order.push(preferred);

  // Add other non-cooldown keys sorted by least in-flight
  const others = nonCooldown
    .filter((k) => k.id !== preferred?.id)
    .sort((a, b) => getKeyInFlight(a.id) - getKeyInFlight(b.id));

  order.push(...others);

  // Add cooldown keys as last resort
  order.push(...inCooldown);

  return order;
}

/**
 * Acquire in-flight slot for upstream key.
 */
export function acquireKeySlot(keyId: string): void {
  const current = inFlightPerKey.get(keyId) ?? 0;
  inFlightPerKey.set(keyId, current + 1);
}

/**
 * Release in-flight slot for upstream key.
 */
export function releaseKeySlot(keyId: string): void {
  const current = inFlightPerKey.get(keyId) ?? 0;
  inFlightPerKey.set(keyId, Math.max(0, current - 1));
}

/**
 * Helper to execute a block with in-flight tracking.
 */
export async function withKeySlot<T>(keyId: string, fn: () => Promise<T>): Promise<T> {
  acquireKeySlot(keyId);
  try {
    return await fn();
  } finally {
    releaseKeySlot(keyId);
  }
}
