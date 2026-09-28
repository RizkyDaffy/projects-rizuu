import { describe, expect, test } from "bun:test";
import { app } from "../src/index";

describe("rizuu backend 1:1 endpoints test", () => {
  test("GET /health", async () => {
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("GET /api/auth/status", async () => {
    const res = await app.handle(new Request("http://localhost/api/auth/status"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("POST /api/auth/login", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "123456" }),
      })
    );
    expect(res.status).toBe(200);
  });

  test("GET /api/keys/", async () => {
    const res = await app.handle(new Request("http://localhost/api/keys/"));
    expect(res.status).toBe(200);
  });

  test("POST /api/keys/", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/keys/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Key" }),
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.name).toBe("Test Key");
  });

  test("GET /api/router-keys/", async () => {
    const res = await app.handle(new Request("http://localhost/api/router-keys/"));
    expect(res.status).toBe(200);
  });

  test("POST /api/router-keys/", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/router-keys/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Router Key 1" }),
      })
    );
    expect(res.status).toBe(200);
  });

  test("GET /api/upstreams/generate-alias", async () => {
    const res = await app.handle(new Request("http://localhost/api/upstreams/generate-alias"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.alias).toBeDefined();
  });

  test("GET /api/upstreams/", async () => {
    const res = await app.handle(new Request("http://localhost/api/upstreams/"));
    expect(res.status).toBe(200);
  });

  test("POST /api/upstreams/", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/upstreams/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          name: "OpenAI Primary",
          apiKey: "sk-mock-key-12345",
          models: [{ id: "gpt-4o", enabled: true }],
        }),
      })
    );
    expect(res.status).toBe(200);
  });

  test("GET /api/api-providers/bandelbanget/status", async () => {
    const res = await app.handle(new Request("http://localhost/api/api-providers/bandelbanget/status"));
    expect(res.status).toBe(200);
  });

  test("GET /api/telemetry/active", async () => {
    const res = await app.handle(new Request("http://localhost/api/telemetry/active"));
    expect(res.status).toBe(200);
  });

  test("GET /api/telemetry/stats", async () => {
    const res = await app.handle(new Request("http://localhost/api/telemetry/stats"));
    expect(res.status).toBe(200);
  });

  test("GET /api/telemetry/logs", async () => {
    const res = await app.handle(new Request("http://localhost/api/telemetry/logs"));
    expect(res.status).toBe(200);
  });

  test("GET /api/admin/system", async () => {
    const res = await app.handle(new Request("http://localhost/api/admin/system"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.platform).toBeDefined();
  });

  test("GET /api/admin/settings/optimizations", async () => {
    const res = await app.handle(new Request("http://localhost/api/admin/settings/optimizations"));
    expect(res.status).toBe(200);
  });

  test("GET /v1", async () => {
    const res = await app.handle(new Request("http://localhost/v1"));
    expect(res.status).toBe(200);
  });

  test("GET /v1/models", async () => {
    const res = await app.handle(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
  });
});
