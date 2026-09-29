import { describe, expect, it } from "bun:test";
import { app } from "../src/index";

describe("Model Management Endpoints", () => {
  it("GET /api/models/management returns summary and model list", async () => {
    const res = await app.handle(new Request("http://localhost/api/models/management"));
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.summary).toBeDefined();
    expect(typeof json.data.summary.successRate24h).toBe("number");
    expect(typeof json.data.summary.availableModels).toBe("number");
    expect(typeof json.data.summary.totalModels).toBe("number");
    expect(Array.isArray(json.data.models)).toBe(true);

    if (json.data.models.length > 0) {
      const first = json.data.models[0];
      expect(first.id).toBeDefined();
      expect(first.name).toBeDefined();
      expect(first.status).toBeDefined();
      expect(["normal", "demote", "offline"]).toContain(first.status);
      expect(typeof first.availability).toBe("number");
      expect(typeof first.ttftP90).toBe("number");
      expect(typeof first.avgLatency).toBe("number");
      expect(Array.isArray(first.tags)).toBe(true);
      expect(Array.isArray(first.history)).toBe(true);
      expect(first.history.length).toBe(60);
    }
  });

  it("POST /api/models/toggle updates enabled state of a model", async () => {
    // Get a valid model from management
    const resList = await app.handle(new Request("http://localhost/api/models/management"));
    const dataList = await resList.json();

    if (dataList.data.models.length > 0) {
      const target = dataList.data.models[0];
      const initialEnabled = target.enabled;

      // Toggle it
      const resToggle = await app.handle(
        new Request("http://localhost/api/models/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upstreamId: target.upstreamId,
            modelId: target.id,
            enabled: !initialEnabled,
          }),
        })
      );
      expect(resToggle.status).toBe(200);
      const toggleData = await resToggle.json();
      expect(toggleData.success).toBe(true);
      expect(toggleData.data.enabled).toBe(!initialEnabled);

      // Revert back
      await app.handle(
        new Request("http://localhost/api/models/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upstreamId: target.upstreamId,
            modelId: target.id,
            enabled: initialEnabled,
          }),
        })
      );
    }
  });

  it("POST /api/models/test executes a live ping and records real telemetry log", async () => {
    const resList = await app.handle(new Request("http://localhost/api/models/management"));
    const dataList = await resList.json();

    if (dataList.data.models.length > 0) {
      const target = dataList.data.models[0];
      const resTest = await app.handle(
        new Request("http://localhost/api/models/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            upstreamId: target.upstreamId,
            modelId: target.id,
          }),
        })
      );
      expect(resTest.status).toBe(200);
      const testData = await resTest.json();
      expect(testData.success).toBe(true);
      expect(testData.data.statusCode).toBeDefined();
      expect(typeof testData.data.latency_ms).toBe("number");
    }
  });
});
