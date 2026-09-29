import { Elysia, t } from "elysia";
import { getDb } from "../lib/db";
import { newId, newKey, ok } from "../lib/utils";
import { endpointFor, authStyleFor } from "../lib/providers";
import { randomBytes } from "crypto";
import { isProviderQuotaError } from "./proxy";

import { getProviderGlobalQuota } from "../lib/quota-manager";

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
  quota_limit: number | null;
  quota_baseline: number;
  models: string;
  created_at: string;
  updated_at: string;
};

type UpstreamKey = {
  id: string;
  upstream_id: string;
  name: string | null;
  key: string;
  quota_limit: number | null;
  is_active: number;
  created_at: string;
};

function parseUpstream(row: Upstream) {
  return {
    ...row,
    provider: row.provider,
    isActive: !!row.is_active,
    roundRobin: !!row.round_robin,
    followUpstream: !!row.follow_upstream,
    quotaLimit: row.quota_limit ?? null,
    quotaBaseline: row.quota_baseline ?? 0,
    models: JSON.parse(row.models),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseUpKey(row: UpstreamKey) {
  return {
    ...row,
    isActive: !!row.is_active,
    quotaLimit: row.quota_limit ?? null,
    createdAt: row.created_at,
  };
}

// Generate random alias like "swift-river-42"
function genAlias(): string {
  const adj = ["swift", "quiet", "bright", "strong", "clean", "rapid", "cool"];
  const noun = ["river", "cloud", "stone", "wind", "peak", "grove"];
  return `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}-${Math.floor(Math.random() * 100)}`;
}

// Provider semantics come from provider.json registry (src/lib/providers.ts):
// endpoint resolution + auth style (bearer vs x-api-key) are config-driven.
function defaultBaseFor(provider: string): string | null {
  return endpointFor(provider);
}
function authHeadersFor(provider: string, key: string): Record<string, string> {
  return authStyleFor(provider) === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${key}` };
}

export const upstreamsRoutes = new Elysia({ prefix: "/api/upstreams" })
  // GET /api/upstreams/generate-alias
  .get("/generate-alias", () => ok({ alias: genAlias() }))

  // POST /api/upstreams/copilot/device-code
  .post("/copilot/device-code", () => ok({ stub: true, message: "GitHub Copilot device-code flow stub" }))

  // POST /api/upstreams/copilot/poll-token
  .post(
    "/copilot/poll-token",
    ({ body }) => ok({ stub: true, deviceCode: body.deviceCode }),
    { body: t.Object({ deviceCode: t.String() }) }
  )

  // POST /api/upstreams/antigravity/auth-url
  .post(
    "/antigravity/auth-url",
    ({ body }) => ok({ authUrl: "https://antigravity.example.com/oauth/authorize?redirect_uri=" + (body?.redirectUri ?? "") }),
    { body: t.Optional(t.Object({ redirectUri: t.Optional(t.String()) })) }
  )

  // POST /api/upstreams/antigravity/exchange
  .post(
    "/antigravity/exchange",
    ({ body }) => ok({ stub: true, code: body.code }),
    { body: t.Object({ code: t.String(), redirectUri: t.Optional(t.String()) }) }
  )

  // POST /api/upstreams/codex/auth-url
  .post("/codex/auth-url", () => ok({ authUrl: "https://codex.example.com/oauth/authorize" }))

  // GET /api/upstreams/codex/status
  .get(
    "/codex/status",
    ({ query }) => ok({ state: query.state, status: "pending" }),
    { query: t.Object({ state: t.String() }) }
  )

  // POST /api/upstreams/codex/exchange
  .post(
    "/codex/exchange",
    ({ body }) => ok({ stub: true, code: body.code }),
    { body: t.Object({ code: t.String(), codeVerifier: t.String(), redirectUri: t.Optional(t.String()) }) }
  )

  // POST /api/upstreams/codex/import-token
  .post(
    "/codex/import-token",
    ({ body }) => ok({ stub: true, accessToken: body.accessToken.slice(0, 8) + "..." }),
    { body: t.Object({ accessToken: t.String() }) }
  )

  // POST /api/upstreams/test-key
  .post(
    "/test-key",
    async ({ body }) => {
      try {
        const baseUrl = body.baseUrl ?? defaultBaseFor(body.provider);
        if (!baseUrl) return ok({ valid: false, error: `No endpoint configured for provider "${body.provider}". Add it to provider.json` });
        const url = `${baseUrl}/v1/models`;
        const headers = authHeadersFor(body.provider, body.apiKey);
        const res = await fetch(url, { method: "GET", headers });
        return ok({ valid: res.ok, statusCode: res.status });
      } catch (e) {
        return ok({ valid: false, error: String(e) });
      }
    },
    { body: t.Object({         provider: t.String({ minLength: 1 }), apiKey: t.String(), baseUrl: t.Optional(t.Nullable(t.String())) }) }
  )

  // GET /api/upstreams/
  .get("/", () => {
    const db = getDb();
    const upstreams = db.prepare("SELECT * FROM upstreams ORDER BY created_at DESC").all() as Upstream[];
    const result = upstreams.map((u) => {
      const keys = db.prepare("SELECT * FROM upstream_keys WHERE upstream_id = ?").all(u.id) as UpstreamKey[];
      return { ...parseUpstream(u), keys: keys.map(parseUpKey) };
    });
    return ok(result);
  })

  // POST /api/upstreams/
  .post(
    "/",
    ({ body }) => {
      const db = getDb();
      const id = newId();

      // collect key strings
      const rawKeyList: string[] = [];
      if (body.apiKey) rawKeyList.push(body.apiKey);
      if (body.apiKeys) rawKeyList.push(...body.apiKeys);
      if (body.rawKeys) rawKeyList.push(...body.rawKeys.split("\n").map((k: string) => k.trim()).filter(Boolean));

      const keyEntries = body.keyEntries ?? rawKeyList.map((k) => ({ key: k, isActive: true }));

      db.prepare(
        `INSERT INTO upstreams (id, name, provider, prefix, base_url, weight, round_robin, follow_upstream, quota_limit, quota_baseline, models)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.name,
        body.provider,
        body.prefix ?? null,
        body.baseUrl ?? null,
        body.weight ?? 1,
        body.roundRobin ? 1 : 0,
        body.followUpstream ? 1 : 0,
        body.quotaLimit ?? null,
        body.quotaBaseline ?? 0,
        JSON.stringify(body.models ?? [])
      );

      for (const entry of keyEntries) {
        db.prepare(
          "INSERT INTO upstream_keys (id, upstream_id, name, key, quota_limit, is_active) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(newId(), id, entry.name ?? null, entry.key, (entry as any).quotaLimit ?? null, entry.isActive !== false ? 1 : 0);
      }

      const row = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(id) as Upstream;
      const keys = db.prepare("SELECT * FROM upstream_keys WHERE upstream_id = ?").all(id) as UpstreamKey[];
      return ok({ ...parseUpstream(row), keys: keys.map(parseUpKey) });
    },
    {
      body: t.Object({
        provider: t.String({ minLength: 1 }),
        name: t.String(),
        prefix: t.Optional(t.Nullable(t.String())),
        apiKey: t.Optional(t.String()),
        apiKeys: t.Optional(t.Array(t.String())),
        rawKeys: t.Optional(t.String()),
        quotaLimit: t.Optional(t.Nullable(t.Number())),
        quotaBaseline: t.Optional(t.Number()),
        keyEntries: t.Optional(t.Array(t.Object({ id: t.Optional(t.String()), name: t.Optional(t.String()), key: t.String(), quotaLimit: t.Optional(t.Nullable(t.Number())), isActive: t.Optional(t.Boolean()) }))),
        baseUrl: t.Optional(t.String()),
        weight: t.Optional(t.Number()),
        roundRobin: t.Optional(t.Boolean()),
        followUpstream: t.Optional(t.Boolean()),
        models: t.Optional(t.Array(t.Object({ id: t.String(), name: t.Optional(t.String()), enabled: t.Boolean() }))),
      }),
    }
  )

  // GET /api/upstreams/:id/quota
  .get("/:id/quota", ({ params, set }) => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream | undefined;
    if (!row) { set.status = 404; return { success: false, error: "Upstream not found" }; }
    return ok(getProviderGlobalQuota(params.id, db));
  })

  // GET /api/upstreams/:id
  .get("/:id", ({ params, set }) => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream | undefined;
    if (!row) { set.status = 404; return { success: false, error: "Upstream not found" }; }
    const keys = db.prepare("SELECT * FROM upstream_keys WHERE upstream_id = ?").all(params.id) as UpstreamKey[];
    return ok({ ...parseUpstream(row), keys: keys.map(parseUpKey) });
  })

  // PATCH /api/upstreams/:id
  .patch(
    "/:id",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream | undefined;
      if (!existing) { set.status = 404; return { success: false, error: "Upstream not found" }; }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.provider !== undefined) { updates.push("provider = ?"); values.push(body.provider); }
      if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
      if (body.prefix !== undefined) { updates.push("prefix = ?"); values.push(body.prefix); }
      if (body.baseUrl !== undefined) { updates.push("base_url = ?"); values.push(body.baseUrl); }
      if (body.isActive !== undefined) { updates.push("is_active = ?"); values.push(body.isActive ? 1 : 0); }
      if (body.roundRobin !== undefined) { updates.push("round_robin = ?"); values.push(body.roundRobin ? 1 : 0); }
      if (body.weight !== undefined) { updates.push("weight = ?"); values.push(body.weight); }
      if (body.followUpstream !== undefined) { updates.push("follow_upstream = ?"); values.push(body.followUpstream ? 1 : 0); }
      if (body.quotaLimit !== undefined) { updates.push("quota_limit = ?"); values.push(body.quotaLimit); }
      if (body.quotaBaseline !== undefined) { updates.push("quota_baseline = ?"); values.push(body.quotaBaseline); }
      if (body.models !== undefined) { updates.push("models = ?"); values.push(JSON.stringify(body.models)); }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(params.id);
        db.prepare(`UPDATE upstreams SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      }

      // Update direct apiKey if passed
      if (body.apiKey) {
        const existingKey = db.prepare("SELECT id FROM upstream_keys WHERE upstream_id = ? AND is_active = 1 LIMIT 1").get(params.id) as { id: string } | undefined;
        if (existingKey) {
          db.prepare("UPDATE upstream_keys SET key = ? WHERE id = ?").run(body.apiKey, existingKey.id);
        } else {
          db.prepare("INSERT INTO upstream_keys (id, upstream_id, key, is_active) VALUES (?, ?, ?, 1)").run(newId(), params.id, body.apiKey);
        }
      }

      // Merge keyEntries
      if (body.keyEntries) {
        for (const entry of body.keyEntries) {
          if (entry.id) {
            const fields: string[] = [];
            const vals: unknown[] = [];
            if (entry.name !== undefined) { fields.push("name = ?"); vals.push(entry.name); }
            if (entry.key !== undefined) { fields.push("key = ?"); vals.push(entry.key); }
            if (entry.isActive !== undefined) { fields.push("is_active = ?"); vals.push(entry.isActive ? 1 : 0); }
            if (entry.quotaLimit !== undefined) { fields.push("quota_limit = ?"); vals.push(entry.quotaLimit); }
            if (fields.length) { vals.push(entry.id); db.prepare(`UPDATE upstream_keys SET ${fields.join(", ")} WHERE id = ?`).run(...vals); }
          } else {
            db.prepare("INSERT INTO upstream_keys (id, upstream_id, name, key, quota_limit, is_active) VALUES (?, ?, ?, ?, ?, ?)").run(
              newId(), params.id, entry.name ?? null, entry.key, entry.quotaLimit ?? null, entry.isActive !== false ? 1 : 0
            );
          }
        }
      }

      const row = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream;
      const keys = db.prepare("SELECT * FROM upstream_keys WHERE upstream_id = ?").all(params.id) as UpstreamKey[];
      return ok({ ...parseUpstream(row), keys: keys.map(parseUpKey) });
    },
    {
      body: t.Object({
        provider: t.Optional(t.String({ minLength: 1 })),
        name: t.Optional(t.String()),
        prefix: t.Optional(t.Nullable(t.String())),
        apiKey: t.Optional(t.String()),
        apiKeys: t.Optional(t.Array(t.String())),
        rawKeys: t.Optional(t.String()),
        quotaLimit: t.Optional(t.Nullable(t.Number())),
        quotaBaseline: t.Optional(t.Number()),
        keyEntries: t.Optional(t.Array(t.Object({ id: t.Optional(t.String()), name: t.Optional(t.String()), key: t.Optional(t.String()), quotaLimit: t.Optional(t.Nullable(t.Number())), isActive: t.Optional(t.Boolean()) }))),
        baseUrl: t.Optional(t.Nullable(t.String())),
        isActive: t.Optional(t.Boolean()),
        roundRobin: t.Optional(t.Boolean()),
        weight: t.Optional(t.Number()),
        followUpstream: t.Optional(t.Boolean()),
        models: t.Optional(t.Array(t.Object({ id: t.String(), name: t.Optional(t.String()), enabled: t.Boolean() }))),
      }),
    }
  )

  // DELETE /api/upstreams/:id
  .delete("/:id", ({ params, set }) => {
    const db = getDb();
    const existing = db.prepare("SELECT id FROM upstreams WHERE id = ?").get(params.id);
    if (!existing) { set.status = 404; return { success: false, error: "Upstream not found" }; }
    db.prepare("DELETE FROM upstreams WHERE id = ?").run(params.id);
    return ok(null, "Deleted");
  })

  // POST /api/upstreams/:id/fetch-models
  .post("/:id/fetch-models", async ({ params, set }) => {
    const db = getDb();
    const up = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream | undefined;
    if (!up) { set.status = 404; return { success: false, error: "Upstream not found" }; }
    const key = db.prepare("SELECT key FROM upstream_keys WHERE upstream_id = ? AND is_active = 1 LIMIT 1").get(params.id) as { key: string } | undefined;
    if (!key) return ok({ models: [], message: "No active key" });

    try {
      const baseUrl = up.base_url ?? defaultBaseFor(up.provider);
      if (!baseUrl) return ok({ models: [], message: `No endpoint configured for provider "${up.provider}". Add it to provider.json` });
      const headers = authHeadersFor(up.provider, key.key);
      const res = await fetch(`${baseUrl}/v1/models`, { headers });
      const text = await res.text();
      if (isProviderQuotaError(text)) {
        return ok({ models: [], message: "can't connect to router, we're lookin for it, try again later!" });
      }
      let json: any = {};
      try { json = JSON.parse(text); } catch (_) {}
      if (json.error) {
        return ok({ models: [], message: "can't connect to router, we're lookin for it, try again later!" });
      }
      const models = (json.data ?? json.models ?? []).map((m: any) => ({ id: m.id, name: m.id, enabled: true }));
      db.prepare("UPDATE upstreams SET models = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(models), params.id);
      return ok({ models });
    } catch (e) {
      const err = String(e);
      return ok({ models: [], error: isProviderQuotaError(err) ? "can't connect to router, we're lookin for it, try again later!" : err });
    }
  })

  // POST /api/upstreams/:id/models/toggle
  .post(
    "/:id/models/toggle",
    ({ params, body, set }) => {
      const db = getDb();
      const up = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream | undefined;
      if (!up) { set.status = 404; return { success: false, error: "Upstream not found" }; }
      const models: any[] = JSON.parse(up.models);
      if (body.enableAll) models.forEach((m: any) => (m.enabled = true));
      else if (body.disableAll) models.forEach((m: any) => (m.enabled = false));
      else if (body.modelId !== undefined) {
        const m = models.find((m: any) => m.id === body.modelId);
        if (m) m.enabled = body.enabled !== undefined ? body.enabled : !m.enabled;
      }
      db.prepare("UPDATE upstreams SET models = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(models), params.id);
      return ok({ models });
    },
    { body: t.Optional(t.Object({ modelId: t.Optional(t.String()), enabled: t.Optional(t.Boolean()), enableAll: t.Optional(t.Boolean()), disableAll: t.Optional(t.Boolean()) })) }
  )

  // POST /api/upstreams/:id/test
  .post("/:id/test", async ({ params, set }) => {
    const db = getDb();
    const up = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream | undefined;
    if (!up) { set.status = 404; return { success: false, error: "Upstream not found" }; }
    const key = db.prepare("SELECT key FROM upstream_keys WHERE upstream_id = ? AND is_active = 1 LIMIT 1").get(params.id) as { key: string } | undefined;
    if (!key) return ok({ ok: false, message: "No active key" });
    try {
      const baseUrl = up.base_url ?? defaultBaseFor(up.provider);
      if (!baseUrl) return ok({ ok: false, error: `No endpoint configured for provider "${up.provider}". Add it to provider.json` });
      const headers = authHeadersFor(up.provider, key.key);
      const res = await fetch(`${baseUrl}/v1/models`, { headers });
      return ok({ ok: res.ok, statusCode: res.status });
    } catch (e) {
      const err = String(e);
      return ok({ ok: false, error: isProviderQuotaError(err) ? "can't connect to router, we're lookin for it, try again later!" : err });
    }
  })

  // POST /api/upstreams/:id/test-all
  .post("/:id/test-all", async ({ params, set }) => {
    const db = getDb();
    const up = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream | undefined;
    if (!up) { set.status = 404; return { success: false, error: "Upstream not found" }; }
    const keys = db.prepare("SELECT * FROM upstream_keys WHERE upstream_id = ?").all(params.id) as UpstreamKey[];
    const baseUrl = up.base_url ?? defaultBaseFor(up.provider);
    if (!baseUrl) return ok({ ok: false, results: [], error: `No endpoint configured for provider "${up.provider}". Add it to provider.json` });
    const results = await Promise.all(keys.map(async (k) => {
      try {
        const headers = authHeadersFor(up.provider, k.key);
        const res = await fetch(`${baseUrl}/v1/models`, { headers });
        return { keyId: k.id, ok: res.ok, statusCode: res.status };
      } catch (e) {
        const err = String(e);
        return { keyId: k.id, ok: false, error: isProviderQuotaError(err) ? "can't connect to router, we're lookin for it, try again later!" : err };
      }
    }));
    return ok({ results });
  })

  // POST /api/upstreams/:id/keys
  .post(
    "/:id/keys",
    ({ params, body, set }) => {
      const db = getDb();
      const up = db.prepare("SELECT id FROM upstreams WHERE id = ?").get(params.id);
      if (!up) { set.status = 404; return { success: false, error: "Upstream not found" }; }

      const toInsert: { key: string; name?: string; isActive?: boolean }[] = [];
      if (body.key) toInsert.push({ key: body.key, name: body.name, isActive: body.isActive });
      if (body.keys) body.keys.forEach((k: string) => toInsert.push({ key: k }));
      if (body.rawKeys) body.rawKeys.split("\n").map((k: string) => k.trim()).filter(Boolean).forEach((k: string) => toInsert.push({ key: k }));
      if (body.keyEntries) body.keyEntries.forEach((e: any) => toInsert.push(e));

      for (const entry of toInsert) {
        db.prepare("INSERT INTO upstream_keys (id, upstream_id, name, key, is_active) VALUES (?, ?, ?, ?, ?)").run(
          newId(), params.id, entry.name ?? null, entry.key, entry.isActive !== false ? 1 : 0
        );
      }

      const keys = db.prepare("SELECT * FROM upstream_keys WHERE upstream_id = ?").all(params.id) as UpstreamKey[];
      return ok(keys.map(parseUpKey));
    },
    { body: t.Optional(t.Object({ key: t.Optional(t.String()), name: t.Optional(t.String()), isActive: t.Optional(t.Boolean()), keys: t.Optional(t.Array(t.String())), rawKeys: t.Optional(t.String()), keyEntries: t.Optional(t.Array(t.Object({ id: t.Optional(t.String()), name: t.Optional(t.String()), key: t.String(), isActive: t.Optional(t.Boolean()) }))) })) }
  )

  // POST /api/upstreams/:id/keys/import
  .post(
    "/:id/keys/import",
    ({ params, body, set }) => {
      const db = getDb();
      const up = db.prepare("SELECT id FROM upstreams WHERE id = ?").get(params.id);
      if (!up) { set.status = 404; return { success: false, error: "Upstream not found" }; }

      const existing = (db.prepare("SELECT key FROM upstream_keys WHERE upstream_id = ?").all(params.id) as { key: string }[]).map(k => k.key);
      const toInsert: string[] = [];
      if (body?.rawKeys) toInsert.push(...body.rawKeys.split("\n").map((k: string) => k.trim()).filter(Boolean));
      if (body?.keys) toInsert.push(...body.keys);
      if (body?.keyEntries) body.keyEntries.forEach((e: any) => toInsert.push(e.key));

      let imported = 0;
      let skipped = 0;
      for (const key of toInsert) {
        if (body?.skipDuplicates && existing.includes(key)) { skipped++; continue; }
        db.prepare("INSERT OR IGNORE INTO upstream_keys (id, upstream_id, key, is_active) VALUES (?, ?, ?, ?)").run(
          newId(), params.id, key, body?.defaultActive !== false ? 1 : 0
        );
        imported++;
      }
      return ok({ imported, skipped });
    },
    { body: t.Optional(t.Object({ rawKeys: t.Optional(t.String()), keys: t.Optional(t.Array(t.String())), keyEntries: t.Optional(t.Array(t.Object({ id: t.Optional(t.String()), name: t.Optional(t.String()), key: t.String(), isActive: t.Optional(t.Boolean()) }))), namePrefix: t.Optional(t.String()), defaultActive: t.Optional(t.Boolean()), skipDuplicates: t.Optional(t.Boolean()) })) }
  )

  // DELETE /api/upstreams/:id/keys/:keyId
  .delete("/:id/keys/:keyId", ({ params, set }) => {
    const db = getDb();
    const existing = db.prepare("SELECT id FROM upstream_keys WHERE id = ? AND upstream_id = ?").get(params.keyId, params.id);
    if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }
    db.prepare("DELETE FROM upstream_keys WHERE id = ?").run(params.keyId);
    return ok(null, "Deleted");
  })

  // POST /api/upstreams/:id/keys/delete-batch
  .post(
    "/:id/keys/delete-batch",
    ({ params, body }) => {
      const db = getDb();
      const placeholders = body.keyIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM upstream_keys WHERE upstream_id = ? AND id IN (${placeholders})`).run(params.id, ...body.keyIds);
      return ok(null, `Deleted ${body.keyIds.length} keys`);
    },
    { body: t.Object({ keyIds: t.Array(t.String()) }) }
  )

  // POST /api/upstreams/:id/keys/toggle-all
  .post(
    "/:id/keys/toggle-all",
    ({ params, body }) => {
      const db = getDb();
      if (body?.enableAll) db.prepare("UPDATE upstream_keys SET is_active = 1 WHERE upstream_id = ?").run(params.id);
      else if (body?.disableAll) db.prepare("UPDATE upstream_keys SET is_active = 0 WHERE upstream_id = ?").run(params.id);
      const keys = db.prepare("SELECT * FROM upstream_keys WHERE upstream_id = ?").all(params.id) as UpstreamKey[];
      return ok(keys.map(parseUpKey));
    },
    { body: t.Optional(t.Object({ enableAll: t.Optional(t.Boolean()), disableAll: t.Optional(t.Boolean()) })) }
  )

  // POST /api/upstreams/:id/keys/toggle
  .post(
    "/:id/keys/toggle",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT * FROM upstream_keys WHERE id = ? AND upstream_id = ?").get(body.keyId, params.id) as UpstreamKey | undefined;
      if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }
      const newActive = body.isActive !== undefined ? (body.isActive ? 1 : 0) : (existing.is_active ? 0 : 1);
      db.prepare("UPDATE upstream_keys SET is_active = ? WHERE id = ?").run(newActive, body.keyId);
      const row = db.prepare("SELECT * FROM upstream_keys WHERE id = ?").get(body.keyId) as UpstreamKey;
      return ok(parseUpKey(row));
    },
    { body: t.Object({ keyId: t.String(), isActive: t.Optional(t.Boolean()) }) }
  )

  // POST /api/upstreams/:id/keys/:keyId/test
  .post("/:id/keys/:keyId/test", async ({ params, set }) => {
    const db = getDb();
    const up = db.prepare("SELECT * FROM upstreams WHERE id = ?").get(params.id) as Upstream | undefined;
    if (!up) { set.status = 404; return { success: false, error: "Upstream not found" }; }
    const key = db.prepare("SELECT * FROM upstream_keys WHERE id = ? AND upstream_id = ?").get(params.keyId, params.id) as UpstreamKey | undefined;
    if (!key) { set.status = 404; return { success: false, error: "Key not found" }; }
    try {
      const baseUrl = up.base_url ?? defaultBaseFor(up.provider);
      if (!baseUrl) return ok({ ok: false, error: `No endpoint configured for provider "${up.provider}". Add it to provider.json`, keyId: params.keyId });
      const headers = authHeadersFor(up.provider, key.key);
      const res = await fetch(`${baseUrl}/v1/models`, { headers });
      return ok({ ok: res.ok, statusCode: res.status, keyId: params.keyId });
    } catch (e) {
      const err = String(e);
      return ok({ ok: false, error: isProviderQuotaError(err) ? "can't connect to router, we're lookin for it, try again later!" : err, keyId: params.keyId });
    }
  });
