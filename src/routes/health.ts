import { Elysia } from "elysia";
import { getDb } from "../lib/db";
import { ok } from "../lib/utils";

export const healthRoute = new Elysia().get("/health", () => {
  const db = getDb();
  return ok({ status: "ok", timestamp: new Date().toISOString() });
});
