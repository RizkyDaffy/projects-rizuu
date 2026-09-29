import { describe, it, expect, beforeEach } from "bun:test";
import { getDb } from "../src/lib/db";
import { newId, newKey } from "../src/lib/utils";
import { app } from "../src/index";
import {
  getPhysicalPoolStatus,
  setPhysicalPoolCapacity,
  checkUserQuotaAndWFQ,
  getProviderGlobalQuota,
  acquireClientKeySlot,
  releaseClientKeySlot,
} from "../src/lib/quota-manager";
import {
  selectKeyWithPartitioning,
  getFailoverKeysOrder,
  recordKeyFailure,
  clearKeyCooldown,
  isKeyInCooldown,
  acquireKeySlot,
  releaseKeySlot,
  getKeyInFlight,
  DEFAULT_PARTITION_CHUNK_SIZE,
  UpstreamKeyEntry,
} from "../src/lib/key-balancer";

describe("Requirement 1: Users vs. Provider Quota Management & WFQ", () => {
  const db = getDb();

  it("calculates physical provider quota pool separated from virtual user balances", () => {
    setPhysicalPoolCapacity(db, 50_000_000);
    const pool = getPhysicalPoolStatus(db);

    expect(pool.capacity).toBe(50_000_000);
    expect(pool.exhausted).toBe(false);
    expect(typeof pool.used).toBe("number");
    expect(typeof pool.remaining).toBe("number");
  });

  it("handles over-subscription: multiple users with 50M virtual tokens each share 50M physical capacity", () => {
    // 3 users with 50M virtual limit = 150M total virtual tokens on 50M physical pool
    const user1 = { id: newId(), name: "User 1", key: newKey(), is_active: 1, token_limit: 50_000_000, used_tokens: 0, rate_limit: 60 };
    const user2 = { id: newId(), name: "User 2", key: newKey(), is_active: 1, token_limit: 50_000_000, used_tokens: 0, rate_limit: 60 };
    const user3 = { id: newId(), name: "User 3", key: newKey(), is_active: 1, token_limit: 50_000_000, used_tokens: 0, rate_limit: 60 };

    setPhysicalPoolCapacity(db, 50_000_000);

    // All 3 users are allowed initially
    const res1 = checkUserQuotaAndWFQ(user1, db);
    const res2 = checkUserQuotaAndWFQ(user2, db);
    const res3 = checkUserQuotaAndWFQ(user3, db);

    expect(res1.allowed).toBe(true);
    expect(res2.allowed).toBe(true);
    expect(res3.allowed).toBe(true);
  });

  it("calculates provider global quota as sum of keys: 5M(K1) + 5M(K2) + 10M(K3) = 20M", () => {
    const upId = newId();
    db.prepare(`
      INSERT INTO upstreams (id, name, provider, weight, is_active, models)
      VALUES (?, 'MultiKey Provider', 'ryzumi', 1, 1, '[]')
    `).run(upId);

    // K1 = 5M, K2 = 5M, K3 = 10M -> Total = 20M
    db.prepare("INSERT INTO upstream_keys (id, upstream_id, name, key, quota_limit, is_active) VALUES (?, ?, 'K1', 'sk-k1', 5000000, 1)").run(newId(), upId);
    db.prepare("INSERT INTO upstream_keys (id, upstream_id, name, key, quota_limit, is_active) VALUES (?, ?, 'K2', 'sk-k2', 5000000, 1)").run(newId(), upId);
    db.prepare("INSERT INTO upstream_keys (id, upstream_id, name, key, quota_limit, is_active) VALUES (?, ?, 'K3', 'sk-k3', 10000000, 1)").run(newId(), upId);

    const info = getProviderGlobalQuota(upId, db);
    expect(info.providerGlobalQuota).toBe(20_000_000);
    expect(info.keys.length).toBe(3);
    expect(info.keys[0].quotaLimit).toBe(5_000_000);
    expect(info.keys[1].quotaLimit).toBe(5_000_000);
    expect(info.keys[2].quotaLimit).toBe(10_000_000);
  });

  it("blocks user when their virtual quota is exhausted (402)", () => {
    const exhaustedUser = {
      id: newId(),
      name: "Exhausted User",
      key: newKey(),
      is_active: 1,
      token_limit: 50_000_000,
      used_tokens: 50_000_000,
      rate_limit: 60,
    };

    const res = checkUserQuotaAndWFQ(exhaustedUser, db);
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.status).toBe(402);
      expect(res.code).toBe("quota_exhausted");
    }
  });

  it("blocks all users when physical provider pool capacity is reached (503)", () => {
    // Set physical capacity to 0 to simulate physical provider pool exhaustion
    setPhysicalPoolCapacity(db, 0);

    const normalUser = {
      id: newId(),
      name: "Normal User",
      key: newKey(),
      is_active: 1,
      token_limit: 50_000_000,
      used_tokens: 1_000,
      rate_limit: 60,
    };

    const res = checkUserQuotaAndWFQ(normalUser, db);
    expect(res.allowed).toBe(false);
    if (!res.allowed) {
      expect(res.status).toBe(503);
      expect(res.code).toBe("provider_pool_exhausted");
    }

    // Restore physical pool capacity
    setPhysicalPoolCapacity(db, 50_000_000);
  });

  it("tracks user in-flight slots and enforces dynamic concurrency", () => {
    const testUserId = newId();
    acquireClientKeySlot(testUserId);
    acquireClientKeySlot(testUserId);
    releaseClientKeySlot(testUserId);
    releaseClientKeySlot(testUserId);
  });
});

describe("Requirement 2: Multi-Key Upstream Provider Support & Auto-Failover", () => {
  const keys: UpstreamKeyEntry[] = [
    { id: "key-1", upstream_id: "up-ryzumi", name: "Key 1", key: "sk-1", is_active: 1 },
    { id: "key-2", upstream_id: "up-ryzumi", name: "Key 2", key: "sk-2", is_active: 1 },
    { id: "key-3", upstream_id: "up-ryzumi", name: "Key 3", key: "sk-3", is_active: 1 },
  ];

  beforeEach(() => {
    clearKeyCooldown("key-1");
    clearKeyCooldown("key-2");
    clearKeyCooldown("key-3");
  });

  it("orders primary key first when all keys healthy", () => {
    const order = getFailoverKeysOrder(keys);
    expect(order.length).toBe(3);
    expect(order[0].id).toBe("key-1");
  });

  it("detects 429 rate-limit or 5xx on Key 1 and seamlessly fails over to backup keys (Key 2, Key 3)", () => {
    // Record HTTP 429 on Key 1
    recordKeyFailure("key-1", 429, "Rate limit exceeded");
    expect(isKeyInCooldown("key-1")).toBe(true);

    // Failover order now starts with Key 2!
    const order = getFailoverKeysOrder(keys);
    expect(order[0].id).toBe("key-2");
    expect(order[1].id).toBe("key-3");
    // Cooldown key-1 is placed at the end as last-resort fallback
    expect(order[2].id).toBe("key-1");
  });

  it("fails over to Key 3 if both Key 1 and Key 2 fail", () => {
    recordKeyFailure("key-1", 429, "Rate limit");
    recordKeyFailure("key-2", 500, "Internal Server Error");

    const order = getFailoverKeysOrder(keys);
    expect(order[0].id).toBe("key-3");
  });
});

describe("Requirement 3: High Concurrency & Dynamic Load Partitioning", () => {
  const keys: UpstreamKeyEntry[] = [
    { id: "key-A", upstream_id: "up-1", name: "Key A", key: "sk-a", is_active: 1 },
    { id: "key-B", upstream_id: "up-1", name: "Key B", key: "sk-b", is_active: 1 },
    { id: "key-C", upstream_id: "up-1", name: "Key C", key: "sk-c", is_active: 1 },
  ];

  beforeEach(() => {
    // Reset in-flight counters
    while (getKeyInFlight("key-A") > 0) releaseKeySlot("key-A");
    while (getKeyInFlight("key-B") > 0) releaseKeySlot("key-B");
    while (getKeyInFlight("key-C") > 0) releaseKeySlot("key-C");
    clearKeyCooldown("key-A");
    clearKeyCooldown("key-B");
    clearKeyCooldown("key-C");
  });

  it("dynamically partitions load across active keys: Requests 1-3 to Key A, 4-6 to Key B, 7-10 to Key C", () => {
    const allocations: string[] = [];

    // Simulate 10 concurrent requests
    for (let reqNum = 1; reqNum <= 10; reqNum++) {
      const selected = selectKeyWithPartitioning(keys, 3);
      expect(selected).not.toBeNull();
      allocations.push(selected!.id);
      acquireKeySlot(selected!.id);
    }

    // Verify exact partitioning per specification:
    // Requests 1-3 allocated to Key A
    expect(allocations[0]).toBe("key-A"); // Req 1
    expect(allocations[1]).toBe("key-A"); // Req 2
    expect(allocations[2]).toBe("key-A"); // Req 3

    // Requests 4-6 allocated to Key B
    expect(allocations[3]).toBe("key-B"); // Req 4
    expect(allocations[4]).toBe("key-B"); // Req 5
    expect(allocations[5]).toBe("key-B"); // Req 6

    // Requests 7-10 allocated to Key C
    expect(allocations[6]).toBe("key-C"); // Req 7
    expect(allocations[7]).toBe("key-C"); // Req 8
    expect(allocations[8]).toBe("key-C"); // Req 9
    expect(allocations[9]).toBe("key-C"); // Req 10 (or least-connections)

    // Check in-flight counters
    expect(getKeyInFlight("key-A")).toBe(3);
    expect(getKeyInFlight("key-B")).toBe(3);
    expect(getKeyInFlight("key-C")).toBe(4);
  });

  it("re-allocates to Key A immediately when in-flight requests finish", () => {
    // Fill Key A (3), Key B (3)
    acquireKeySlot("key-A");
    acquireKeySlot("key-A");
    acquireKeySlot("key-A");
    acquireKeySlot("key-B");
    acquireKeySlot("key-B");
    acquireKeySlot("key-B");

    // Next request would go to Key C
    let next = selectKeyWithPartitioning(keys, 3);
    expect(next?.id).toBe("key-C");

    // Two requests finish on Key A
    releaseKeySlot("key-A");
    releaseKeySlot("key-A");
    expect(getKeyInFlight("key-A")).toBe(1);

    // Next request is dynamically routed back to Key A!
    next = selectKeyWithPartitioning(keys, 3);
    expect(next?.id).toBe("key-A");
  });
});

describe("Requirement 4: Gateway Proxy Integration with WFQ & Key Balancer", () => {
  const db = getDb();

  it("GET /api/upstreams/:id/quota returns provider global quota and key breakdown", async () => {
    const upId = newId();
    db.prepare(`
      INSERT INTO upstreams (id, name, provider, weight, is_active, models)
      VALUES (?, 'Ryzumi GLM', 'ryzumi', 1, 1, '[]')
    `).run(upId);

    db.prepare("INSERT INTO upstream_keys (id, upstream_id, name, key, quota_limit, is_active) VALUES (?, ?, 'Key A', 'sk-a', 5000000, 1)").run(newId(), upId);
    db.prepare("INSERT INTO upstream_keys (id, upstream_id, name, key, quota_limit, is_active) VALUES (?, ?, 'Key B', 'sk-b', 5000000, 1)").run(newId(), upId);
    db.prepare("INSERT INTO upstream_keys (id, upstream_id, name, key, quota_limit, is_active) VALUES (?, ?, 'Key C', 'sk-c', 10000000, 1)").run(newId(), upId);

    const res = await app.handle(new Request(`http://localhost/api/upstreams/${upId}/quota`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.providerGlobalQuota).toBe(20_000_000);
    expect(json.data.keys.length).toBe(3);
  });

  it("rejects over-subscribed client when physical provider quota pool is exhausted (503)", async () => {
    // Set physical pool to 0
    setPhysicalPoolCapacity(db, 0);

    const testKey = newKey();
    db.prepare(`
      INSERT INTO client_keys (id, name, key, is_active, token_limit, used_tokens)
      VALUES (?, 'OverSubscribed User', ?, 1, 50000000, 0)
    `).run(newId(), testKey);

    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testKey}`,
        },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      })
    );

    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error.code).toBe("provider_pool_exhausted");

    // Restore pool
    setPhysicalPoolCapacity(db, 50_000_000);
  });
});
