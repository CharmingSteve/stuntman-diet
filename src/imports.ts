import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Store, type StoreItem, type StoreWrite, allItems, StoreConflict } from "./store.js";
import { dateSchema, profile, dayState, digest, userPK, write, entrySchema, metricSchema, dayItems, InputError, type Profile, eligible } from "./ledger.js";
import { resolveRequestTime } from "./time.js";
import { normalizeBrowserSources } from "./browser-import.js";

const messageSchema = z.object({
  id: z.string().min(1).max(300), timestamp: z.string().max(100),
  timezone: z.string().max(100).optional(),
  kind: z.enum(["meal", "summary", "correction", "metric", "burn"]),
  display_name: z.string().min(1).max(500).optional(),
  calories: z.number().nonnegative().max(100000).optional(),
  quantity: z.number().nonnegative().optional(), unit: z.string().max(30).optional(),
  total: z.number().nonnegative().max(100000).optional(),
  target_id: z.string().max(300).optional(), action: z.enum(["void", "replace"]).optional(),
  metric: z.enum(["glucose", "bp_systolic", "bp_diastolic", "weight"]).optional(),
  value: z.number().finite().optional(),
  review_note: z.string().max(1500).optional(),
  source_reference: z.string().max(1000).optional()
}).strict();
export const sourcesSchema = z.object({ sources: z.array(z.object({
  conversation_id: z.string().min(1).max(500), messages: z.array(messageSchema).min(1).max(5000)
}).strict()).min(1).max(100) }).strict();
const recordSchema = z.object({
  source_id: z.string(), conversation_id: z.string(), message: messageSchema,
  day: z.string(), timezone: z.string(), issue: z.string().optional(),
  action: z.enum(["include", "skip"]).optional(), status: z.enum(["pending", "inserted", "duplicate", "corrected", "skipped", "failed"]),
  error: z.string().optional(), fingerprint: z.string()
});
type ImportRecord = z.infer<typeof recordSchema>;
const jobSchema = z.object({
  job_id: z.string(), status: z.enum(["preview", "running", "complete"]),
  count: z.number(), complete_days: z.array(dateSchema).default([]), tracked_days: z.array(dateSchema).default([]),
  request_hash: z.string()
});
function sourceId(conversation: string, id: string): string { return digest([conversation, id]); }
function previewRecord(conversation: string, message: z.infer<typeof messageSchema>, p: Profile): ImportRecord {
  const issues: string[] = [];
  if (message.review_note) issues.push(message.review_note);
  let day = "", timezone = message.timezone ?? p.timezone;
  if (!message.timezone) issues.push("Timezone was not recorded; confirm profile timezone or supply the original zone");
  try { day = resolveRequestTime(message.timestamp, timezone).dayKey; }
  catch (error) { issues.push(error instanceof Error ? error.message : "Invalid source time"); }
  if (message.kind === "meal" || (message.kind === "correction" && message.action === "replace")) {
    if (!message.display_name || message.calories === undefined) issues.push("Meal needs a name and calories; skip or repair the source file");
  }
  if (message.kind === "correction" && (!message.target_id || !message.action)) issues.push("Correction needs original message ID and action");
  if ((message.kind === "burn" || message.kind === "summary") && message.total === undefined) issues.push("Burn/summary needs total");
  if (message.kind === "metric" && (!message.metric || message.value === undefined || !message.unit)) issues.push("Metric needs metric, value, and unit");
  return { source_id: sourceId(conversation, message.id), conversation_id: conversation, message,
    day, timezone, ...(issues.length ? { issue: issues.join("; ") } : {}),
    status: "pending", fingerprint: digest(message) };
}
export async function previewImport(store: Store, user: string, body: unknown, requestKey?: string): Promise<Record<string, unknown>> {
  const p = await profile(store, user);
  const sources = sourcesSchema.parse(normalizeBrowserSources(body, p.timezone)).sources;
  if (sources.reduce((n, s) => n + s.messages.length, 0) > 5000) throw new InputError("Import at most 5000 records per batch; split larger exports by file/date");
  const id = requestKey ? `preview-${digest(requestKey)}` : randomUUID();
  const existingJob = await store.get(userPK(user), `IMPORT#${id}`);
  if (existingJob) {
    if (existingJob.data.request_hash !== digest(body)) throw new StoreConflict("Import key was reused with different source data");
    return importReport(store, user, id);
  }
  const records: ImportRecord[] = [];
  const seen = new Set<string>();
  const dates = sources.flatMap((source) => source.messages.map((message) => previewRecord(source.conversation_id, message, p).day)).filter(Boolean).sort();
  const savedDays = dates.length ? new Map((await dayItems(store, user, dates[0]!, dates.at(-1)!)).filter((i) => i.entity === "day").map((i) => [String(i.data.day_key), i])) : new Map();
  for (const source of sources) for (const message of source.messages) {
    const record = previewRecord(source.conversation_id, message, p);
    if (seen.has(record.source_id)) throw new InputError("Duplicate source message ID within batch; combine revisions explicitly first");
    seen.add(record.source_id);
    const tracked = savedDays.get(record.day)?.data.eligibility ?? (eligible(record.day, p) ? "tracked" : "untracked");
    if (record.day && tracked === "untracked" && message.kind !== "metric" && message.kind !== "summary")
      record.issue = `${record.issue ? `${record.issue}; ` : ""}Non-tracking date requires explicit day override`;
    records.push(record);
  }
  const pk = userPK(user);
  const job = { job_id: id, status: "preview", count: records.length, complete_days: [], tracked_days: [], request_hash: digest(body) };
  // Store only structured evidence, not browser HTML or raw chat transcripts.
  // A preview is published only after all records are durable.
  for (let offset = 0; offset < records.length; offset += 80) {
    const writes = [];
    for (const [index, record] of records.slice(offset, offset + 80).entries()) {
      const sk = `IMPORT#${id}#RECORD#${String(offset + index).padStart(6, "0")}`;
      const existing = await store.get(pk, sk);
      if (existing && existing.data.fingerprint !== record.fingerprint) throw new StoreConflict("Import preview identity collision");
      if (!existing) writes.push(write(pk, sk, "import_record", record));
    }
    if (writes.length) {
      try { await store.transact(writes); }
      catch (error) { if (!(error instanceof StoreConflict)) throw error; return previewImport(store, user, body, requestKey); }
    }
  }
  try { await store.transact([write(pk, `IMPORT#${id}`, "import_job", job)]); }
  catch (error) { if (!(error instanceof StoreConflict)) throw error; return previewImport(store, user, body, requestKey); }
  return { ...job, records: records.map((r) => ({ source_id: r.source_id, day: r.day, kind: r.message.kind, display_name: r.message.display_name, calories: r.message.calories, issue: r.issue })), issues: records.flatMap((r) => r.issue ? [`${r.source_id}: ${r.issue}`] : []) };
}
export const reviewSchema = z.object({
  resolutions: z.array(z.object({ source_id: z.string(), action: z.enum(["include", "skip"]), day: dateSchema.optional(), timezone: z.string().optional() }).strict()).max(5000).default([]),
  complete_days: z.array(dateSchema).max(3660).default([]), tracked_days: z.array(dateSchema).max(3660).default([])
}).strict();
export async function reviewImport(store: Store, user: string, id: string, body: unknown, requestKey?: string): Promise<Record<string, unknown>> {
  const review = reviewSchema.parse(body), pk = userPK(user);
  const receiptSK = requestKey ? `IMPORT#${id}#REVIEW#${digest(requestKey)}` : undefined;
  let receipt = receiptSK ? await store.get(pk, receiptSK) : undefined;
  if (receipt && receipt.data.hash !== digest(review)) throw new StoreConflict("Review key was reused for different decisions");
  if (receipt?.data.status === "complete") return importReport(store, user, id);
  const job = await store.get(pk, `IMPORT#${id}`);
  if (!job) throw new InputError("Import not found");
  if (job.data.status !== "preview") throw new StoreConflict("Cannot edit an import after confirmation");
  if (receiptSK && !receipt) {
    const operation = write(pk, receiptSK, "review_receipt", { hash: digest(review), status: "started" });
    await store.transact([operation]);
    receipt = operation.item;
  }
  const records = await allItems(store, pk, { prefix: `IMPORT#${id}#RECORD#` });
  for (const resolution of review.resolutions) {
    const row = records.find((r) => r.data.source_id === resolution.source_id);
    if (!row) throw new InputError("Review record not found");
    const record = recordSchema.parse(row.data);
    if (resolution.action === "include") {
      const timezone = resolution.timezone ?? record.timezone;
      const time = resolveRequestTime(record.message.timestamp, timezone);
      // An explicitly reviewed food date can differ from the timestamp of a retrospective summary.
      record.day = resolution.day ?? time.dayKey;
      record.timezone = timezone;
      // Required structured fields are still validated at commit, never fabricated.
      delete record.issue;
    }
    record.action = resolution.action;
    await store.transact([write(pk, row.SK, "import_record", record, row)]);
  }
  await store.transact([
    write(pk, job.SK, "import_job", { ...job.data, complete_days: review.complete_days, tracked_days: review.tracked_days }, job),
    ...(receiptSK && receipt ? [write(pk, receiptSK, "review_receipt", { hash: digest(review), status: "complete" }, receipt)] : [])
  ]);
  return importReport(store, user, id);
}
export async function confirmImport(store: Store, user: string, id: string): Promise<Record<string, unknown>> {
  const pk = userPK(user), old = await store.get(pk, `IMPORT#${id}`);
  if (!old) throw new InputError("Import not found");
  let job = jobSchema.parse(old.data);
  if (job.status === "complete") return importReport(store, user, id);
  if (job.status === "preview") {
    const unresolved = (await allItems(store, pk, { prefix: `IMPORT#${id}#RECORD#` })).some((r) => r.data.issue && !r.data.action);
    if (unresolved) throw new InputError("Review every uncertain record before confirming");
    await store.transact([write(pk, old.SK, "import_job", { ...job, status: "running" }, old)]);
    job = { ...job, status: "running" };
  }
  const p = await profile(store, user);
  const records = await allItems(store, pk, { prefix: `IMPORT#${id}#RECORD#` });
  async function build(row: StoreItem): Promise<StoreWrite[]> {
    const record = recordSchema.parse(row.data), m = record.message;
      const receipt = await store.get(pk, `SOURCE#${record.source_id}`);
      if (receipt && receipt.data.fingerprint !== record.fingerprint) throw new InputError("Source identity already has different content; use an explicit correction");
      if (receipt && typeof receipt.data.assigned_day === "string" && receipt.data.assigned_day !== record.day) throw new InputError("Source was previously assigned to a different day; correct the existing ledger explicitly");
      let status: ImportRecord["status"] = receipt ? "duplicate" : record.action === "skip" ? "skipped" : m.kind === "correction" ? "corrected" : "inserted";
      const writes = [];
      if (!receipt && status !== "skipped") {
        const day = dateSchema.parse(record.day);
        const state = await dayState(store, user, day, p);
        if (job.tracked_days.includes(day)) state.data.eligibility = "tracked";
        if (job.complete_days.includes(day)) state.data.completeness = "complete";
        if (state.data.eligibility === "untracked" && m.kind !== "metric" && m.kind !== "summary") throw new InputError("Explicit tracked-day override required");
        if (m.kind === "meal" || m.kind === "correction") {
          let target;
          if (m.kind === "correction") {
            if (!m.target_id || !m.action) throw new InputError("Missing correction target/action");
            const targetSource = await store.get(pk, `SOURCE#${sourceId(record.conversation_id, m.target_id)}`);
            if (!targetSource || typeof targetSource.data.entry_sk !== "string") throw new InputError("Import correction target first");
            target = await store.get(pk, targetSource.data.entry_sk);
            if (!target || target.data.status !== "active") throw new StoreConflict("Correction target is no longer active");
            if (target.data.day_key !== day) throw new InputError("Correction day differs from original; review source");
          }
          const entrySK = `DAY#${day}#ENTRY#${record.source_id}`;
          if (m.kind === "meal" || m.action === "replace") {
            const entry = entrySchema.parse({ id: record.source_id, day_key: day, occurred_at: m.timestamp, timezone: record.timezone, display_name: m.display_name, calories: m.calories, quantity: m.quantity, unit: m.unit, status: "active", calories_source: "user_number", match_stage: "import", source_id: record.source_id, created_at: new Date().toISOString() });
            writes.push(write(pk, entrySK, "entry", entry));
          }
          if (target) writes.push(write(pk, target.SK, "entry", { ...target.data, status: m.action === "void" ? "void" : "superseded", superseded_by: m.action === "void" ? null : record.source_id }, target));
          writes.push(write(pk, `SOURCE#${record.source_id}`, "source", { fingerprint: record.fingerprint, entry_sk: m.action === "void" ? null : entrySK, source_timestamp: m.timestamp, assigned_day: day, source_reference: m.source_reference ?? null }));
          state.data.completeness = job.complete_days.includes(day) ? "complete" : "partial";
        } else {
          if (m.kind === "burn") { state.data.burn_total = z.number().parse(m.total); state.data.burn_source = "recorded"; }
          if (m.kind === "metric") {
            const metric = metricSchema.parse({ id: record.source_id, day_key: day, occurred_at: m.timestamp, timezone: record.timezone, metric: m.metric, value: m.value, unit: m.unit, source: "historical_import" });
            writes.push(write(pk, `DAY#${day}#METRIC#${record.source_id}`, "metric", metric));
          }
          writes.push(write(pk, `SOURCE#${record.source_id}`, "source", { fingerprint: record.fingerprint, summary_total: m.kind === "summary" ? m.total : null, day_key: day, assigned_day: day, source_timestamp: m.timestamp, source_reference: m.source_reference ?? null }));
        }
        writes.push(write(pk, `DAY#${day}#META`, "day", state.data, state.old));
      }
      writes.push(write(pk, row.SK, "import_record", { ...record, status }, row));
      return writes;
  }
  const groups = new Map<string, StoreItem[]>();
  for (const row of records) {
    const r = recordSchema.parse(row.data);
    const group = r.message.source_reference ?? r.source_id;
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  for (const group of [...groups.values()].filter((g) => g.some((r) => r.data.status === "pending")).slice(0, 20)) {
    try {
      if (group.some((r) => r.data.status === "failed")) throw new InputError("Source group previously failed; repair its source before retrying as a new import");
      if (group.length > 30) throw new InputError("Source message exceeds atomic import limit of 30 records; split it with explicitly reviewed chunk boundaries");
      const writes = new Map<string, StoreWrite>();
      for (const row of group) for (const change of await build(row)) {
        const previous = writes.get(change.item.SK);
        if (previous) {
          if (change.item.entity !== "day") throw new InputError("Source group writes the same non-day item twice");
          const before = previous.item.data, after = change.item.data;
          change.item.data = { ...after,
            completeness: before.completeness === "complete" || after.completeness === "complete" ? "complete" : before.completeness === "partial" || after.completeness === "partial" ? "partial" : "missing",
            burn_total: after.burn_total ?? before.burn_total, burn_source: after.burn_source ?? before.burn_source
          };
        }
        writes.set(change.item.SK, change);
      }
      await store.transact([...writes.values()]);
    } catch (error) {
      if (error instanceof StoreConflict) {
        const current = await Promise.all(group.map((row) => store.get(pk, row.SK)));
        if (current.every((row) => row?.data.status !== "pending")) continue;
      }
      console.warn("Import source group failed", { job_id: id, error: error instanceof Error ? error.message : "Unknown failure" });
      for (const row of group) {
        const current = await store.get(pk, row.SK);
        if (current?.data.status === "pending") await store.transact([write(pk, row.SK, "import_record", { ...recordSchema.parse(row.data), status: "failed", error: error instanceof Error ? error.message : "Import failed" }, current)]);
      }
    }
  }
  const remaining = (await allItems(store, pk, { prefix: `IMPORT#${id}#RECORD#` })).some((r) => r.data.status === "pending");
  if (!remaining) {
    const report = await importReport(store, user, id);
    const conflicts = z.array(z.object({ day: z.string(), matches: z.boolean() })).parse(report.reconciliation).filter((r) => !r.matches);
    for (const conflict of conflicts) {
      const day = await store.get(pk, `DAY#${conflict.day}#META`);
      if (day && day.data.completeness === "complete") await store.transact([write(pk, day.SK, "day", { ...day.data, completeness: "partial" }, day)]);
    }
    const current = await store.get(pk, old.SK);
    if (current && current.data.status !== "complete") await store.transact([write(pk, old.SK, "import_job", { ...current.data, status: "complete" }, current)]);
  }
  return importReport(store, user, id);
}
export async function importReport(store: Store, user: string, id: string): Promise<Record<string, unknown>> {
  const pk = userPK(user), job = await store.get(pk, `IMPORT#${id}`);
  if (!job) throw new InputError("Import not found");
  const records = (await allItems(store, pk, { prefix: `IMPORT#${id}#RECORD#` })).map((r) => recordSchema.parse(r.data));
  const count = (status: string) => records.filter((r) => r.status === status).length;
  const reconciliation = [];
  const summaries = job.data.status === "preview" ? [] : records.filter((r) => r.message.kind === "summary" && r.status === "inserted");
  const dates = summaries.map((r) => r.day).sort();
  const ledger = dates.length ? (await dayItems(store, user, dates[0]!, dates.at(-1)!)).filter((e) => e.entity === "entry").map((e) => entrySchema.parse(e.data)).filter((e) => e.status === "active") : [];
  for (const r of summaries) {
    const entries = ledger.filter((e) => e.day_key === r.day);
    const actual = entries.reduce((n, e) => n + e.calories, 0);
    reconciliation.push({ day: r.day, source_total: r.message.total, ledger_total: actual, matches: actual === r.message.total });
  }
  return { ...job.data, inserted: count("inserted"), duplicate: count("duplicate"), corrected: count("corrected"), skipped: count("skipped"),
    unresolved: records.filter((r) => r.status === "pending" && r.issue && !r.action).length,
    pending: count("pending"), failed: count("failed"), reconciliation,
    records: records.map((r) => ({ source_id: r.source_id, day: r.day, kind: r.message.kind, display_name: r.message.display_name, calories: r.message.calories, issue: r.issue, status: r.status, error: r.error })) };
}
