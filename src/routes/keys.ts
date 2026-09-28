import { Elysia, t } from "elysia";
import { getDb } from "../lib/db";
import { newId, newKey, ok } from "../lib/utils";

type ClientKey = {
  id: string;
  name: string;
  key: string;
  api_key_id: string | null;
  is_active: number;
  token_limit: number | null;
  used_tokens: number;
  rate_limit: number | null;
  allowed_providers: string;
  round_robin_providers: number;
  is_follow_upstream: number;
  created_at: string;
  updated_at: string;
};

function parseKey(row: ClientKey) {
  const tokenLimit = row.token_limit;
  const usedTokens = row.used_tokens;
  const remainingTokens = tokenLimit !== null ? Math.max(0, tokenLimit - usedTokens) : null;
  const quotaExhausted = tokenLimit !== null && usedTokens >= tokenLimit;

  return {
    id: row.id,
    name: row.name,
    key: row.key,
    apiKeyId: row.api_key_id,
    isActive: !!row.is_active,
    tokenLimit,
    usedTokens,
    remainingTokens,
    quotaExhausted,
    rateLimit: row.rate_limit,
    allowedProviders: JSON.parse(row.allowed_providers),
    roundRobinProviders: !!row.round_robin_providers,
    isFollowUpstream: !!row.is_follow_upstream,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const keysRoutes = new Elysia({ prefix: "/api/keys" })
  // GET /api/keys/
  .get("/", () => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM client_keys ORDER BY created_at DESC").all() as ClientKey[];
    return ok(rows.map(parseKey));
  })

  // GET /api/keys/:id — single key with quota status
  .get("/:id", ({ params, set }) => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey | undefined;
    if (!row) { set.status = 404; return { success: false, error: "Key not found" }; }
    return ok(parseKey(row));
  })

  // POST /api/keys/
  .post(
    "/",
    ({ body }) => {
      const db = getDb();
      const id = newId();
      const key = body.customKey ?? newKey("rzk");
      db.prepare(
        `INSERT INTO client_keys (id, name, key, api_key_id, token_limit, rate_limit, allowed_providers, round_robin_providers, is_follow_upstream)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.name,
        key,
        body.apiKeyId ?? null,
        body.tokenLimit ?? null,
        body.rateLimit ?? null,
        JSON.stringify(body.allowedProviders ?? []),
        body.roundRobinProviders ? 1 : 0,
        body.isFollowUpstream ? 1 : 0
      );
      const row = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(id) as ClientKey;
      return ok(parseKey(row));
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        apiKeyId: t.Optional(t.String()),
        customKey: t.Optional(t.String()),
        tokenLimit: t.Optional(t.Nullable(t.Number())),
        rateLimit: t.Optional(t.Nullable(t.Number())),
        allowedProviders: t.Optional(t.Array(t.String())),
        roundRobinProviders: t.Optional(t.Boolean()),
        isFollowUpstream: t.Optional(t.Boolean()),
      }),
    }
  )

  // PATCH /api/keys/:id — general update
  .patch(
    "/:id",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey | undefined;
      if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
      if (body.apiKeyId !== undefined) { updates.push("api_key_id = ?"); values.push(body.apiKeyId); }
      if (body.isActive !== undefined) { updates.push("is_active = ?"); values.push(body.isActive ? 1 : 0); }
      if (body.rateLimit !== undefined) { updates.push("rate_limit = ?"); values.push(body.rateLimit); }

      // Token limit: set absolute OR apply delta (delta takes precedence if both given)
      if (body.adjustTokenLimit !== undefined) {
        // ADDITIVE: used for top-up (e.g. +50_000_000)
        const cur = existing.token_limit ?? 0;
        updates.push("token_limit = ?"); values.push(cur + body.adjustTokenLimit);
      } else if (body.tokenLimit !== undefined) {
        // ABSOLUTE SET: override limit
        updates.push("token_limit = ?"); values.push(body.tokenLimit);
      }

      // usedTokens: set absolute OR apply delta
      if (body.usedTokens !== undefined) { updates.push("used_tokens = ?"); values.push(body.usedTokens); }
      else if (body.adjustTokens !== undefined) {
        const cur = existing.used_tokens;
        updates.push("used_tokens = ?"); values.push(cur + body.adjustTokens);
      }
      if (body.resetUsedTokens) { updates.push("used_tokens = ?"); values.push(0); }

      if (body.allowedProviders !== undefined) { updates.push("allowed_providers = ?"); values.push(JSON.stringify(body.allowedProviders)); }
      if (body.roundRobinProviders !== undefined) { updates.push("round_robin_providers = ?"); values.push(body.roundRobinProviders ? 1 : 0); }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(params.id);
        db.prepare(`UPDATE client_keys SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      }

      const row = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey;
      return ok(parseKey(row));
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        apiKeyId: t.Optional(t.Nullable(t.String())),
        isActive: t.Optional(t.Boolean()),
        tokenLimit: t.Optional(t.Nullable(t.Number())),
        rateLimit: t.Optional(t.Nullable(t.Number())),
        adjustTokenLimit: t.Optional(t.Number()),
        usedTokens: t.Optional(t.Number()),
        adjustTokens: t.Optional(t.Number()),
        resetUsedTokens: t.Optional(t.Boolean()),
        allowedProviders: t.Optional(t.Array(t.String())),
        roundRobinProviders: t.Optional(t.Boolean()),
      }),
    }
  )

  // DELETE /api/keys/:id
  .delete("/:id", ({ params, set }) => {
    const db = getDb();
    const existing = db.prepare("SELECT id FROM client_keys WHERE id = ?").get(params.id);
    if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }
    db.prepare("DELETE FROM client_keys WHERE id = ?").run(params.id);
    return ok(null, "Deleted");
  })

  // POST /api/keys/:id/topup
  // Commercial top-up endpoint. Adds tokens to existing tokenLimit.
  // Example: user buys 50M tokens → { tokens: 50_000_000 }
  //          user tops up +50M  → { tokens: 50_000_000 } again → total 100M limit
  .post(
    "/:id/topup",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey | undefined;
      if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }

      const addTokens = body.tokens;
      if (addTokens <= 0) { set.status = 400; return { success: false, error: "tokens must be positive" }; }

      const prevLimit = existing.token_limit ?? 0;
      const newLimit = prevLimit + addTokens;

      db.prepare(
        "UPDATE client_keys SET token_limit = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newLimit, params.id);

      const row = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey;
      const parsed = parseKey(row);

      return ok({
        ...parsed,
        topup: {
          addedTokens: addTokens,
          previousLimit: prevLimit,
          newLimit,
          message: `Successfully added ${addTokens.toLocaleString()} tokens. New limit: ${newLimit.toLocaleString()}.`,
        },
      });
    },
    {
      body: t.Object({
        tokens: t.Number({ minimum: 1, description: "Number of tokens to add to this key's quota" }),
        note: t.Optional(t.String({ description: "Optional purchase reference or note" })),
      }),
    }
  )

  // POST /api/keys/:id/rotate
  .post(
    "/:id/rotate",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT id FROM client_keys WHERE id = ?").get(params.id);
      if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }
      const newk = body?.customKey ?? newKey("rzk");
      db.prepare("UPDATE client_keys SET key = ?, updated_at = datetime('now') WHERE id = ?").run(newk, params.id);
      const row = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey;
      return ok(parseKey(row));
    },
    { body: t.Optional(t.Object({ customKey: t.Optional(t.String()) })) }
  )

  // POST /api/keys/:id/regenerate
  .post(
    "/:id/regenerate",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT id FROM client_keys WHERE id = ?").get(params.id);
      if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }
      const newk = body?.customKey ?? newKey("rzk");
      db.prepare("UPDATE client_keys SET key = ?, updated_at = datetime('now') WHERE id = ?").run(newk, params.id);
      const row = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey;
      return ok(parseKey(row));
    },
    { body: t.Optional(t.Object({ customKey: t.Optional(t.String()) })) }
  )

  // POST /api/keys/:id/adjust-quota
  .post(
    "/:id/adjust-quota",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey | undefined;
      if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body?.setTokenLimit !== undefined) { updates.push("token_limit = ?"); values.push(body.setTokenLimit); }
      else if (body?.deltaTokenLimit !== undefined) {
        updates.push("token_limit = ?"); values.push((existing.token_limit ?? 0) + body.deltaTokenLimit);
      }
      if (body?.setUsedTokens !== undefined) { updates.push("used_tokens = ?"); values.push(body.setUsedTokens); }
      else if (body?.deltaUsedTokens !== undefined) {
        updates.push("used_tokens = ?"); values.push(existing.used_tokens + body.deltaUsedTokens);
      }
      if (body?.resetUsed) { updates.push("used_tokens = ?"); values.push(0); }
      if (body?.setRateLimit !== undefined) { updates.push("rate_limit = ?"); values.push(body.setRateLimit); }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(params.id);
        db.prepare(`UPDATE client_keys SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      }

      const row = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey;
      return ok(parseKey(row));
    },
    {
      body: t.Optional(t.Object({
        deltaTokenLimit: t.Optional(t.Number()),
        setTokenLimit: t.Optional(t.Nullable(t.Number())),
        deltaUsedTokens: t.Optional(t.Number()),
        setUsedTokens: t.Optional(t.Number()),
        resetUsed: t.Optional(t.Boolean()),
        setRateLimit: t.Optional(t.Nullable(t.Number())),
      })),
    }
  )

  // POST /api/keys/:id/reset-quota
  .post("/:id/reset-quota", ({ params, set }) => {
    const db = getDb();
    const existing = db.prepare("SELECT id FROM client_keys WHERE id = ?").get(params.id);
    if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }
    db.prepare("UPDATE client_keys SET used_tokens = 0, updated_at = datetime('now') WHERE id = ?").run(params.id);
    return ok(null, "Quota reset — usedTokens cleared to 0");
  })

  // POST /api/keys/:id/toggle-provider
  .post(
    "/:id/toggle-provider",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey | undefined;
      if (!existing) { set.status = 404; return { success: false, error: "Key not found" }; }
      const providers: string[] = JSON.parse(existing.allowed_providers);
      const { providerId, allowed } = body;
      if (allowed === true && !providers.includes(providerId)) {
        providers.push(providerId);
      } else if (allowed === false) {
        const idx = providers.indexOf(providerId);
        if (idx !== -1) providers.splice(idx, 1);
      } else if (allowed === undefined) {
        const idx = providers.indexOf(providerId);
        if (idx !== -1) providers.splice(idx, 1);
        else providers.push(providerId);
      }
      db.prepare("UPDATE client_keys SET allowed_providers = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(providers), params.id);
      const row = db.prepare("SELECT * FROM client_keys WHERE id = ?").get(params.id) as ClientKey;
      return ok(parseKey(row));
    },
    { body: t.Object({ providerId: t.String(), allowed: t.Optional(t.Boolean()) }) }
  )

  // POST /api/keys/batch-delete
  .post(
    "/batch-delete",
    ({ body }) => {
      const db = getDb();
      const placeholders = body.ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM client_keys WHERE id IN (${placeholders})`).run(...body.ids);
      return ok(null, `Deleted ${body.ids.length} keys`);
    },
    { body: t.Object({ ids: t.Array(t.String()) }) }
  );
