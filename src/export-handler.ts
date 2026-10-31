import { createHash } from "node:crypto";
import { DynamoDBClient, DescribeContinuousBackupsCommand, ExportTableToPointInTimeCommand, DescribeExportCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { GlueClient, CreatePartitionCommand, GetTableCommand } from "@aws-sdk/client-glue";
import { z } from "zod";
import { DynamoStore } from "./store-dynamo.js";
import { StoreConflict, type Store, type StoreItem, type StoreWrite } from "./store.js";
import { write } from "./ledger.js";

export const exportPK = "SYSTEM#EXPORT";
// Holds the job_id of the one pending or running export, or null when idle. Polls read this
// instead of scanning job history, and submission checks it before creating a job.
export const activeSK = "ACTIVE";
const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});
const glue = new GlueClient({});
const jobSchema = z.object({
  job_id: z.string(), status: z.enum(["pending", "running", "complete", "failed"]),
  requested_at: z.string(), export_arn: z.string().optional(), snapshot_id: z.string().optional(),
  snapshot_at: z.string().optional(), error: z.string().optional()
});
const activeSchema = z.object({ job_id: z.string().nullable() });
export const snapshotSchema = z.object({ snapshot_id: z.string(), snapshot_at: z.string(), location: z.string() });
export function config(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
// The pointer names a job only while that job still needs work. A stale pointer to a finished
// or missing job reads as idle, so a release that was lost cannot block submission or the worker.
async function activeJob(store: Store, pointer: StoreItem | undefined): Promise<StoreItem | undefined> {
  const jobId = pointer ? activeSchema.parse(pointer.data).job_id : null;
  if (!jobId) return undefined;
  const row = await store.get(exportPK, `JOB#${jobId}`);
  if (!row) return undefined;
  const { status } = jobSchema.parse(row.data);
  return status === "pending" || status === "running" ? row : undefined;
}
function releaseActive(pointer: StoreItem): StoreWrite {
  return write(exportPK, activeSK, "export_active", { job_id: null }, pointer);
}
export async function requestExport(store: Store): Promise<string> {
  // One durable slot per five minutes prevents refresh storms across instances.
  const slot = Math.floor(Date.now() / 300000);
  const id = `refresh-${slot}`;
  // Creating the job and claiming the pointer happen in one transaction, so two requests cannot
  // both activate a job. A conflict means another request or the worker moved the pointer: reread it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const pointer = await store.get(exportPK, activeSK);
    const active = await activeJob(store, pointer);
    if (active) return jobSchema.parse(active.data).job_id;
    if (await store.get(exportPK, `JOB#${id}`)) return id;
    try {
      await store.transact([
        write(exportPK, `JOB#${id}`, "export_job", { job_id: id, status: "pending", requested_at: new Date().toISOString() }),
        write(exportPK, activeSK, "export_active", { job_id: id }, pointer)
      ]);
      return id;
    } catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
    }
  }
  throw new StoreConflict("The export pointer kept changing; retry the request.");
}
async function checkedManifest(bucket: string, key: string): Promise<string> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error("Missing export manifest");
  const body = await result.Body.transformToString();
  const checksum = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key.replace(/\.json$/, ".md5") }));
  if (!checksum.Body) throw new Error("Missing manifest checksum");
  const expected = (await checksum.Body.transformToString()).trim().replaceAll('"', "");
  const md5 = createHash("md5").update(body);
  if (md5.digest("base64") !== expected) throw new Error("Export manifest checksum mismatch");
  return body;
}
export async function validateExport(bucket: string, manifestKey: string, arn: string): Promise<{ location: string; count: number }> {
  const manifest = z.object({
    exportArn: z.string(), itemCount: z.number().int().nonnegative(),
    manifestFilesS3Key: z.string(), outputFormat: z.literal("DYNAMODB_JSON")
  }).parse(JSON.parse(await checkedManifest(bucket, manifestKey)));
  if (manifest.exportArn !== arn) throw new Error("Export manifest ARN mismatch");
  const prefix = manifestKey.slice(0, manifestKey.lastIndexOf("/") + 1);
  if (!manifest.manifestFilesS3Key.startsWith(prefix)) throw new Error("Export file manifest is outside generation");
  const files = (await checkedManifest(bucket, manifest.manifestFilesS3Key)).split("\n").filter((line) => line.trim()).map((line) =>
    z.object({ itemCount: z.number().int().nonnegative(), dataFileS3Key: z.string(), md5Checksum: z.string(), etag: z.string() }).parse(JSON.parse(line)));
  let count = 0;
  // DynamoDB reuses a shared AWSDynamoDB/data prefix within the requested export prefix.
  const root = prefix.slice(0, prefix.indexOf("AWSDynamoDB/"));
  const locations = new Set<string>();
  for (const file of files) {
    if (!file.dataFileS3Key.startsWith(`${root}AWSDynamoDB/`) || !file.dataFileS3Key.includes("/data/")) throw new Error("Unexpected data object path");
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: file.dataFileS3Key }));
    if (!head.ContentLength) throw new Error("Empty export data file");
    const etag = head.ETag?.replaceAll('"', "");
    if (etag !== file.etag.replaceAll('"', "")) throw new Error("Export data object ETag mismatch");
    count += file.itemCount;
    locations.add(file.dataFileS3Key.slice(0, file.dataFileS3Key.lastIndexOf("/") + 1));
  }
  if (count !== manifest.itemCount || locations.size > 1) throw new Error("Export manifest record count/location mismatch");
  return { location: `s3://${bucket}/${locations.values().next().value ?? `${prefix}data/`}`, count };
}
export async function processExports(store: Store): Promise<void> {
  const pointer = await store.get(exportPK, activeSK);
  const row = await activeJob(store, pointer);
  if (row && pointer) return processJob(store, row, pointer);
  if (pointer && activeSchema.parse(pointer.data).job_id) {
    // The pointer names a finished or missing job; release it so requests can submit again.
    try { await store.transact([releaseActive(pointer)]); }
    catch (error) { if (!(error instanceof StoreConflict)) throw error; }
  }
}
async function processJob(store: Store, row: StoreItem, pointer: StoreItem): Promise<void> {
  const job = jobSchema.parse(row.data);
  try {
    if (job.status === "pending") {
      const tableArn = config("TABLE_ARN");
      if (!job.snapshot_at) {
        const status = await dynamo.send(new DescribeContinuousBackupsCommand({ TableName: config("TABLE_NAME") }));
        const time = status.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.LatestRestorableDateTime;
        if (!time) throw new Error("PITR has no available snapshot time");
        // Persist all variable request parameters before the external side effect.
        await store.transact([write(exportPK, row.SK, "export_job", {
          ...job, snapshot_at: time.toISOString(), snapshot_id: job.job_id
        }, row)]);
        return;
      }
      const time = new Date(job.snapshot_at);
      const response = await dynamo.send(new ExportTableToPointInTimeCommand({
        TableArn: tableArn, S3Bucket: config("PUDDLE_BUCKET"),
        S3Prefix: `exports/${job.job_id}`, ExportFormat: "DYNAMODB_JSON",
        ExportType: "FULL_EXPORT", ExportTime: time, S3SseAlgorithm: "AES256",
        ClientToken: job.job_id
      }));
      if (!response.ExportDescription?.ExportArn) throw new Error("AWS did not return an export ARN");
      await store.transact([write(exportPK, row.SK, "export_job", {
        ...job, status: "running", export_arn: response.ExportDescription.ExportArn,
        snapshot_id: job.job_id, snapshot_at: time.toISOString()
      }, row)]);
      return;
    }
    if (!job.export_arn || !job.snapshot_at || !job.snapshot_id) throw new Error("Running job lacks export metadata");
    const response = await dynamo.send(new DescribeExportCommand({ ExportArn: job.export_arn }));
    const description = response.ExportDescription;
    if (description?.ExportStatus === "FAILED") throw new Error(`AWS export failed: ${description.FailureCode}`);
    if (description?.ExportStatus !== "COMPLETED") return;
    if (!description.ExportManifest) throw new Error("Completed export lacks manifest");
    const checked = await validateExport(config("PUDDLE_BUCKET"), description.ExportManifest, job.export_arn);
    const table = await glue.send(new GetTableCommand({ DatabaseName: config("GLUE_DATABASE"), Name: config("GLUE_TABLE") }));
    if (!table.Table?.StorageDescriptor) throw new Error("Glue table has no storage descriptor");
    try {
      await glue.send(new CreatePartitionCommand({
        DatabaseName: config("GLUE_DATABASE"), TableName: config("GLUE_TABLE"),
        PartitionInput: { Values: [job.snapshot_id], StorageDescriptor: { ...table.Table.StorageDescriptor, Location: checked.location } }
      }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AlreadyExistsException") throw error;
    }
    const latest = await store.get(exportPK, "LATEST");
    const newer = !latest || snapshotSchema.parse(latest.data).snapshot_at < job.snapshot_at;
    await store.transact([
      write(exportPK, row.SK, "export_job", { ...job, status: "complete", item_count: checked.count }, row),
      ...(newer ? [write(exportPK, "LATEST", "snapshot", { snapshot_id: job.snapshot_id, snapshot_at: job.snapshot_at, location: checked.location }, latest)] : []),
      releaseActive(pointer)
    ]);
  } catch (error) {
    if (error instanceof StoreConflict) return;
    console.error("Export job failed", { job_id: job.job_id, error: error instanceof Error ? error.message : String(error) });
    const current = await store.get(exportPK, row.SK);
    const retryable = error instanceof Error && ["TimeoutError", "ThrottlingException", "InternalServerError", "ServiceUnavailable", "NetworkingError"].includes(error.name);
    if (current && current.data.status !== "complete" && !retryable) {
      await store.transact([
        write(exportPK, row.SK, "export_job", { ...current.data, status: "failed", error: error instanceof Error ? error.message : "Export failed" }, current),
        releaseActive(pointer)
      ]);
    }
  }
}
export async function handler(event: { nightly?: boolean } = {}): Promise<{ status: string }> {
  const store = new DynamoStore();
  try {
    if (event.nightly) await requestExport(store);
    await processExports(store);
    return { status: "ok" };
  } finally { store.close(); }
}
