import { Elysia, t } from "elysia";
import { getDb } from "../lib/db";
import { newId, newKey, ok } from "../lib/utils";

type RouterKey = {
  id: string;
  name: string;
  description: string | null;
  key: string;
  is_active: number;
  created_at: string;
  updated_at: string;
};

function parseKey(row: RouterKey) {
  return {
    ...row,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const routerKeysRoutes = new Elysia({ prefix: "/api/router-keys" })
  // GET /api/router-keys/
  .get("/", () => {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM router_keys ORDER BY created_at DESC").all() as RouterKey[];
    return ok(rows.map(parseKey));
  })
  // POST /api/router-keys/
  .post(
    "/",
    ({ body }) => {
      const db = getDb();
      const id = newId();
      const key = body.customKey ?? newKey("rrk");
      db.prepare(
        "INSERT INTO router_keys (id, name, description, key) VALUES (?, ?, ?, ?)"
      ).run(id, body.name, body.description ?? null, key);
      const row = db.prepare("SELECT * FROM router_keys WHERE id = ?").get(id) as RouterKey;
      return ok(parseKey(row));
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        customKey: t.Optional(t.String()),
      }),
    }
  )
  // PATCH /api/router-keys/:id
  .patch(
    "/:id",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT id FROM router_keys WHERE id = ?").get(params.id);
      if (!existing) { set.status = 404; return { success: false, error: "Router key not found" }; }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
      if (body.description !== undefined) { updates.push("description = ?"); values.push(body.description); }
      if (body.isActive !== undefined) { updates.push("is_active = ?"); values.push(body.isActive ? 1 : 0); }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')");
        values.push(params.id);
        db.prepare(`UPDATE router_keys SET ${updates.join(", ")} WHERE id = ?`).run(...values);
      }

      const row = db.prepare("SELECT * FROM router_keys WHERE id = ?").get(params.id) as RouterKey;
      return ok(parseKey(row));
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        description: t.Optional(t.Nullable(t.String())),
        isActive: t.Optional(t.Boolean()),
      }),
    }
  )
  // DELETE /api/router-keys/:id
  .delete("/:id", ({ params, set }) => {
    const db = getDb();
    const existing = db.prepare("SELECT id FROM router_keys WHERE id = ?").get(params.id);
    if (!existing) { set.status = 404; return { success: false, error: "Router key not found" }; }
    db.prepare("DELETE FROM router_keys WHERE id = ?").run(params.id);
    return ok(null, "Deleted");
  })
  // PATCH /api/router-keys/:id/toggle
  .patch("/:id/toggle", ({ params, set }) => {
    const db = getDb();
    const existing = db.prepare("SELECT * FROM router_keys WHERE id = ?").get(params.id) as RouterKey | undefined;
    if (!existing) { set.status = 404; return { success: false, error: "Router key not found" }; }
    db.prepare("UPDATE router_keys SET is_active = ?, updated_at = datetime('now') WHERE id = ?").run(
      existing.is_active ? 0 : 1, params.id
    );
    const row = db.prepare("SELECT * FROM router_keys WHERE id = ?").get(params.id) as RouterKey;
    return ok(parseKey(row));
  })
  // POST /api/router-keys/:id/rotate
  .post(
    "/:id/rotate",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT id FROM router_keys WHERE id = ?").get(params.id);
      if (!existing) { set.status = 404; return { success: false, error: "Router key not found" }; }
      const newk = body?.customKey ?? newKey("rrk");
      db.prepare("UPDATE router_keys SET key = ?, updated_at = datetime('now') WHERE id = ?").run(newk, params.id);
      const row = db.prepare("SELECT * FROM router_keys WHERE id = ?").get(params.id) as RouterKey;
      return ok(parseKey(row));
    },
    { body: t.Optional(t.Object({ customKey: t.Optional(t.String()) })) }
  )
  // POST /api/router-keys/:id/regenerate
  .post(
    "/:id/regenerate",
    ({ params, body, set }) => {
      const db = getDb();
      const existing = db.prepare("SELECT id FROM router_keys WHERE id = ?").get(params.id);
      if (!existing) { set.status = 404; return { success: false, error: "Router key not found" }; }
      const newk = body?.customKey ?? newKey("rrk");
      db.prepare("UPDATE router_keys SET key = ?, updated_at = datetime('now') WHERE id = ?").run(newk, params.id);
      const row = db.prepare("SELECT * FROM router_keys WHERE id = ?").get(params.id) as RouterKey;
      return ok(parseKey(row));
    },
    { body: t.Optional(t.Object({ customKey: t.Optional(t.String()) })) }
  )
  // POST /api/router-keys/batch-delete
  .post(
    "/batch-delete",
    ({ body }) => {
      const db = getDb();
      const placeholders = body.ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM router_keys WHERE id IN (${placeholders})`).run(...body.ids);
      return ok(null, `Deleted ${body.ids.length} router keys`);
    },
    { body: t.Object({ ids: t.Array(t.String()) }) }
  );
