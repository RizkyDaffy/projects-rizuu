import { statSync, readFileSync } from "fs";
import { resolve } from "path";

export type ProviderEntry = {
  provider: string;
  label?: string;
  endpoint: string;
  quota?: string;
  auth?: "openai" | "anthropic";
};

const FILE = resolve(import.meta.dir, "../../provider.json");
let cache: { mtimeMs: number; list: ProviderEntry[] } | null = null;

function normalizeEndpoint(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  u = u.replace(/\/v1$/i, "");
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

/** Hot-reloadable provider registry from provider.json (mtime cache). */
export function loadProviders(): ProviderEntry[] {
  try {
    const st = statSync(FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.list;
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    const arr = Array.isArray(raw) ? raw : [raw];
    const list = arr
      .filter((e: any) => e && typeof e.provider === "string" && typeof e.endpoint === "string" && e.provider && e.endpoint)
      .map((e: any) => ({
        provider: String(e.provider),
        label: typeof e.label === "string" ? e.label : undefined,
        endpoint: normalizeEndpoint(String(e.endpoint)),
        quota: typeof e.quota === "string" && e.quota.trim() ? e.quota.trim() : undefined,
        auth: e.auth === "anthropic" ? "anthropic" : e.auth === "openai" ? "openai" : undefined,
      }));
    cache = { mtimeMs: st.mtimeMs, list };
    return list;
  } catch {
    return cache?.list ?? [];
  }
}

export function findProvider(provider: string): ProviderEntry | undefined {
  const norm = provider.toLowerCase().trim();
  const list = loadProviders();
  return list.find((p) => {
    const pnorm = p.provider.toLowerCase();
    if (pnorm === norm) return true;
    // Allow ryzumi / ryuzumi alias match
    if ((norm === "ryzumi" || norm === "ryuzumi") && (pnorm === "ryzumi" || pnorm === "ryuzumi")) return true;
    return false;
  });
}

export function endpointFor(provider: string): string | null {
  return findProvider(provider)?.endpoint ?? null;
}

export function quotaEndpointFor(provider: string): string | null {
  return findProvider(provider)?.quota ?? null;
}

export function authStyleFor(provider: string): "openai" | "anthropic" {
  const e = findProvider(provider);
  if (e?.auth) return e.auth;
  return provider === "anthropic" ? "anthropic" : "openai";
}
