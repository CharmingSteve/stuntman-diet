import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { createBackup } from "./backup.js";
import { requireAuth } from "./auth.js";
import { createDatabase } from "./db.js";
import { narrateFacts, parseMessage } from "./llm.js";
import { parseBurnText } from "./parsing.js";
import { isEndOfDay, renderDailySummary } from "./renderer.js";
import { foodRecords, resolveItems, type ResolvedItem } from "./resolver.js";
import { seedFoods } from "./seed.js";
import { assertTimezone, resolveRequestTime } from "./time.js";
import { getQuestionFacts, getTrends } from "./trends.js";
import type { AppContext } from "./types.js";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });
const textSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  client_time: z.string().optional()
}).strict();
const historyDays = 21;

function ensureProfile(db: ReturnType<typeof createDatabase>, userId: string): string {
  db.prepare("INSERT OR IGNORE INTO user_profiles (user_id, timezone, updated_at) VALUES (?, 'Asia/Jerusalem', ?)").run(userId, new Date().toISOString());
  const row = db.prepare("SELECT timezone FROM user_profiles WHERE user_id = ?").get(userId) as { timezone: string };
  return row.timezone;
}

function recordItems(
  db: ReturnType<typeof createDatabase>,
  userId: string,
  time: ReturnType<typeof resolveRequestTime>,
  items: ResolvedItem[],
  imageKey: string | null
): void {
  const insert = db.prepare(`
    INSERT INTO log_entries (
      id, user_id, day_key, occurred_at, timezone, food_id, raw_text, display_name,
      quantity, unit, calories, calories_source, match_stage, status, superseded_by, image_key, created_at
    ) VALUES (
      @id, @userId, @dayKey, @occurredAt, @timezone, @foodId, @raw, @name,
      @quantity, @unit, @calories, @caloriesSource, @matchStage, 'active', NULL, @imageKey, @createdAt
    )
  `);
  const supersede = db.prepare("UPDATE log_entries SET status = 'superseded', superseded_by = ? WHERE id = ? AND user_id = ? AND status = 'active'");
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO days (user_id, day_key, timezone, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, day_key) DO NOTHING
    `).run(userId, time.dayKey, time.timezone, time.original);
    for (const item of items) {
      if (item.matchStage === "unresolved") continue;
      if (item.supersedesEntryId) supersede.run(item.id, item.supersedesEntryId, userId);
      insert.run({
        id: item.id, userId, dayKey: time.dayKey, occurredAt: time.original, timezone: time.timezone,
        foodId: item.foodId, raw: item.raw, name: item.name, quantity: item.quantity,
        unit: item.unit, calories: item.calories, caloriesSource: item.caloriesSource,
        matchStage: item.matchStage, imageKey, createdAt: new Date().toISOString()
      });
    }
  });
  transaction();
}

export function applyCorrection(
  db: ReturnType<typeof createDatabase>,
  userId: string,
  dayKey: string,
  correction: NonNullable<Awaited<ReturnType<typeof parseMessage>>["correction"]>,
  replacementId: string | null = null
): string | null {
  const candidates = db.prepare(`
    SELECT id, display_name, calories FROM log_entries
    WHERE user_id = ? AND day_key = ? AND status = 'active' ORDER BY occurred_at DESC
  `).all(userId, dayKey) as Array<{ id: string; display_name: string; calories: number }>;
  const target = candidates.find((entry) => {
    if (entry.id === replacementId) return false;
    const name = entry.display_name.toLocaleLowerCase();
    const phrase = correction.target.toLocaleLowerCase();
    return name.includes(phrase) || phrase.includes(name);
  });
  if (!target) return null;
  if (correction.action === "replace") {
    if (!replacementId) return "I could not apply that replacement. Please specify the replacement food.";
    const replacement = db.prepare(`
      SELECT id FROM log_entries
      WHERE id = ? AND user_id = ? AND day_key = ? AND status = 'active'
    `).get(replacementId, userId, dayKey);
    if (!replacement) return "I could not apply that replacement. Please try again.";
    db.prepare("UPDATE log_entries SET status = 'superseded', superseded_by = ? WHERE id = ? AND user_id = ? AND status = 'active'")
      .run(replacementId, target.id, userId);
    return `Replaced ${target.display_name}.`;
  }
  if (correction.action === "void") {
    db.prepare("UPDATE log_entries SET status = 'void' WHERE id = ? AND user_id = ? AND status = 'active'").run(target.id, userId);
    return `Voided ${target.display_name}.`;
  }
  if (correction.action !== "reduce_fraction" || correction.fraction === null || correction.fraction <= 0 || correction.fraction >= 1) {
    return "I could not apply that correction. Please specify a remaining fraction between 0 and 1.";
  }
  const remainingCalories = Math.round(target.calories * correction.fraction);
  const replacementRowId = randomUUID();
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO log_entries (
        id, user_id, day_key, occurred_at, timezone, food_id, raw_text, display_name,
        quantity, unit, calories, calories_source, match_stage, status, superseded_by, created_at
      )
      SELECT ?, user_id, day_key, occurred_at, timezone, food_id, ?, ?, quantity * ?, unit,
        ?, calories_source, 'correction', 'active', NULL, ?
      FROM log_entries WHERE id = ? AND user_id = ? AND status = 'active'
    `).run(replacementRowId, `Correction: ${correction.target}`, target.display_name, correction.fraction, remainingCalories, new Date().toISOString(), target.id, userId);
    db.prepare("UPDATE log_entries SET status = 'superseded', superseded_by = ? WHERE id = ? AND user_id = ? AND status = 'active'").run(replacementRowId, target.id, userId);
  });
  transaction();
  return `Updated ${target.display_name} to ${remainingCalories} kcal remaining.`;
}

function history(db: ReturnType<typeof createDatabase>, userId: string, timezone: string): Array<{
  day: string;
  timezone: string;
  burn: number | null;
  entries: Array<{ id: string; display_name: string; calories: number; occurred_at: string }>;
}> {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
  const rows = db.prepare(`
    WITH RECURSIVE calendar(day_key, offset) AS (
      SELECT date(?, '-20 days'), 0
      UNION ALL SELECT date(day_key, '+1 day'), offset + 1 FROM calendar WHERE offset < 20
    )
    SELECT calendar.day_key AS day, COALESCE(days.timezone, ?) AS timezone, days.burn_total AS burn,
      log_entries.id, log_entries.display_name, log_entries.calories, log_entries.occurred_at
    FROM calendar
    LEFT JOIN days ON days.user_id = ? AND days.day_key = calendar.day_key
    LEFT JOIN log_entries ON log_entries.user_id = ? AND log_entries.day_key = calendar.day_key AND log_entries.status = 'active'
    ORDER BY calendar.day_key DESC, log_entries.occurred_at DESC
  `).all(today, timezone, userId, userId) as Array<{
    day: string; timezone: string; burn: number | null; id: string | null;
    display_name: string | null; calories: number | null; occurred_at: string | null;
  }>;
  const days = new Map<string, { day: string; timezone: string; burn: number | null; entries: Array<{ id: string; display_name: string; calories: number; occurred_at: string }> }>();
  for (const row of rows) {
    let group = days.get(row.day);
    if (!group) {
      group = { day: row.day, timezone: row.timezone, burn: row.burn, entries: [] };
      days.set(row.day, group);
    }
    if (row.id && row.display_name && row.calories !== null && row.occurred_at) {
      group.entries.push({ id: row.id, display_name: row.display_name, calories: row.calories, occurred_at: row.occurred_at });
    }
  }
  return Array.from(days.values());
}

export function createApp(
  db = createDatabase(),
  authenticate: MiddlewareHandler<AppContext> = requireAuth
): Hono<AppContext> {
  const catalogPath = process.env.FOODS_PATH ?? "./seeds/foods.json";
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { foods: Parameters<typeof seedFoods>[1] };
  seedFoods(db, catalog.foods);
  const app = new Hono<AppContext>();
  const publicDir = resolve(process.cwd(), "public");
  const configuredDomain = process.env.COGNITO_DOMAIN;
  const cognitoOrigin = configuredDomain
    ? new URL(configuredDomain.startsWith("https://") ? configuredDomain : `https://${configuredDomain}`).origin
    : null;
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", `default-src 'self'; connect-src 'self'${cognitoOrigin ? ` ${cognitoOrigin}` : ""}; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'`);
  });
  app.onError((error, c) => {
    console.error("Request failed", error);
    return c.json({ error: "Internal server error" }, 500);
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/auth/config", (c) => c.json({
    domain: process.env.COGNITO_DOMAIN ?? "",
    clientId: process.env.COGNITO_CLIENT_ID ?? "",
    redirectUri: process.env.COGNITO_REDIRECT_URI ??
      (process.env.AWS_LAMBDA_HTTP_ENDPOINT
        ? `https://${c.req.header("host")}/`
        : `${new URL(c.req.url).origin}/`)
  }));
  app.get("/", async (c) => c.html(await readFile(resolve(publicDir, "index.html"), "utf8")));
  app.get("/app.js", async (c) => c.body(await readFile(resolve(publicDir, "app.js"), "utf8"), 200, { "Content-Type": "text/javascript; charset=utf-8" }));
  app.get("/styles.css", async (c) => c.body(await readFile(resolve(publicDir, "styles.css"), "utf8"), 200, { "Content-Type": "text/css; charset=utf-8" }));
  app.get("/manifest.webmanifest", async (c) => c.body(await readFile(resolve(publicDir, "manifest.webmanifest"), "utf8"), 200, { "Content-Type": "application/manifest+json" }));
  app.use("/api/*", authenticate);

  app.get("/api/profile", (c) => {
    const timezone = ensureProfile(db, c.get("userId"));
    return c.json({ timezone });
  });
  app.put("/api/profile", async (c) => {
    const data = await c.req.json().catch(() => null) as { timezone?: unknown } | null;
    try {
      assertTimezone(data?.timezone);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid timezone" }, 400);
    }
    db.prepare(`
      INSERT INTO user_profiles (user_id, timezone, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone, updated_at = excluded.updated_at
    `).run(c.get("userId"), data.timezone, new Date().toISOString());
    return c.json({ timezone: data.timezone });
  });
  app.get("/api/foods", (c) => c.json(foodRecords(db)));
  app.put("/api/foods/:id/preferred-value", async (c) => {
    const data = await c.req.json().catch(() => null) as { calories_per_100g?: unknown; calories?: unknown } | null;
    const caloriesPer100 = data?.calories_per_100g;
    const calories = data?.calories;
    if (!((typeof caloriesPer100 === "number" && caloriesPer100 > 0 && caloriesPer100 <= 1000) ||
          (typeof calories === "number" && calories > 0 && calories <= 10000))) {
      return c.json({ error: "Provide a valid calories_per_100g or calories value" }, 400);
    }
    const current = db.prepare("SELECT preferred_value_json FROM foods WHERE id = ?").get(c.req.param("id")) as { preferred_value_json: string | null } | undefined;
    if (!current) return c.json({ error: "Food not found" }, 404);
    const value = typeof caloriesPer100 === "number" ? { calories_per_100g: caloriesPer100 } : { calories };
    db.prepare("UPDATE foods SET preferred_value_json = ? WHERE id = ?").run(JSON.stringify(value), c.req.param("id"));
    return c.json({ preferred_value: value });
  });

  app.post("/api/chat", async (c) => {
    let body: unknown;
    let image: import("./llm.js").FoodImage | undefined;
    let imageKey: string | null = null;
    if (c.req.header("content-type")?.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const text = form.get("text");
      const clientTime = form.get("client_time");
      body = {
        text: typeof text === "string" ? text : "",
        ...(typeof clientTime === "string" ? { client_time: clientTime } : {})
      };
      const upload = form.get("image");
      if (upload instanceof File && upload.size > 0) {
        if (upload.size > 5 * 1024 * 1024) return c.json({ error: "Image must be 5 MB or smaller" }, 413);
        const bytes = new Uint8Array(await upload.arrayBuffer());
        const signatures: Array<{ mediaType: "jpeg" | "png" | "webp"; mime: string; matches: (data: Uint8Array) => boolean }> = [
          { mediaType: "jpeg", mime: "image/jpeg", matches: (data) => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff },
          { mediaType: "png", mime: "image/png", matches: (data) => data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 },
          { mediaType: "webp", mime: "image/webp", matches: (data) => String.fromCharCode(...data.subarray(0, 4)) === "RIFF" && String.fromCharCode(...data.subarray(8, 12)) === "WEBP" }
        ];
        const signature = signatures.find((entry) => entry.mime === upload.type && entry.matches(bytes));
        if (!signature) return c.json({ error: "Only valid JPEG, PNG, or WebP images are supported" }, 415);
        image = { mediaType: signature.mediaType, bytes };
        const bucket = process.env.S3_BACKUP_BUCKET;
        if (!bucket) return c.json({ error: "Image storage is not configured" }, 503);
        imageKey = `images/${c.get("userId")}/${randomUUID()}.${signature.mediaType === "jpeg" ? "jpg" : signature.mediaType}`;
        await s3.send(new PutObjectCommand({
          Bucket: bucket, Key: imageKey, Body: bytes,
          ContentType: signature.mime, ServerSideEncryption: "AES256"
        }));
      }
    } else {
      body = await c.req.json().catch(() => null);
    }
    const parsedBody = textSchema.safeParse(body);
    if (!parsedBody.success) return c.json({ error: "Provide text and an optional ISO client_time" }, 400);
    const userId = c.get("userId");
    const timezone = ensureProfile(db, userId);
    let time: ReturnType<typeof resolveRequestTime>;
    try {
      time = resolveRequestTime(parsedBody.data.client_time, timezone);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid client_time" }, 400);
    }
    const foods = foodRecords(db);
    const llmParsed = await parseMessage(parsedBody.data.text, foods, time.original, timezone, image);
    const deterministicBurn = parseBurnText(parsedBody.data.text);
    const parsed = deterministicBurn
      ? { ...llmParsed, intent: "burn" as const, burn: deterministicBurn }
      : llmParsed;
    const resolved = resolveItems(db, userId, parsed);
    const needsClarification = [
      ...parsed.needs_clarification,
      ...resolved.filter((item) => item.matchStage === "unresolved")
        .map((item) => `Please clarify the quantity or portion for ${item.name}.`)
    ];
    const replacement = parsed.correction?.action === "replace"
      ? resolved.find((item) => item.matchStage !== "unresolved") ?? null
      : null;
    const itemsToRecord = replacement
      ? resolved.map((item) => ({ ...item, supersedesEntryId: null }))
      : resolved;
    recordItems(db, userId, time, itemsToRecord, imageKey);
    let correctionMessage: string | null = null;
    if (parsed.correction) {
      correctionMessage = applyCorrection(db, userId, time.dayKey, parsed.correction, replacement?.id ?? null);
    }
    if (parsed.intent === "burn" && parsed.burn) {
      const burn = parsed.burn.components.length ? parsed.burn.components.reduce((sum, value) => sum + value, 0) : parsed.burn.total;
      db.prepare(`
        INSERT INTO days (user_id, day_key, timezone, burn_total, burn_components_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, day_key) DO UPDATE SET
          timezone = excluded.timezone, burn_total = excluded.burn_total,
          burn_components_json = excluded.burn_components_json
      `).run(userId, time.dayKey, timezone, burn, JSON.stringify(parsed.burn.components), time.original);
    } else {
      db.prepare(`
        INSERT INTO days (user_id, day_key, timezone, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, day_key) DO NOTHING
      `).run(userId, time.dayKey, timezone, time.original);
    }
    const entries = db.prepare(`
      SELECT display_name, calories, occurred_at FROM log_entries
      WHERE user_id = ? AND day_key = ? AND status = 'active' ORDER BY occurred_at
    `).all(userId, time.dayKey) as Array<{ display_name: string; calories: number; occurred_at: string }>;
    const day = db.prepare("SELECT burn_total FROM days WHERE user_id = ? AND day_key = ?").get(userId, time.dayKey) as { burn_total: number | null } | undefined;
    const hadEarlierLog = Boolean(db.prepare(`
      SELECT 1 FROM turns WHERE user_id = ? AND day_key = ?
        AND intent IN ('food_log', 'burn', 'correction', 'image') LIMIT 1
    `).get(userId, time.dayKey));
    const endOfDay = parsed.intent === "burn" || isEndOfDay(time.original, timezone);
    const summary = parsed.intent === "question" || parsed.intent === "trend"
      ? null
      : renderDailySummary(entries, day?.burn_total ?? null, time.original, timezone, endOfDay, !hadEarlierLog);
    let answer: string | null = null;
    if ((parsed.intent === "question" || parsed.intent === "trend") && parsed.question) {
      const facts = parsed.intent === "trend"
        ? (() => {
          const trends = getTrends(db, userId, timezone);
          return {
            monthlyDeficit: trends.monthlyDeficit,
            weekly: trends.weekly.map(({ intake, burn, net }) => ({ intake, burn, net })),
            topFoods: trends.topFoods,
            glucose: trends.glucose.map(({ value }) => value)
          };
        })()
        : getQuestionFacts(db, userId, time.dayKey, timezone);
      answer = await narrateFacts(parsed.question, facts);
    }
    const message = [
      correctionMessage,
      needsClarification.length ? needsClarification.join(" ") : null,
      answer,
      summary,
      parsed.notes || null
    ].filter(Boolean).join("\n\n");
    db.prepare("INSERT INTO turns (id, user_id, occurred_at, day_key, timezone, client_message, assistant_message, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), userId, time.original, time.dayKey, timezone, parsedBody.data.text, message, parsed.intent);
    return c.json({
      intent: parsed.intent, items: resolved, needs_clarification: needsClarification,
      correction: correctionMessage, message, summary, question: parsed.question
    });
  });

  app.get("/api/history", (c) => {
    const userId = c.get("userId");
    return c.json({ days: history(db, userId, ensureProfile(db, userId)), count: historyDays });
  });
  app.get("/api/trends", (c) => {
    const userId = c.get("userId");
    return c.json(getTrends(db, userId, ensureProfile(db, userId)));
  });
  app.post("/api/health-metrics", async (c) => {
    const body = await c.req.json().catch(() => null) as { metric?: unknown; value?: unknown; unit?: unknown; client_time?: unknown } | null;
    const allowed: Record<string, { unit: string; min: number; max: number }> = {
      glucose: { unit: "mg/dL", min: 20, max: 600 },
      bp_systolic: { unit: "mmHg", min: 50, max: 300 },
      bp_diastolic: { unit: "mmHg", min: 30, max: 200 },
      weight: { unit: "kg", min: 20, max: 500 }
    };
    const metric = typeof body?.metric === "string" ? allowed[body.metric] : undefined;
    if (!metric || typeof body?.value !== "number" || !Number.isFinite(body.value) ||
        body.value < metric.min || body.value > metric.max || body.unit !== metric.unit) {
      return c.json({ error: "Provide a supported metric, value, and matching unit" }, 400);
    }
    const userId = c.get("userId");
    const timezone = ensureProfile(db, userId);
    let time: ReturnType<typeof resolveRequestTime>;
    try {
      time = resolveRequestTime(body.client_time, timezone);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid client_time" }, 400);
    }
    const id = randomUUID();
    db.prepare("INSERT INTO health_metrics (id, user_id, occurred_at, day_key, timezone, metric, value, unit, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'user_input')")
      .run(id, userId, time.original, time.dayKey, timezone, body.metric, body.value, body.unit);
    return c.json({ id, occurred_at: time.original, metric: body.metric, value: body.value, unit: body.unit }, 201);
  });
  app.post("/api/admin/backup", async (c) => {
    const adminSub = process.env.ADMIN_SUB;
    if (!adminSub || c.get("userId") !== adminSub) return c.json({ error: "Forbidden" }, 403);
    return c.json(await createBackup(db), 201);
  });

  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
  app.notFound((c) => {
    const asset = c.req.path.replace(/^\/+/, "");
    if (asset && !asset.includes("..") && extname(asset)) {
      const file = resolve(publicDir, asset);
      if (file.startsWith(`${publicDir}${sep}`)) {
        return readFile(file).then((body) => c.body(body)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return c.notFound();
          throw error;
        });
      }
    }
    return c.notFound();
  });
  return app;
}

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== "test") {
  const { serve } = await import("@hono/node-server");
  const app = createApp();
  const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT;
  const separator = endpoint?.lastIndexOf(":") ?? -1;
  const hostname = endpoint && separator > 0 ? endpoint.slice(0, separator).replace(/^\[|\]$/g, "") : "0.0.0.0";
  const listenPort = endpoint && separator > 0 ? Number(endpoint.slice(separator + 1)) : port;
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error("AWS_LAMBDA_HTTP_ENDPOINT or PORT must include a valid port");
  }
  serve({ fetch: app.fetch, port: listenPort, hostname }, (info) => {
    console.info(`Stuntman Diet listening on ${info.address}:${info.port}`);
  });
}
