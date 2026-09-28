import { Elysia } from "elysia";
import { ok } from "../lib/utils";
import { loadProviders } from "../lib/providers";

export const providersRoutes = new Elysia({ prefix: "/api/providers" })
  // GET /api/providers/ — provider registry from provider.json (hot-reload on file change)
  .get("/", () => ok(loadProviders()));
