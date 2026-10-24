import { randomUUID } from "node:crypto";
import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand, StopQueryExecutionCommand } from "@aws-sdk/client-athena";
import { z } from "zod";
import type { Store } from "./store.js";
import { write, userPK, dateRange, dayItems, daySchema, entrySchema, metricSchema, profile, newDay, usableBurn, InputError } from "./ledger.js";
import { exportPK, snapshotSchema, config, requestExport } from "./export-handler.js";
import { dayKeyFor } from "./time.js";

const athena = new AthenaClient({});
const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;
export function analyticsSQL(database: string, table: string, snapshot: string, user: string, from?: string, to?: string, snapshotAt = new Date().toISOString()): string {
  if (!/^[a-zA-Z0-9_]+$/.test(database) || !/^[a-zA-Z0-9_]+$/.test(table)) throw new Error("Invalid Glue identifier");
  const range = dateRange(from, to);
  // Only server-owned identifiers are interpolated; user/date/snapshot values are escaped literals.
  return `WITH source AS (
    SELECT item.entity.s entity, item.data.m d FROM "${database}"."${table}"
    WHERE snapshot=${literal(snapshot)} AND item.pk.s=${literal(userPK(user))}
      AND (item.entity.s='profile' OR item.data.m.day_key.s BETWEEN ${literal(range.from)} AND ${literal(range.to)})
  ), policy AS (
    SELECT coalesce(max_by(d, CASE WHEN entity='profile' THEN 1 ELSE 0 END).timezone.s,'Asia/Jerusalem') timezone,
      max_by(d, CASE WHEN entity='profile' THEN 1 ELSE 0 END) p FROM source
  ), bounds AS (
    SELECT cast(coalesce(${from ? literal(from) : "null"},min(d.day_key.s),
      cast(cast(at_timezone(from_iso8601_timestamp(${literal(snapshotAt)}),p.timezone) AS date) AS varchar)) AS date) start,
      least(cast(${literal(range.to)} AS date),cast(at_timezone(from_iso8601_timestamp(${literal(snapshotAt)}),p.timezone) AS date)) finish
    FROM source CROSS JOIN policy p GROUP BY p.timezone
  ), calendar AS (
    SELECT day FROM bounds CROSS JOIN UNNEST(
      IF(start<=finish,sequence(start,finish,INTERVAL '1' DAY),cast(ARRAY[] AS array(date)))
    ) AS t(day)
  ), meals AS (
    SELECT d.day_key.s day, sum(cast(d.calories.n AS double)) intake, count(*) entries
    FROM source WHERE entity='entry' AND d.status.s='active' GROUP BY 1
  ), days AS (
    SELECT cast(c.day AS varchar) day, coalesce(m.intake,0) intake, coalesce(m.entries,0) entries,
      coalesce(d.eligibility.s,CASE WHEN
        contains(coalesce(transform(p.p.holidays.l,x->x.s),ARRAY[]),cast(c.day AS varchar))
        OR contains(coalesce(transform(p.p.non_tracking_weekdays.l,x->cast(x.n AS integer)),ARRAY[5,6]),mod(day_of_week(c.day),7))
        THEN 'untracked' ELSE 'tracked' END) eligibility,
      coalesce(d.completeness.s,'missing') completeness, d.burn_source.s burn_source,
      CASE WHEN d.eligibility.s='tracked' AND d.completeness.s='complete'
        AND (d.burn_source.s='recorded' OR d.accept_default_burn.bool=true)
        THEN cast(d.burn_total.n AS double) END burn
    FROM calendar c CROSS JOIN policy p
    LEFT JOIN (SELECT d FROM source WHERE entity='day') metadata ON metadata.d.day_key.s=cast(c.day AS varchar)
    LEFT JOIN meals m ON cast(c.day AS varchar)=m.day
  ), reports AS (
    SELECT 'weekly' kind, cast(date_trunc('week',cast(day AS date)) AS varchar) period, '' food,
      sum(intake) intake, sum(burn) burn,
      sum(CASE WHEN burn IS NOT NULL THEN intake-burn END) net, sum(entries) entries,
      cast(null AS double) value,
      count_if(eligibility='tracked') eligible, count_if(eligibility='tracked' AND completeness='complete') complete,
      count_if(eligibility='tracked' AND completeness='partial') partial,
      count_if(eligibility='tracked' AND completeness='missing') missing,
      count_if(eligibility='untracked') excluded,
      count_if(burn IS NOT NULL AND burn_source='assumed') assumed
    FROM days GROUP BY 2
    UNION ALL
    SELECT 'monthly', substr(day,1,7), '', sum(intake),sum(burn),
      sum(CASE WHEN burn IS NOT NULL THEN intake-burn END),sum(entries),cast(null AS double),
      count_if(eligibility='tracked'),count_if(eligibility='tracked' AND completeness='complete'),
      count_if(eligibility='tracked' AND completeness='partial'),count_if(eligibility='tracked' AND completeness='missing'),
      count_if(eligibility='untracked'),count_if(burn IS NOT NULL AND burn_source='assumed')
    FROM days GROUP BY 2
    UNION ALL
    SELECT 'food','',d.display_name.s,sum(cast(d.calories.n AS double)),null,null,count(*),null,0,0,0,0,0,0
    FROM source WHERE entity='entry' AND d.status.s='active' GROUP BY 3
    UNION ALL
    SELECT 'glucose',d.day_key.s,'',null,null,null,count(*),avg(cast(d.value.n AS double)),0,0,0,0,0,0
    FROM source WHERE entity='metric' AND d.metric.s='glucose' GROUP BY 2
  ) SELECT * FROM reports ORDER BY kind,period,food`;
}
export async function startTrends(store: Store, user: string, from?: string, to?: string): Promise<Record<string, unknown>> {
  dateRange(from, to);
  if (process.env.TRENDS !== "athena") return localTrends(store, user, from, to);
  const latest = await store.get(exportPK, "LATEST");
  if (!latest) throw new InputError("No complete analytics snapshot yet. Refresh analytics data first.");
  const snap = snapshotSchema.parse(latest.data);
  const jobId = randomUUID();
  // Persist intent before the external request. Athena ClientRequestToken makes retry safe.
  const job = write(userPK(user), `JOB#query#${jobId}`, "query_job", {
    job_id: jobId, status: "starting", ...snap, from: from ?? null, to: to ?? null,
    requested_at: new Date().toISOString()
  });
  await store.transact([job]);
  const response = await athena.send(new StartQueryExecutionCommand({
    ClientRequestToken: jobId,
    QueryString: analyticsSQL(config("GLUE_DATABASE"), config("GLUE_TABLE"), snap.snapshot_id, user, from, to, snap.snapshot_at),
    WorkGroup: config("ATHENA_WORKGROUP"),
    ResultConfiguration: { OutputLocation: `s3://${config("ATHENA_RESULTS_BUCKET")}/results/`, EncryptionConfiguration: { EncryptionOption: "SSE_S3" } }
  }));
  if (!response.QueryExecutionId) throw new Error("Athena did not return a query ID");
  await store.transact([write(userPK(user), job.item.SK, "query_job", { ...job.item.data, query_id: response.QueryExecutionId, status: "running" }, job.item)]);
  return { job_id: jobId, status: "running", snapshot_at: snap.snapshot_at, snapshot_id: snap.snapshot_id };
}
export async function queryResult(store: Store, user: string, id: string, cancel = false): Promise<Record<string, unknown>> {
  const row = await store.get(userPK(user), `JOB#query#${id}`);
  if (!row) throw new InputError("Query job not found");
  const queryId = z.string().parse(row.data.query_id);
  if (cancel) {
    await athena.send(new StopQueryExecutionCommand({ QueryExecutionId: queryId }));
    return { job_id: id, status: "cancelled" };
  }
  const execution = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: queryId }));
  const state = execution.QueryExecution?.Status?.State;
  if (state === "FAILED" || state === "CANCELLED") return { job_id: id, status: "failed", error: execution.QueryExecution?.Status?.StateChangeReason ?? state };
  if (state !== "SUCCEEDED") {
    if (Date.now() - Date.parse(z.string().parse(row.data.requested_at)) > 120000) {
      await athena.send(new StopQueryExecutionCommand({ QueryExecutionId: queryId }));
      return { job_id: id, status: "failed", error: "Query exceeded two-minute time limit" };
    }
    return { job_id: id, status: "running", snapshot_at: row.data.snapshot_at };
  }
  const rows: Record<string, unknown>[] = [];
  let token: string | undefined;
  let columns: string[] = [];
  do {
    const response = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryId, MaxResults: 1000, ...(token ? { NextToken: token } : {}) }));
    if (!columns.length) columns = response.ResultSet?.ResultSetMetadata?.ColumnInfo?.map((c) => c.Name ?? "") ?? [];
    const values = response.ResultSet?.Rows ?? [];
    for (const value of token ? values : values.slice(1)) {
      rows.push(Object.fromEntries(columns.map((c, i) => {
        const v = value.Data?.[i]?.VarCharValue;
        return [c, v === undefined ? null : ["kind", "period", "food"].includes(c) ? v : Number(v)];
      })));
    }
    token = response.NextToken;
    if (rows.length > 10000) throw new InputError("Report exceeds 10000 rows; select a narrower date range");
  } while (token);
  return { job_id: id, status: "complete", snapshot_at: row.data.snapshot_at, snapshot_id: row.data.snapshot_id, rows };
}
export async function refresh(store: Store, user: string): Promise<Record<string, unknown>> {
  if (process.env.TRENDS !== "athena") throw new InputError("Local trends use the live SQLite store; snapshot refresh requires TRENDS=athena");
  const id = await requestExport(store);
  const old = await store.get(userPK(user), `JOB#export#${id}`);
  if (!old) {
    try { await store.transact([write(userPK(user), `JOB#export#${id}`, "export_ref", { global_id: id })]); }
    catch (error) {
      const { StoreConflict } = await import("./store.js");
      if (!(error instanceof StoreConflict)) throw error;
    }
  }
  return exportResult(store, user, id);
}
export async function exportResult(store: Store, user: string, id: string): Promise<Record<string, unknown>> {
  if (!await store.get(userPK(user), `JOB#export#${id}`)) throw new InputError("Export job not found");
  const job = await store.get(exportPK, `JOB#${id}`);
  if (!job) throw new Error("Export job reference is missing");
  return { job_id: id, status: job.data.status, snapshot_at: job.data.snapshot_at ?? null, error: job.data.error ?? null };
}
export async function localTrends(store: Store, user: string, from?: string, to?: string): Promise<Record<string, unknown>> {
  const range = dateRange(from, to);
  const items = await dayItems(store, user, range.from, range.to);
  const days = items.filter((i) => i.entity === "day").map((i) => daySchema.parse(i.data));
  const entries = items.filter((i) => i.entity === "entry").map((i) => entrySchema.parse(i.data)).filter((e) => e.status === "active");
  const metrics = items.filter((i) => i.entity === "metric").map((i) => metricSchema.parse(i.data));
  const p = await profile(store, user);
  const start = from ?? [...days.map((d) => d.day_key), ...entries.map((e) => e.day_key), ...metrics.map((m) => m.day_key)].sort()[0];
  const end = to && to < dayKeyFor(new Date(), p.timezone) ? to : dayKeyFor(new Date(), p.timezone);
  if (start) {
    const count = Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
    if (count > 10000) throw new InputError("Choose a date range of at most 10000 calendar days");
    for (let offset = 0; offset < count; offset++) {
      const date = new Date(Date.parse(`${start}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
      if (!days.some((d) => d.day_key === date)) days.push(newDay(date, p));
    }
  }
  const rows: Record<string, unknown>[] = [];
  for (const kind of ["weekly", "monthly"]) {
    const groups = new Map<string, typeof days>();
    for (const day of days) {
      const monday = new Date(`${day.day_key}T12:00:00Z`);
      monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
      const period = kind === "weekly" ? monday.toISOString().slice(0, 10) : day.day_key.slice(0, 7);
      groups.set(period, [...(groups.get(period) ?? []), day]);
    }
    for (const [period, group] of groups) {
      const usable = group.filter((d) => usableBurn(d) !== null);
      const intake = (day: string) => entries.filter((e) => e.day_key === day).reduce((n, e) => n + e.calories, 0);
      rows.push({ kind, period, food: "", intake: group.reduce((n, d) => n + intake(d.day_key), 0),
        burn: usable.length ? usable.reduce((n, d) => n + usableBurn(d)!, 0) : null,
        net: usable.length ? usable.reduce((n, d) => n + intake(d.day_key) - usableBurn(d)!, 0) : null,
        entries: entries.filter((e) => group.some((d) => d.day_key === e.day_key)).length,
        eligible: group.filter((d) => d.eligibility === "tracked").length,
        complete: group.filter((d) => d.eligibility === "tracked" && d.completeness === "complete").length,
        partial: group.filter((d) => d.eligibility === "tracked" && d.completeness === "partial").length,
        missing: group.filter((d) => d.eligibility === "tracked" && d.completeness === "missing").length,
        excluded: group.filter((d) => d.eligibility === "untracked").length,
        assumed: usable.filter((d) => d.burn_source === "assumed").length });
    }
  }
  for (const food of new Set(entries.map((e) => e.display_name))) {
    const group = entries.filter((e) => e.display_name === food);
    rows.push({ kind: "food", period: "", food, intake: group.reduce((n, e) => n + e.calories, 0), entries: group.length });
  }
  for (const day of new Set(metrics.filter((m) => m.metric === "glucose").map((m) => m.day_key))) {
    const group = metrics.filter((m) => m.metric === "glucose" && m.day_key === day);
    rows.push({ kind: "glucose", period: day, value: group.reduce((n, m) => n + m.value, 0) / group.length });
  }
  return { status: "complete", snapshot_at: null, snapshot_id: "local-live", rows };
}
