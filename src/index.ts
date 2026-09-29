import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { staticPlugin } from "@elysiajs/static";

import { healthRoute } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { keysRoutes } from "./routes/keys";
import { routerKeysRoutes } from "./routes/router-keys";
import { upstreamsRoutes } from "./routes/upstreams";
import { providersRoutes } from "./routes/providers";
import { apiProvidersRoutes } from "./routes/api-providers";
import { telemetryRoutes } from "./routes/telemetry";
import { adminRoutes } from "./routes/admin";
import { modelsRoutes } from "./routes/models";
import { proxyRoutes } from "./routes/proxy";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;

const app = new Elysia()
  .use(cors({ origin: true, credentials: true }))
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "Rizuu-Router API Gateway",
          version: "1.0.0",
          description:
            "Ultra-low latency AI Gateway & Router for OpenAI and Anthropic compatible endpoints",
        },
      },
    })
  )
  .use(healthRoute)
  .use(authRoutes)
  .use(keysRoutes)
  .use(routerKeysRoutes)
  .use(upstreamsRoutes)
  .use(providersRoutes)
  .use(apiProvidersRoutes)
  .use(telemetryRoutes)
  .use(adminRoutes)
  .use(modelsRoutes)
  .use(proxyRoutes)
  .use(staticPlugin({ assets: "public", prefix: "" }))
  .get("/", () => Bun.file("public/index.html"))
  .get("/dashboard", () => Bun.file("public/index.html"))
  .listen(PORT);

console.log(`🚀 rizuu backend running at http://localhost:${PORT}`);

export { app };
export type App = typeof app;
