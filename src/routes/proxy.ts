import { Elysia } from "elysia";
import { getDb } from "../lib/db";
import { newId } from "../lib/utils";
import { endpointFor, authStyleFor } from "../lib/providers";
import os from "os";

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
  models: string;
};

type UpstreamKey = {
  id: string;
  upstream_id: string;
  key: string;
  is_active: number;
};

type ClientKey = {
  id: string;
  name: string;
  key: string;
  is_active: number;
  token_limit: number | null;
  used_tokens: number;
  rate_limit: number | null;
  allowed_providers: string;
  round_robin_providers: number;
};

/** Commercial quota check.
 * Returns null if allowed, or an error Response if blocked. */
function checkQuota(clientKey: ClientKey): Response | null {
  if (!clientKey) return null;

  // Key disabled
  if (!clientKey.is_active) {
    return quotaError(403, "API key is inactive.", "key_inactive");
  }

  // Token limit enforced (commercial quota)
  if (clientKey.token_limit !== null) {
    const remaining = clientKey.token_limit - clientKey.used_tokens;
    if (remaining <= 0) {
      return quotaError(402, "Your quota has been exhausted. Purchase additional tokens to continue.", "quota_exhausted", {
        tokenLimit: clientKey.token_limit,
        usedTokens: clientKey.used_tokens,
        remainingTokens: 0,
      });
    }
  }

  return null;
}

function quotaError(status: number, message: string, code: string, meta?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "quota_error",
        code,
        ...(meta ?? {}),
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}

// Weighted random upstream selector
function selectUpstream(upstreams: Upstream[]): Upstream | null {
  if (!upstreams.length) return null;
  const total = upstreams.reduce((s, u) => s + u.weight, 0);
  let r = Math.random() * total;
  for (const u of upstreams) {
    r -= u.weight;
    if (r <= 0) return u;
  }
  return upstreams[0];
}

// Weighted-random permutation — failover order respects weight
function weightedOrder(list: Upstream[]): Upstream[] {
  const pool = [...list];
  const order: Upstream[] = [];
  while (pool.length) {
    const pick = selectUpstream(pool)!;
    order.push(pick);
    pool.splice(pool.indexOf(pick), 1);
  }
  return order;
}

type ParsedUpModel = { id: string; name?: string; enabled: boolean };

function parseUpModels(u: Upstream): ParsedUpModel[] {
  try {
    const list = JSON.parse(u.models);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

/** Does upstream serve requested model? Handles `prefix/model` alias → raw id rewrite. */
function matchUpstreamModel(u: Upstream, model: string): { has: boolean; forwardAs: string } {
  for (const m of parseUpModels(u)) {
    if (!m.enabled) continue;
    if (u.prefix && `${u.prefix}/${m.id}` === model) return { has: true, forwardAs: m.id };
    if (m.id === model) return { has: true, forwardAs: model };
  }
  return { has: false, forwardAs: model };
}

type Candidate = { upstream: Upstream; forwardModel: string };

/**
 * Model-aware candidate ranking (NekoRouter-style):
 * upstreams declaring the requested model first (weighted order),
 * else all active upstreams (model list never synced → old behavior).
 */
function rankCandidates(upstreams: Upstream[], requestedModel: string | null): Candidate[] {
  if (requestedModel) {
    const matched = upstreams.filter((u) => matchUpstreamModel(u, requestedModel).has);
    if (matched.length) {
      return weightedOrder(matched).map((u) => ({
        upstream: u,
        forwardModel: matchUpstreamModel(u, requestedModel).forwardAs,
      }));
    }
  }
  return weightedOrder(upstreams).map((u) => ({ upstream: u, forwardModel: requestedModel ?? "" }));
}

// ── Upstream error shielding (commercial branding) ─────────────────────────
// Raw upstream/provider errors NEVER reach clients: bodies, provider names,
// billing URLs, request ids are all replaced by one generic Rizuu message.
function genericUpstreamError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "can't connect to router, we're lookin for it, try again later!",
        type: "server_error",
        code: "router_unavailable",
      },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

type Screened = { ok: boolean; res: Response | null };

/**
 * Body-level error screening: relays return quota/credit errors with HTTP 200
 * (plain text, error JSON without `error` key, or SSE `data: {...}` frames).
 * A chat completion is ONLY valid if it carries `choices` — anything else
 * (quota text, error payloads, garbage) is shielded, never forwarded.
 */
async function screenUpstreamResponse(r: Response): Promise<Screened> {
  if (!r.ok) return { ok: false, res: null };

  const ct = r.headers.get("content-type") ?? "";

  // ── SSE stream: peek first chunk, pass only real completion frames ──
  if (ct.includes("text/event-stream")) {
    if (!r.body) return { ok: false, res: null };
    const reader = r.body.getReader();
    const first = await reader.read().catch(() => ({ done: true, value: undefined as Uint8Array | undefined }));
    if (first.done || !first.value) {
      try { reader.cancel(); } catch (_) { }
      return { ok: false, res: null };
    }
    const head = new TextDecoder().decode(first.value);
    if (!head.includes('"choices"')) {
      try { reader.cancel(); } catch (_) { }
      return { ok: false, res: null };
    }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(first.value!);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (_) { }
        try { controller.close(); } catch (_) { }
      },
    });
    const headers = new Headers(r.headers);
    headers.delete("content-length");
    return { ok: true, res: new Response(stream, { status: r.status, headers }) };
  }

  // ── Buffered body: must contain a chat completion (`choices`) ──
  const text = await r.text().catch(() => "");
  if (!text.includes('"choices"')) return { ok: false, res: null };
  const headers = new Headers(r.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return { ok: true, res: new Response(text, { status: r.status, headers }) };
}

// Round-robin cursor per upstream
const rrState: Record<string, number> = {};

function getUpstreamKey(
  upstreamId: string,
  roundRobin: boolean,
  db: ReturnType<typeof getDb>
): UpstreamKey | null {
  const keys = db
    .prepare("SELECT * FROM upstream_keys WHERE upstream_id = ? AND is_active = 1")
    .all(upstreamId) as UpstreamKey[];
  if (!keys.length) return null;
  if (roundRobin) {
    rrState[upstreamId] = (rrState[upstreamId] ?? 0) % keys.length;
    const key = keys[rrState[upstreamId]];
    rrState[upstreamId]++;
    return key;
  }
  return keys[Math.floor(Math.random() * keys.length)];
}

async function proxyRequest(
  req: Request,
  provider: string,
  upstream: Upstream,
  apiKey: string
): Promise<Response> {
  const baseUrl = upstream.base_url ?? endpointFor(provider);
  if (!baseUrl) {
    return genericUpstreamError();
  }
  const url = new URL(req.url);
  const targetUrl = `${baseUrl}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  if (authStyleFor(provider) === "anthropic") {
    headers.set("x-api-key", apiKey);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  return fetch(targetUrl, { method: req.method, headers, body: req.body });
}

/** Extract token usage from a completed (non-stream) response body */
async function extractTokens(
  res: Response,
  provider: "openai" | "anthropic"
): Promise<{ prompt_tokens: number; completion_tokens: number; total_tokens: number }> {
  try {
    const clone = res.clone();
    const json = (await clone.json()) as any;
    if (provider === "openai" && json.usage) {
      return {
        prompt_tokens: json.usage.prompt_tokens ?? 0,
        completion_tokens: json.usage.completion_tokens ?? 0,
        total_tokens: json.usage.total_tokens ?? 0,
      };
    }
    if (provider === "anthropic" && json.usage) {
      const p = json.usage.input_tokens ?? 0;
      const c = json.usage.output_tokens ?? 0;
      return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
    }
  } catch (_) { }
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/** Write telemetry + deduct tokens from client key quota atomically (SQLite WAL is fine) */
function recordUsage(
  db: ReturnType<typeof getDb>,
  clientKey: ClientKey | null,
  upstream: Upstream,
  model: string | null,
  tokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
  latency: number,
  status: number
) {
  db.prepare(
    `INSERT INTO telemetry_logs
       (id, client_key_id, upstream_id, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId(),
    clientKey?.id ?? null,
    upstream.id,
    model,
    tokens.prompt_tokens,
    tokens.completion_tokens,
    tokens.total_tokens,
    latency,
    status
  );

  if (clientKey && tokens.total_tokens > 0) {
    db.prepare(
      "UPDATE client_keys SET used_tokens = used_tokens + ?, updated_at = datetime('now') WHERE id = ?"
    ).run(tokens.total_tokens, clientKey.id);
  }
}

function getClientKey(
  db: ReturnType<typeof getDb>,
  rawKey: string
): ClientKey | null {
  if (!rawKey) return null;
  return (
    (db
      .prepare("SELECT * FROM client_keys WHERE key = ? AND is_active = 1")
      .get(rawKey) as ClientKey) ?? null
  );
}

const START_TIME = Date.now();

function fmtUptime(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}
const fmtMB = (b: number) => `${(b / 1048576).toFixed(2)} MB`;
const fmtGB = (b: number) => `${(b / 1073741824).toFixed(2)} GB`;

/** Gateway diagnostics — 1:1 NekoRouter /v1 shape (flat, no ok() wrapper) */
function gatewayInfo() {
  const cpus = os.cpus();
  const mem = process.memoryUsage();
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  return {
    status: "online",
    gateway: "Rizuu-Router",
    version: "1.0.0",
    motivation: {
      quote: "Tetap tenang, berpikir jernih, dan selesaikan tantangan baris demi baris.",
      author: "Rizuu-Router",
    },
    server: {
      runtime: `Bun v${Bun.version}`,
      platform: `${os.platform()} (${os.arch()})`,
      os: `${os.type()} ${os.release()}`,
      cpus: { model: cpus[0]?.model ?? "unknown", cores: cpus.length },
      memory: {
        rss: fmtMB(mem.rss),
        heap_used: fmtMB(mem.heapUsed),
        heap_total: fmtMB(mem.heapTotal),
        system_total_ram: fmtGB(os.totalmem()),
        system_free_ram: fmtGB(os.freemem()),
      },
      uptime: fmtUptime(uptimeSeconds),
      uptime_seconds: uptimeSeconds,
      timestamp: new Date().toISOString(),
    },
    endpoints: [
      {
        method: "POST",
        path: "/v1/chat/completions",
        auth: "Bearer <client_key> or x-api-key: <client_key>",
        description:
          "OpenAI-compatible Chat Completions API with streaming, prompt caching, failover routing, and token telemetry.",
      },
      {
        method: "POST",
        path: "/v1/messages",
        auth: "x-api-key: <client_key> or Bearer <client_key>",
        description: "Anthropic-compatible Messages API with full streaming and thinking protocol support.",
      },
      {
        method: "GET",
        path: "/v1/models",
        auth: "Public / Optional Client Key",
        description: "List all active AI models across connected upstream providers in OpenAI format.",
      },
      {
        method: "GET",
        path: "/models",
        auth: "Public / Optional Client Key",
        description: "Standard OpenAI alias for /v1/models.",
      },
      {
        method: "GET",
        path: "/health",
        auth: "Public",
        description: "Healthcheck probe returning gateway status and timestamp.",
      },
      {
        method: "GET",
        path: "/swagger",
        auth: "Public",
        description: "Interactive OpenAPI / Swagger UI test console and API documentation.",
      },
      {
        method: "GET",
        path: "/v1",
        auth: "Public",
        description: "Gateway system diagnostics, hardware specifications, uptime, and endpoint directory.",
      },
    ],
  };
}

export const proxyRoutes = new Elysia()
  // ──── Gateway info ────────────────────────────────────────────────────────
  .get("/v1", () => gatewayInfo())
  .get("/v1/", () => gatewayInfo())

  // ──── Model list (public) ──────────────────────────────────────────────
  .get("/v1/models", () => {
    const db = getDb();
    return buildModelList(db);
  })
  .get("/models", () => {
    const db = getDb();
    return buildModelList(db);
  })

  // ──── POST /v1/chat/completions — OpenAI-compatible proxy ─────────────
  .post("/v1/chat/completions", async ({ request }) => {
    const db = getDb();
    const start = Date.now();

    // Resolve client key from Bearer token
    const authHeader = request.headers.get("authorization") ?? "";
    const rawKey = authHeader.replace(/^Bearer\s+/i, "");
    const clientKey = getClientKey(db, rawKey);

    // ── QUOTA CHECK ──────────────────────────────────────────────────────
    if (clientKey) {
      const blocked = checkQuota(clientKey);
      if (blocked) return blocked;
    }

    // Select upstream pool (client key allowlist = upstream ids)
    let upstreams = db.prepare("SELECT * FROM upstreams WHERE is_active = 1").all() as Upstream[];
    if (clientKey) {
      const allowed: string[] = JSON.parse(clientKey.allowed_providers ?? "[]");
      if (allowed.length) upstreams = upstreams.filter((u) => allowed.includes(u.id));
    }
    if (!upstreams.length) {
      return genericUpstreamError();
    }

    // Sniff model from body for routing + telemetry
    let requestedModel: string | null = null;
    let bodyText: string | null = null;
    let bodyObj: any = null;
    try {
      bodyText = await request.text();
      bodyObj = JSON.parse(bodyText);
      requestedModel = bodyObj?.model ?? null;
    } catch (_) { }

    // Model-aware candidates + failover; upstream errors never leak (generic shield)
    const candidates = rankCandidates(upstreams, requestedModel);
    let res: Response | null = null;
    let usedUpstream: Upstream | null = null;
    let attemptedUpstream: Upstream | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const upKey = getUpstreamKey(cand.upstream.id, !!cand.upstream.round_robin, db);
      if (!upKey) continue;
      attemptedUpstream = cand.upstream;

      let sendBody = bodyText;
      if (bodyObj && requestedModel && cand.forwardModel && cand.forwardModel !== requestedModel) {
        bodyObj.model = cand.forwardModel;
        sendBody = JSON.stringify(bodyObj);
      }

      const patchedReq = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: sendBody,
      });

      try {
        const r = await proxyRequest(patchedReq, cand.upstream.provider, cand.upstream, upKey.key);
        const screened = await screenUpstreamResponse(r);
        if (screened.ok && screened.res) {
          res = screened.res;
          usedUpstream = cand.upstream;
          break;
        }
        // Upstream error: non-2xx, or 200 carrying error JSON/SSE (quota,
        // no credits, billing...) — raw body discarded, next candidate tried.
        try {
          await Promise.resolve(r.body?.cancel()).catch(() => {});
        } catch (_) { }
      } catch (_) { }
    }

    const latency = Date.now() - start;

    if (!res) {
      if (attemptedUpstream) {
        try {
          recordUsage(db, clientKey, attemptedUpstream, requestedModel, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, latency, 503);
        } catch (_) { }
      }
      return genericUpstreamError();
    }

    // Record telemetry + deduct quota (streaming: tokens = 0, recorded on next req; non-stream: extracted)
    try {
      const isStream = res.headers.get("content-type")?.includes("text/event-stream");
      const tokens = isStream
        ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        : await extractTokens(res, "openai");
      recordUsage(db, clientKey, usedUpstream!, requestedModel, tokens, latency, res.status);
    } catch (_) { }

    return res;
  })

  // ──── POST /v1/messages — Anthropic-compatible proxy ──────────────────
  .post("/v1/messages", async ({ request }) => {
    const db = getDb();
    const start = Date.now();

    // Anthropic uses x-api-key header, also accept Bearer
    const rawKey =
      request.headers.get("x-api-key") ??
      (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const clientKey = getClientKey(db, rawKey);

    // ── QUOTA CHECK ──────────────────────────────────────────────────────
    if (clientKey) {
      const blocked = checkQuota(clientKey);
      if (blocked) return blocked;
    }

    let upstreams = db
      .prepare("SELECT * FROM upstreams WHERE is_active = 1 AND provider = 'anthropic'")
      .all() as Upstream[];
    if (clientKey) {
      const allowed: string[] = JSON.parse(clientKey.allowed_providers ?? "[]");
      if (allowed.length) upstreams = upstreams.filter((u) => allowed.includes(u.id));
    }
    if (!upstreams.length) {
      return genericUpstreamError();
    }

    let requestedModel: string | null = null;
    let bodyText: string | null = null;
    let bodyObj: any = null;
    try {
      bodyText = await request.text();
      bodyObj = JSON.parse(bodyText);
      requestedModel = bodyObj?.model ?? null;
    } catch (_) { }

    // Model-aware candidates + failover; upstream errors never leak (generic shield)
    const candidates = rankCandidates(upstreams, requestedModel);
    let res: Response | null = null;
    let usedUpstream: Upstream | null = null;
    let attemptedUpstream: Upstream | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const upKey = getUpstreamKey(cand.upstream.id, !!cand.upstream.round_robin, db);
      if (!upKey) continue;
      attemptedUpstream = cand.upstream;

      let sendBody = bodyText;
      if (bodyObj && requestedModel && cand.forwardModel && cand.forwardModel !== requestedModel) {
        bodyObj.model = cand.forwardModel;
        sendBody = JSON.stringify(bodyObj);
      }

      const patchedReq = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: sendBody,
      });

      try {
        const r = await proxyRequest(patchedReq, "anthropic", cand.upstream, upKey.key);
        const screened = await screenUpstreamResponse(r);
        if (screened.ok && screened.res) {
          res = screened.res;
          usedUpstream = cand.upstream;
          break;
        }
        // Upstream error: non-2xx, or 200 carrying error JSON/SSE (quota,
        // billing, request ids) — raw body discarded, next candidate tried.
        try {
          await Promise.resolve(r.body?.cancel()).catch(() => {});
        } catch (_) { }
      } catch (_) { }
    }

    const latency = Date.now() - start;

    if (!res) {
      if (attemptedUpstream) {
        try {
          recordUsage(db, clientKey, attemptedUpstream, requestedModel, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, latency, 503);
        } catch (_) { }
      }
      return genericUpstreamError();
    }

    try {
      const isStream = res.headers.get("content-type")?.includes("text/event-stream");
      const tokens = isStream
        ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        : await extractTokens(res, "anthropic");
      recordUsage(db, clientKey, usedUpstream!, requestedModel, tokens, latency, res.status);
    } catch (_) { }

    return res;
  });

// ── helpers ────────────────────────────────────────────────────────────────
function buildModelList(db: ReturnType<typeof getDb>) {
  const upstreams = db.prepare("SELECT * FROM upstreams WHERE is_active = 1").all() as Upstream[];
  const created = Math.floor(Date.now() / 1000);
  const models: any[] = [];
  for (const u of upstreams) {
    for (const m of parseUpModels(u)) {
      if (m.enabled) {
        const id = u.prefix ? `${u.prefix}/${m.id}` : m.id;
        if (!models.find((x) => x.id === id)) {
          models.push(enrichModel(id, m, u, created));
        }
      }
    }
  }
  return { object: "list", data: models };
}

/** NekoRouter-style enriched model object — provider identity hidden (Rizuu-branded) */
function enrichModel(id: string, m: ParsedUpModel, u: Upstream, created: number) {
  return {
    id,
    object: "model",
    created,
    owned_by: "Rizuu-Router",
    name: m.name || id,
    description: `${m.name || id} routed via Rizuu-Router`,
    provider: "Rizuu-Router",
    type: "chat",
    context_window: 128000,
    max_tokens: 8192,
    max_output_tokens: 8192,
    capabilities: {
      completion: true,
      chat_completion: true,
      embeddings: false,
      vision: false,
      function_calling: true,
      tools: true,
      tool_choice: true,
      json_mode: true,
      json_schema: true,
      streaming: true,
      reasoning: false,
      image_generation: false,
    },
    permission: [
      {
        id: `modelperm-${id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
        object: "model_permission",
        created,
        allow_create_engine: false,
        allow_sampling: true,
        allow_logprobs: false,
        allow_search_indices: false,
        allow_view: true,
        allow_fine_tuning: false,
        organization: "*",
        group: null,
        is_blocking: false,
      },
    ],
    root: id,
    parent: null,
    enabled: true,
  };
}

