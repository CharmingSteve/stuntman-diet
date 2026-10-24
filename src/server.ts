import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { requireAuth } from "./auth.js";
import { createDatabase } from "./db.js";
import { SQLiteStore } from "./store-sqlite.js";
import { DynamoStore } from "./store-dynamo.js";
import { allItems, StoreConflict, type Store } from "./store.js";
import { seedFoods, normalizeFoodText } from "./seed.js";
import { profile, profileSchema, dateSchema, dayState, daySchema, userPK, write, history, mutate, metricSchema, digest, InputError } from "./ledger.js";
import { resolveRequestTime, TimeInputError } from "./time.js";
import { chat } from "./chat.js";
import { startTrends, queryResult, refresh, exportResult } from "./analytics.js";
import { previewImport, reviewImport, confirmImport, importReport } from "./imports.js";
import { createBackup } from "./backup.js";
import type { AppContext, FoodRecord } from "./types.js";
import type { FoodImage, ParsedMessage } from "./llm.js";

const s3 = new S3Client({});
const foodSchema = z.object({
  id: z.string(), name: z.string(), aliases: z.array(z.string()), category: z.string(),
  basis: z.record(z.string(), z.unknown()), preferred_value: z.record(z.string(), z.unknown()).optional(), notes: z.string().optional()
});
function idempotency(key: string | undefined): string {
  if (!key || !/^[A-Za-z0-9:_-]{8,120}$/.test(key)) throw new InputError("Provide an Idempotency-Key (8-120 letters, numbers, colon, underscore or hyphen)");
  return key;
}
async function initialize(store: Store, foods: FoodRecord[]): Promise<void> {
  for (const food of foods) {
    if (await store.get("CATALOG", `FOOD#${food.id}`)) continue;
    const aliases = [...new Map(food.aliases.map((alias) => [normalizeFoodText(alias), alias])).entries()];
    try { await store.transact([
      write("CATALOG", `FOOD#${food.id}`, "food", food),
      ...aliases.map(([normalized, alias]) => write(`ALIAS#${normalized}`, `FOOD#${food.id}`, "alias", { food_id: food.id, alias, normalized_alias: normalized }))
    ]); }
    catch (error) { if (!(error instanceof StoreConflict)) throw error; }
  }
}
export function createApp(
  input?: Store | Database.Database,
  authenticate: MiddlewareHandler<AppContext> = requireAuth
): Hono<AppContext> {
  const catalog = z.object({ foods: z.array(foodSchema) }).parse(JSON.parse(readFileSync(process.env.FOODS_PATH ?? "./seeds/foods.json", "utf8")));
  const db = input && "prepare" in input ? input : undefined;
  if (db) seedFoods(db, catalog.foods);
  const store = input && !("prepare" in input) ? input : process.env.STORE === "dynamo" && !db ? new DynamoStore() : new SQLiteStore(db ?? createDatabase());
  let ready: Promise<void> | undefined;
  let cached: FoodRecord[] = [], cacheUntil = 0;
  async function foods(user: string): Promise<FoodRecord[]> {
    if (Date.now() > cacheUntil) {
      cached = (await allItems(store, "CATALOG", { prefix: "FOOD#" })).map((i) => foodSchema.parse(i.data));
      cacheUntil = Date.now() + 60000;
    }
    const preferences = await allItems(store, userPK(user), { prefix: "FOOD_PREF#" });
    return cached.map((f) => {
      const preferred = preferences.find((p) => p.SK === `FOOD_PREF#${f.id}`);
      return preferred ? { ...f, preferred_value: preferred.data } : f;
    });
  }
  const app = new Hono<AppContext>();
  const publicDir = resolve(process.cwd(), "public");
  const domain = process.env.COGNITO_DOMAIN;
  const cognitoOrigin = domain ? new URL(domain.startsWith("https://") ? domain : `https://${domain}`).origin : "";
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", `default-src 'self'; connect-src 'self'${cognitoOrigin ? ` ${cognitoOrigin}` : ""}; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'`);
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  });
  app.use("/api/*", bodyLimit({ maxSize: 6 * 1024 * 1024, onError: (c) => c.json({ error: "Request must be 6 MB or smaller" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "Invalid input", details: error.issues.map((i) => i.message) }, 400);
    if (error instanceof InputError || error instanceof TimeInputError || error instanceof SyntaxError) return c.json({ error: error.message }, 400);
    if (error instanceof StoreConflict) return c.json({ error: error.message }, 409);
    console.error("Request failed", { type: error.name, message: error.message });
    return c.json({ error: "Request failed; please retry or contact the administrator" }, 500);
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/auth/config", (c) => c.json({
    domain: process.env.COGNITO_DOMAIN ?? "", clientId: process.env.COGNITO_CLIENT_ID ?? "",
    redirectUri: process.env.COGNITO_REDIRECT_URI ?? (process.env.AWS_LAMBDA_HTTP_ENDPOINT ? `https://${c.req.header("host")}/` : `${new URL(c.req.url).origin}/`)
  }));
  for (const [route, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"], ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"], ["/manifest.webmanifest", "manifest.webmanifest", "application/manifest+json"]
  ]) app.get(route!, async (c) => c.body(await readFile(resolve(publicDir, file!)), 200, { "Content-Type": type! }));
  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
  app.use("/api/*", authenticate);
  app.use("/api/*", async (_c, next) => {
    ready ??= initialize(store, catalog.foods).catch((error: unknown) => { ready = undefined; throw error; });
    await ready;
    await next();
  });
  app.get("/api/profile", async (c) => c.json(await profile(store, c.get("userId"))));
  app.put("/api/profile", async (c) => {
    const data = profileSchema.partial().strict().parse(await c.req.json()), user = c.get("userId");
    const key = idempotency(c.req.header("Idempotency-Key"));
    return c.json(await mutate(store, user, key, { route: c.req.path, data }, async () => {
      const old = await store.get(userPK(user), "PROFILE");
      const updated = profileSchema.parse({ ...(old?.data ?? {}), ...data });
      return { writes: [write(userPK(user), "PROFILE", "profile", updated, old)], result: updated };
    }));
  });
  app.get("/api/foods", async (c) => c.json(await foods(c.get("userId"))));
  app.put("/api/foods/:id/preferred-value", async (c) => {
    const user = c.get("userId"), id = c.req.param("id"), key = idempotency(c.req.header("Idempotency-Key"));
    const value = z.union([z.object({ calories_per_100g: z.number().positive().max(1000) }).strict(), z.object({ calories: z.number().positive().max(10000) }).strict()]).parse(await c.req.json());
    if (!await store.get("CATALOG", `FOOD#${id}`)) throw new InputError("Food not found");
    return c.json(await mutate(store, user, key, { route: c.req.path, value }, async () => {
      const old = await store.get(userPK(user), `FOOD_PREF#${id}`);
      return { writes: [write(userPK(user), `FOOD_PREF#${id}`, "food_preference", value, old)], result: { preferred_value: value } };
    }));
  });
  app.get("/api/history", async (c) => {
    const days = await history(store, c.get("userId"), c.req.query("from"), c.req.query("to"));
    return c.json({ days, count: days.length });
  });
  app.put("/api/days/:day", async (c) => {
    const user = c.get("userId"), day = dateSchema.parse(c.req.param("day"));
    const data = daySchema.pick({ eligibility: true, completeness: true, accept_default_burn: true }).partial().strict().parse(await c.req.json());
    const key = idempotency(c.req.header("Idempotency-Key"));
    return c.json(await mutate(store, user, key, { route: c.req.path, data }, async () => {
      const p = await profile(store, user), state = await dayState(store, user, day, p);
      const updated = { ...state.data, ...data };
      if (data.accept_default_burn && updated.burn_total === null) { updated.burn_total = 2000; updated.burn_source = "assumed"; }
      return { writes: [write(userPK(user), `DAY#${day}#META`, "day", updated, state.old)], result: updated };
    }));
  });
  app.post("/api/chat", async (c) => {
    const key = idempotency(c.req.header("Idempotency-Key")), user = c.get("userId");
    let body: unknown, image: FoodImage | undefined, imageKey: string | null = null, imageHash: string | undefined;
    if (c.req.header("content-type")?.includes("multipart/form-data")) {
      const form = await c.req.formData();
      body = { text: form.get("text"), ...(form.get("client_time") ? { client_time: form.get("client_time") } : {}) };
      const upload = form.get("image");
      if (upload instanceof File && upload.size) {
        if (upload.size > 5 * 1024 * 1024) return c.json({ error: "Image must be 5 MB or smaller" }, 413);
        const bytes = new Uint8Array(await upload.arrayBuffer());
        let mediaType: FoodImage["mediaType"];
        if (upload.type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mediaType = "jpeg";
        else if (upload.type === "image/png" && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mediaType = "png";
        else if (upload.type === "image/webp" && Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP") mediaType = "webp";
        else return c.json({ error: "Only valid JPEG, PNG, and WebP images are supported" }, 415);
        image = { mediaType, bytes }; imageHash = digest(Buffer.from(bytes).toString("base64"));
        const bucket = process.env.IMAGE_BUCKET ?? process.env.S3_BACKUP_BUCKET;
        if (!bucket) return c.json({ error: "Image storage is not configured" }, 503);
        imageKey = `images/${digest(user)}/${digest([key, imageHash])}.${mediaType}`;
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: imageKey, Body: bytes, ContentType: upload.type, ServerSideEncryption: "AES256" }));
      }
    } else body = await c.req.json();
    return c.json(await chat(store, user, key, body, await foods(user), image, imageKey, imageHash));
  });
  app.post("/api/health-metrics", async (c) => {
    const body = z.object({ metric: z.string(), value: z.number(), unit: z.string(), client_time: z.string().optional() }).strict().parse(await c.req.json());
    const user = c.get("userId"), key = idempotency(c.req.header("Idempotency-Key"));
    const result = await mutate(store, user, key, { route: c.req.path, body }, async () => {
      const p = await profile(store, user), time = resolveRequestTime(body.client_time, p.timezone), id = randomUUID();
      const data = metricSchema.parse({ ...body, id, occurred_at: time.original, day_key: time.dayKey, timezone: p.timezone, source: "user_input" });
      return { writes: [write(userPK(user), `DAY#${time.dayKey}#METRIC#${id}`, "metric", data)], result: data };
    });
    return c.json(result, 201);
  });
  app.get("/api/trends", async (c) => c.json(await startTrends(store, c.get("userId"), c.req.query("from"), c.req.query("to"))));
  app.get("/api/trends/:id", async (c) => c.json(await queryResult(store, c.get("userId"), c.req.param("id"))));
  app.delete("/api/trends/:id", async (c) => { idempotency(c.req.header("Idempotency-Key")); return c.json(await queryResult(store, c.get("userId"), c.req.param("id"), true)); });
  app.post("/api/analytics/refresh", async (c) => {
    const user = c.get("userId"), key = idempotency(c.req.header("Idempotency-Key"));
    return c.json(await mutate(store, user, key, { route: c.req.path }, async () => ({ writes: [], result: await refresh(store, user) })));
  });
  app.get("/api/analytics/refresh/:id", async (c) => c.json(await exportResult(store, c.get("userId"), c.req.param("id"))));
  app.post("/api/imports/preview", async (c) => { const key = idempotency(c.req.header("Idempotency-Key")); return c.json(await previewImport(store, c.get("userId"), await c.req.json(), key)); });
  app.put("/api/imports/:id/review", async (c) => { const key = idempotency(c.req.header("Idempotency-Key")); return c.json(await reviewImport(store, c.get("userId"), c.req.param("id"), await c.req.json(), key)); });
  app.post("/api/imports/:id/confirm", async (c) => { idempotency(c.req.header("Idempotency-Key")); return c.json(await confirmImport(store, c.get("userId"), c.req.param("id"))); });
  app.get("/api/imports/:id", async (c) => c.json(await importReport(store, c.get("userId"), c.req.param("id"))));
  app.post("/api/admin/backup", async (c) => {
    if (!process.env.ADMIN_SUB || c.get("userId") !== process.env.ADMIN_SUB) return c.json({ error: "Forbidden" }, 403);
    if (!db || process.env.STORE === "dynamo") return c.json({ error: "Use analytics refresh for a managed DynamoDB export" }, 400);
    return c.json(await createBackup(db), 201);
  });
  return app;
}

// Compatibility for existing self-hosted SQLite correction callers.
export function applyCorrection(db: Database.Database, userId: string, dayKey: string, correction: NonNullable<ParsedMessage["correction"]>, replacementId: string | null = null): string | null {
  const candidates = db.prepare("SELECT * FROM log_entries WHERE user_id=? AND day_key=? AND status='active' ORDER BY julianday(occurred_at) DESC").all(userId, dayKey) as Array<{ id: string; display_name: string; calories: number }>;
  const target = candidates.find((e) => e.id !== replacementId && (e.display_name.toLowerCase().includes(correction.target.toLowerCase()) || correction.target.toLowerCase().includes(e.display_name.toLowerCase())));
  if (!target) return null;
  return db.transaction(() => {
    if (correction.action === "void") {
      db.prepare("UPDATE log_entries SET status='void' WHERE id=? AND user_id=? AND status='active'").run(target.id, userId);
      return `Voided ${target.display_name}.`;
    }
    if (correction.action === "replace") {
      if (!replacementId || !db.prepare("SELECT id FROM log_entries WHERE id=? AND user_id=? AND day_key=? AND status='active'").get(replacementId, userId, dayKey)) return "I could not apply that replacement. Please specify the replacement food.";
      db.prepare("UPDATE log_entries SET status='superseded',superseded_by=? WHERE id=? AND status='active'").run(replacementId, target.id);
      return `Replaced ${target.display_name}.`;
    }
    if (correction.fraction === null || correction.fraction <= 0 || correction.fraction >= 1) return "Please specify a remaining fraction between 0 and 1.";
    const id = randomUUID(), calories = Math.round(target.calories * correction.fraction);
    db.prepare(`INSERT INTO log_entries (id,user_id,day_key,occurred_at,timezone,food_id,raw_text,display_name,quantity,unit,calories,calories_source,match_stage,status,created_at)
      SELECT ?,user_id,day_key,occurred_at,timezone,food_id,raw_text,display_name,quantity*?,unit,?,calories_source,'correction','active',?
      FROM log_entries WHERE id=? AND user_id=? AND status='active'`).run(id, correction.fraction, calories, new Date().toISOString(), target.id, userId);
    db.prepare("UPDATE log_entries SET status='superseded',superseded_by=? WHERE id=? AND status='active'").run(id, target.id);
    return `Updated ${target.display_name} to ${calories} kcal remaining.`;
  })();
}
if (process.env.NODE_ENV !== "test") {
  const { serve } = await import("@hono/node-server");
  const app = createApp();
  const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT, separator = endpoint?.lastIndexOf(":") ?? -1;
  const hostname = endpoint && separator > 0 ? endpoint.slice(0, separator).replace(/^\[|\]$/g, "") : "0.0.0.0";
  const port = endpoint && separator > 0 ? Number(endpoint.slice(separator + 1)) : Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid HTTP endpoint port");
  serve({ fetch: app.fetch, port, hostname }, (info) => console.info(`Stuntman Diet listening on ${info.address}:${info.port}`));
}
