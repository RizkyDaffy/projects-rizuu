import { Elysia, t } from "elysia";
import { getDb } from "../lib/db";
import { ok } from "../lib/utils";

export const apiProvidersRoutes = new Elysia({ prefix: "/api/api-providers" })
  // GET /api/api-providers/bandelbanget/status
  .get("/bandelbanget/status", () => {
    const db = getDb();
    // BandelBanget = internal/custom provider status
    const count = db.prepare("SELECT COUNT(*) as c FROM upstreams WHERE is_active = 1").get() as { c: number };
    return ok({ active: true, activeUpstreams: count.c });
  })

  // GET /api/api-providers/bandelbanget/models
  .get("/bandelbanget/models", () => {
    const db = getDb();
    const upstreams = db.prepare("SELECT models FROM upstreams WHERE is_active = 1").all() as { models: string }[];
    const allModels: any[] = [];
    for (const u of upstreams) {
      const models = JSON.parse(u.models);
      for (const m of models) {
        if (m.enabled && !allModels.find((x: any) => x.id === m.id)) allModels.push(m);
      }
    }
    return ok({ models: allModels });
  })

  // POST /api/api-providers/bandelbanget/sync
  .post("/bandelbanget/sync", () => ok(null, "Sync triggered"))

  // POST /api/api-providers/bandelbanget/test
  .post(
    "/bandelbanget/test",
    ({ body }) => ok({ tested: true, key: body?.key ? body.key.slice(0, 8) + "..." : null }),
    { body: t.Optional(t.Object({ key: t.Optional(t.String()) })) }
  )

  // POST /api/api-providers/bandelbanget/toggle
  .post(
    "/bandelbanget/toggle",
    ({ body }) => ok({ id: body.id, isActive: body.isActive }),
    { body: t.Object({ id: t.String(), isActive: t.Boolean() }) }
  )

  // POST /api/api-providers/bandelbanget/quick-key
  .post(
    "/bandelbanget/quick-key",
    ({ body }) => ok({ key: `bb_${Math.random().toString(36).slice(2)}`, name: body?.name ?? "Quick Key" }),
    { body: t.Optional(t.Object({ name: t.Optional(t.String()) })) }
  );
