import { Elysia, t } from "elysia";
import { getDb } from "../lib/db";
import { ok } from "../lib/utils";
import { join } from "path";
import os from "os";

const SETTING_KEYS = [
  "cache_enabled",
  "rtk_compression",
  "caveman_mode",
  "minify_prompt",
  "cache_ttl_seconds",
  "https_only",
  "request_timeout_seconds",
  "model_prefix_enabled",
] as const;

function getSettings(db: ReturnType<typeof getDb>) {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    cacheEnabled: map.cache_enabled === "true",
    rtkCompression: map.rtk_compression === "true",
    cavemanMode: map.caveman_mode === "true",
    minifyPrompt: map.minify_prompt === "true",
    cacheTtlSeconds: parseFloat(map.cache_ttl_seconds ?? "300"),
    httpsOnly: map.https_only === "true",
    requestTimeoutSeconds: parseFloat(map.request_timeout_seconds ?? "60"),
    modelPrefixEnabled: map.model_prefix_enabled === "true",
  };
}

export const adminRoutes = new Elysia({ prefix: "/api/admin" })
  // GET /api/admin/settings/optimizations
  .get("/settings/optimizations", () => {
    const db = getDb();
    return ok(getSettings(db));
  })

  // POST /api/admin/settings/optimizations
  .post(
    "/settings/optimizations",
    ({ body }) => {
      const db = getDb();
      const map: Record<string, string> = {
        cacheEnabled: "cache_enabled",
        rtkCompression: "rtk_compression",
        cavemanMode: "caveman_mode",
        minifyPrompt: "minify_prompt",
        cacheTtlSeconds: "cache_ttl_seconds",
        httpsOnly: "https_only",
        requestTimeoutSeconds: "request_timeout_seconds",
        modelPrefixEnabled: "model_prefix_enabled",
      };
      const update = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
      for (const [jsKey, dbKey] of Object.entries(map)) {
        const val = (body as any)[jsKey];
        if (val !== undefined) update.run(String(val), dbKey);
      }
      return ok(getSettings(db));
    },
    {
      body: t.Optional(t.Object({
        cacheEnabled: t.Optional(t.Boolean()),
        rtkCompression: t.Optional(t.Boolean()),
        cavemanMode: t.Optional(t.Boolean()),
        minifyPrompt: t.Optional(t.Boolean()),
        cacheTtlSeconds: t.Optional(t.Number()),
        httpsOnly: t.Optional(t.Boolean()),
        requestTimeoutSeconds: t.Optional(t.Number()),
        modelPrefixEnabled: t.Optional(t.Boolean()),
      })),
    }
  )

  // POST /api/admin/cache/clear
  .post("/cache/clear", () => ok(null, "Cache cleared"))

  // GET /api/admin/system
  .get("/system", () => {
    return ok({
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
      uptimeSeconds: os.uptime(),
      nodeVersion: process.version,
      bunVersion: typeof Bun !== "undefined" ? Bun.version : null,
    });
  })

  // GET /api/admin/db/export
  .get("/db/export", () => {
    const db = getDb();
    // Export all tables as JSON
    const keys = db.prepare("SELECT * FROM client_keys").all();
    const routerKeys = db.prepare("SELECT * FROM router_keys").all();
    const upstreams = db.prepare("SELECT * FROM upstreams").all();
    const upstreamKeys = db.prepare("SELECT * FROM upstream_keys").all();
    const settings = db.prepare("SELECT * FROM settings").all();
    const telemetry = db.prepare("SELECT * FROM telemetry_logs ORDER BY created_at DESC LIMIT 10000").all();

    const exportData = JSON.stringify({ keys, routerKeys, upstreams, upstreamKeys, settings, telemetry }, null, 2);
    return new Response(exportData, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="rizuu-export-${Date.now()}.json"`,
      },
    });
  })

  // POST /api/admin/db/import
  .post(
    "/db/import",
    async ({ body, set }) => {
      try {
        const db = getDb();
        let data: any;

        if (body.file instanceof File) {
          const text = await body.file.text();
          data = JSON.parse(text);
        } else if (typeof body.file === "string") {
          data = JSON.parse(body.file);
        } else {
          set.status = 400;
          return { success: false, error: "Invalid file" };
        }

        // Import settings
        if (data.settings) {
          for (const s of data.settings) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(s.key, s.value);
          }
        }
        // Import upstreams
        if (data.upstreams) {
          for (const u of data.upstreams) {
            db.prepare(`INSERT OR REPLACE INTO upstreams (id, name, provider, prefix, base_url, weight, round_robin, follow_upstream, is_active, models, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              u.id, u.name, u.provider, u.prefix, u.base_url, u.weight, u.round_robin,
              u.follow_upstream, u.is_active, u.models, u.created_at, u.updated_at
            );
          }
        }
        if (data.upstreamKeys) {
          for (const k of data.upstreamKeys) {
            db.prepare("INSERT OR REPLACE INTO upstream_keys (id, upstream_id, name, key, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
              k.id, k.upstream_id, k.name, k.key, k.is_active, k.created_at
            );
          }
        }
        if (data.keys) {
          for (const k of data.keys) {
            db.prepare(`INSERT OR REPLACE INTO client_keys (id, name, key, api_key_id, is_active, token_limit, used_tokens, rate_limit, allowed_providers, round_robin_providers, is_follow_upstream, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              k.id, k.name, k.key, k.api_key_id, k.is_active, k.token_limit, k.used_tokens,
              k.rate_limit, k.allowed_providers, k.round_robin_providers, k.is_follow_upstream, k.created_at, k.updated_at
            );
          }
        }
        if (data.routerKeys) {
          for (const k of data.routerKeys) {
            db.prepare("INSERT OR REPLACE INTO router_keys (id, name, description, key, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
              k.id, k.name, k.description, k.key, k.is_active, k.created_at, k.updated_at
            );
          }
        }

        return ok(null, "Import complete");
      } catch (e) {
        set.status = 500;
        return { success: false, error: String(e) };
      }
    },
    { body: t.Object({ file: t.Any() }) }
  );
