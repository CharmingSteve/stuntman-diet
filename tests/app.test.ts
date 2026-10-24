import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { MiddlewareHandler } from "hono";
import { createDatabase } from "../src/db.js";
import { resolveItems } from "../src/resolver.js";
import { seedFoods } from "../src/seed.js";
import { dayKeyFor, resolveRequestTime } from "../src/time.js";
import { parseBurnText } from "../src/parsing.js";
import { isEndOfDay, renderDailySummary } from "../src/renderer.js";
import { applyCorrection, createApp } from "../src/server.js";
import type { AppContext } from "../src/types.js";

const seed = JSON.parse(readFileSync(new URL("../seeds/foods.json", import.meta.url), "utf8")) as {
  foods: Array<{
    id: string;
    name: string;
    aliases: string[];
    category: string;
    basis: Record<string, unknown>;
    preferred_value?: Record<string, unknown>;
    notes?: string;
    source?: string;
  }>;
};

describe("time handling", () => {
  it("uses an explicit client offset and the profile timezone for day boundaries", () => {
    const time = resolveRequestTime("2026-10-24T23:30:00-04:00", "Asia/Jerusalem");
    expect(time.dayKey).toBe("2026-10-25");
    expect(time.original).toBe("2026-10-24T23:30:00-04:00");
  });

  it("rejects client timestamps without offsets", () => {
    expect(() => resolveRequestTime("2026-10-24T23:30:00", "Asia/Jerusalem")).toThrow(/offset/);
  });

  it("rejects impossible calendar dates and offsets", () => {
    expect(() => resolveRequestTime("2026-02-30T23:30:00Z", "Asia/Jerusalem")).toThrow(/invalid/);
    expect(() => resolveRequestTime("2026-10-24T23:30:00+14:30", "Asia/Jerusalem")).toThrow(/invalid/);
  });

  it("handles travel timezone boundaries", () => {
    expect(dayKeyFor(new Date("2026-10-24T23:30:00Z"), "America/Los_Angeles")).toBe("2026-10-24");
  });

  it("uses the configured default daily burn", () => {
    const db = createDatabase(":memory:");
    db.prepare("INSERT INTO days (user_id, day_key, timezone, created_at) VALUES (?, ?, ?, ?)")
      .run("user-1", "2026-10-24", "Asia/Jerusalem", "2026-10-24T10:00:00Z");
    expect(db.prepare("SELECT burn_total FROM days WHERE user_id = ?").get("user-1")).toEqual({ burn_total: 2000 });
    db.close();
  });
});

describe("food resolution", () => {
  const db = createDatabase(":memory:");
  seedFoods(db, seed.foods);

  it("uses a stated calorie number verbatim", () => {
    const item = {
      raw: "protein drink 200 calories", food_key: null, match_stage: "estimate" as const,
      display_name: "protein drink", quantity: 1, unit: "portion" as const,
      calories: 150, calories_source: "estimate" as const, confidence: "low" as const,
      supersedes_entry_id: null
    };
    const resolved = resolveItems(db, "user-1", {
      intent: "food_log", day_hint: null, items: [item], burn: null, correction: null,
      question: null, needs_clarification: [], notes: ""
    });
    expect(resolved[0]).toMatchObject({ calories: 200, caloriesSource: "user_number", matchStage: "user_number" });
  });

  it("resolves exact database aliases and respects user-preferred values across reseeds", () => {
    const item = {
      raw: "cottage 9", food_key: "cottage_9", match_stage: "alias" as const,
      display_name: "Cottage cheese", quantity: 250, unit: "g" as const,
      calories: 1, calories_source: "estimate" as const, confidence: "high" as const,
      supersedes_entry_id: null
    };
    const result = resolveItems(db, "user-1", {
      intent: "food_log", day_hint: null, items: [item], burn: null, correction: null,
      question: null, needs_clarification: [], notes: ""
    });
    expect(result[0]).toMatchObject({ foodId: "cottage_9", calories: 320, matchStage: "alias" });

    db.prepare("UPDATE foods SET preferred_value_json = ? WHERE id = ?").run('{"calories_per_100g":200}', "cottage_9");
    seedFoods(db, seed.foods);
    const preferred = resolveItems(db, "user-1", {
      intent: "food_log", day_hint: null, items: [item], burn: null, correction: null,
      question: null, needs_clarification: [], notes: ""
    });
    expect(preferred[0]?.calories).toBe(500);
  });

  it("supports per-gram, secondary-unit, and per-100ml seed bases without guessing", () => {
    const makeParsed = (raw: string, key: string, quantity: number, unit: "g" | "ml" | "tsp") => ({
      intent: "food_log" as const, day_hint: null, burn: null, correction: null,
      question: null, needs_clarification: [], notes: "",
      items: [{
        raw, food_key: key, match_stage: "exact" as const, display_name: raw,
        quantity, unit, calories: null, calories_source: "db" as const,
        confidence: "high" as const, supersedes_entry_id: null
      }]
    });
    expect(resolveItems(db, "u1", makeParsed("chia seeds", "chia_seeds", 1, "tsp"))[0])
      .toMatchObject({ calories: 20, caloriesSource: "db" });
    expect(resolveItems(db, "u1", makeParsed("Obolon beer", "obolon_beer", 500, "ml"))[0])
      .toMatchObject({ calories: 585, caloriesSource: "db" });
    expect(resolveItems(db, "u1", makeParsed("gil", "gil_yogurt", 200, "g"))[0])
      .toMatchObject({ calories: 0, matchStage: "unresolved" });
  });

  it("parses burn totals and component sums deterministically", () => {
    expect(parseBurnText("1550 + 1200")).toEqual({ components: [1550, 1200], total: 2750 });
    expect(parseBurnText("burned so far 3250")).toEqual({ total: 3250, components: [] });
  });

  it("renders the required two-column table and full/short timestamp rules", () => {
    const entries = [{ display_name: "Banana", calories: 105 }];
    const first = renderDailySummary(entries, null, "2026-10-24T10:00:00Z", "Asia/Jerusalem");
    const followup = renderDailySummary(entries, null, "2026-10-24T11:00:00Z", "Asia/Jerusalem", false, false);
    expect(first).toContain("| Food | Calories |");
    expect(first).toContain("**Total Intake:** 105 kcal");
    expect(followup).not.toContain("Oct");
    expect(isEndOfDay("2026-10-24T20:31:00Z", "Asia/Jerusalem")).toBe(true);
  });
});

describe("corrections", () => {
  it("appends a reduced entry and preserves the superseded record", () => {
    const db = createDatabase(":memory:");
    db.prepare(`
      INSERT INTO log_entries (
        id, user_id, day_key, occurred_at, timezone, raw_text, display_name, quantity, unit,
        calories, calories_source, match_stage, created_at
      ) VALUES ('old', 'u1', '2026-10-24', '2026-10-24T10:00:00Z', 'Asia/Jerusalem',
        'eggs', 'Eggs', 2, 'unit', 150, 'estimate', 'estimate', '2026-10-24T10:00:00Z')
    `).run();
    const message = applyCorrection(db, "u1", "2026-10-24", {
      target: "eggs", action: "reduce_fraction", fraction: 2 / 3
    });
    expect(message).toContain("100 kcal remaining");
    expect(db.prepare("SELECT status, superseded_by FROM log_entries WHERE id='old'").get()).toEqual({
      status: "superseded", superseded_by: expect.any(String)
    });
    expect(db.prepare("SELECT calories, quantity FROM log_entries WHERE status='active'").get()).toEqual({
      calories: 100, quantity: 4 / 3
    });
    db.close();
  });

  it("voids the original log entry without deleting its history", () => {
    const db = createDatabase(":memory:");
    db.prepare(`
      INSERT INTO log_entries (
        id, user_id, day_key, occurred_at, timezone, raw_text, display_name, unit,
        calories, calories_source, match_stage, created_at
      ) VALUES ('old', 'u1', '2026-10-24', '2026-10-24T10:00:00Z', 'Asia/Jerusalem',
        'cheese', 'Cheese', 'portion', 90, 'estimate', 'estimate', '2026-10-24T10:00:00Z')
    `).run();
    expect(applyCorrection(db, "u1", "2026-10-24", {
      target: "cheese", action: "void", fraction: null
    })).toContain("Voided");
    expect(db.prepare("SELECT status FROM log_entries WHERE id='old'").get()).toEqual({ status: "void" });
    db.close();
  });

  it("links replacement entries to the superseded item", () => {
    const db = createDatabase(":memory:");
    db.prepare(`
      INSERT INTO log_entries (
        id, user_id, day_key, occurred_at, timezone, raw_text, display_name, unit,
        calories, calories_source, match_stage, created_at
      ) VALUES
        ('old', 'u1', '2026-10-24', '2026-10-24T10:00:00Z', 'Asia/Jerusalem',
          'cheese', 'Cheese', 'portion', 90, 'estimate', 'estimate', '2026-10-24T10:00:00Z'),
        ('new', 'u1', '2026-10-24', '2026-10-24T11:00:00Z', 'Asia/Jerusalem',
          'yogurt', 'Yogurt', 'portion', 120, 'db', 'exact', '2026-10-24T11:00:00Z')
    `).run();
    expect(applyCorrection(db, "u1", "2026-10-24", {
      target: "cheese", action: "replace", fraction: null
    }, "new")).toContain("Replaced Cheese");
    expect(db.prepare("SELECT status, superseded_by FROM log_entries WHERE id='old'").get()).toEqual({
      status: "superseded", superseded_by: "new"
    });
    expect(db.prepare("SELECT status FROM log_entries WHERE id='new'").get()).toEqual({ status: "active" });
    db.close();
  });
});

describe("HTTP app", () => {
  const db = createDatabase(":memory:");
  const auth: MiddlewareHandler<AppContext> = async (context, next) => {
    context.set("userId", "test-user");
    await next();
  };
  const protectedServer = createServer();
  const publicServer = createServer();

  beforeAll(async () => {
    const protectedApp = createApp(db, auth);
    const publicApp = createApp(createDatabase(":memory:"));
    const bridge = (app: ReturnType<typeof createApp>) => (incoming: IncomingMessage, outgoing: ServerResponse) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const init: RequestInit & { duplex?: "half" } = {
          method: incoming.method,
          headers: incoming.headers as HeadersInit,
          ...(body ? { body, duplex: "half" as const } : {})
        };
        void app.fetch(new Request(`http://${incoming.headers.host}${incoming.url}`, init)).then(async (response) => {
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        });
      });
    };
    protectedServer.on("request", bridge(protectedApp));
    publicServer.on("request", bridge(publicApp));
    protectedServer.listen(0, "127.0.0.1");
    publicServer.listen(0, "127.0.0.1");
    await Promise.all([once(protectedServer, "listening"), once(publicServer, "listening")]);
  });

  afterAll(() => {
    protectedServer.close();
    publicServer.close();
    db.close();
  });

  it("exposes an unprotected health check and protects API routes", async () => {
    await request(publicServer).get("/health").expect(200).expect({ status: "ok" });
    await request(publicServer).get("/api/profile").expect(401);
  });

  it("serves the authorized profile and rejects invalid timezone updates", async () => {
    await request(protectedServer).get("/api/profile").expect(200).expect({ timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [5, 6] });
    await request(protectedServer).put("/api/profile").send({ timezone: "Invalid/Place" }).expect(400);
    await request(protectedServer).put("/api/profile").set("Idempotency-Key", "profile-update-1").send({ timezone: "America/Los_Angeles" }).expect(200);
  });

  it("serves history and trends and validates health metric input", async () => {
    await request(protectedServer).get("/api/history").expect(200)
      .expect((response) => expect(response.body.days).toHaveLength(30));
    await request(protectedServer).get("/api/trends").expect(200)
      .expect((response) => expect(response.body).toMatchObject({ status: "complete", rows: expect.any(Array) }));
    await request(protectedServer).post("/api/health-metrics").set("Idempotency-Key", "health-metric-1").send({
      metric: "glucose", value: 118, unit: "mg/dL", client_time: "2026-10-24T10:00:00Z"
    }).expect(201);
    await request(protectedServer).post("/api/health-metrics").set("Idempotency-Key", "health-metric-invalid").send({
      metric: "glucose", value: -1, unit: "mg/dL", client_time: "2026-10-24T10:00:00Z"
    }).expect(400);
  });
});
