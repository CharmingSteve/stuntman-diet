import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { allItems, StoreConflict, type Store, type StoreWrite } from "../src/store.js";
import { write } from "../src/ledger.js";
import { exportPK, activeSK, requestExport, processExports, validateExport } from "../src/export-handler.js";

const aws = vi.hoisted(() => ({ dynamo: vi.fn(), s3: vi.fn(), glue: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", async (original) => {
  const actual = await original<typeof import("@aws-sdk/client-dynamodb")>();
  return { ...actual, DynamoDBClient: class { send = aws.dynamo; } };
});
vi.mock("@aws-sdk/client-s3", async (original) => {
  const actual = await original<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class { send = aws.s3; } };
});
vi.mock("@aws-sdk/client-glue", async (original) => {
  const actual = await original<typeof import("@aws-sdk/client-glue")>();
  return { ...actual, GlueClient: class { send = aws.glue; } };
});
let store: SQLiteStore;
beforeEach(() => {
  store = new SQLiteStore(createDatabase(":memory:"));
  vi.stubEnv("TABLE_NAME", "table"); vi.stubEnv("TABLE_ARN", "arn:table");
  vi.stubEnv("PUDDLE_BUCKET", "bucket"); vi.stubEnv("GLUE_DATABASE", "diet"); vi.stubEnv("GLUE_TABLE", "ledger");
  vi.clearAllMocks();
});
afterEach(() => { store.close(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function manifests(arn = "arn:export:one") {
  const prefix = "exports/one/AWSDynamoDB/export-one/";
  const files = JSON.stringify({ itemCount: 3, dataFileS3Key: `${prefix}data/a.json.gz`, md5Checksum: "content-checksum", etag: "multipart-2" });
  const summary = JSON.stringify({ exportArn: arn, itemCount: 3, manifestFilesS3Key: `${prefix}manifest-files.json`, outputFormat: "DYNAMODB_JSON" });
  aws.s3.mockImplementation(async (command: { constructor: { name: string }; input: { Key: string } }) => {
    if (command.constructor.name === "HeadObjectCommand") return { ContentLength: 100, ETag: '"multipart-2"' };
    const content = command.input.Key.includes("manifest-summary") ? summary : files;
    return { Body: { transformToString: async () => command.input.Key.endsWith(".md5") ? createHash("md5").update(content).digest("base64") : content } };
  });
  return `${prefix}manifest-summary.json`;
}
// Wraps the real store and records every store call, so tests can assert which reads a poll made.
type StoreCall = { op: "get" | "query" | "transact"; key: string };
function recorded(inner: Store): { store: Store; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  return {
    calls,
    store: {
      get: (PK, SK) => { calls.push({ op: "get", key: `${PK}/${SK}` }); return inner.get(PK, SK); },
      query: (PK, options) => { calls.push({ op: "query", key: `${PK}/${options.prefix ?? ""}` }); return inner.query(PK, options); },
      transact: (writes) => { calls.push({ op: "transact", key: writes.map((w) => w.item.SK).join(",") }); return inner.transact(writes); },
      close: () => inner.close()
    }
  };
}
async function pointer(): Promise<string | null> {
  const row = await store.get(exportPK, activeSK);
  return row ? (row.data.job_id as string | null) : null;
}
async function jobCount(): Promise<number> {
  return (await allItems(store, exportPK, { prefix: "JOB#" })).length;
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const runningJob = (id: string): Record<string, unknown> => ({
  job_id: id, status: "running", requested_at: "2025-01-01T00:00:00Z", snapshot_id: id,
  snapshot_at: "2025-01-01T00:00:00Z", export_arn: `arn:export:${id}`
});
describe("native snapshot publication", () => {
  it("reuses durable refresh slots and never uses a Scan", async () => {
    const id = await requestExport(store);
    expect(await requestExport(store)).toBe(id);
    aws.dynamo.mockImplementation(async (c: { constructor: { name: string } }) => {
      if (c.constructor.name === "DescribeContinuousBackupsCommand") return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { LatestRestorableDateTime: new Date("2025-01-01T00:00:00Z") } } };
      if (c.constructor.name === "ExportTableToPointInTimeCommand") return { ExportDescription: { ExportArn: "arn:one" } };
      throw new Error("Unexpected command");
    });
    await processExports(store);
    expect((await store.get(exportPK, `JOB#${id}`))?.data.snapshot_at).toBe("2025-01-01T00:00:00.000Z");
    expect(aws.dynamo.mock.calls.filter(([c]) => c.constructor.name === "ExportTableToPointInTimeCommand")).toHaveLength(0);
    await processExports(store);
    expect((await store.get(exportPK, `JOB#${id}`))?.data.status).toBe("running");
    expect(await store.get(exportPK, "LATEST")).toBeUndefined();
    expect(aws.dynamo.mock.calls.every(([c]) => c.constructor.name !== "ScanCommand")).toBe(true);
  });
  it("resumes submission after a timeout with exactly the persisted snapshot time", async () => {
    await store.transact([
      write(exportPK, "JOB#retry", "export_job", {
        job_id: "retry", status: "pending", requested_at: "2025-01-01T01:00:00Z", snapshot_at: "2025-01-01T00:00:00Z", snapshot_id: "retry"
      }),
      write(exportPK, activeSK, "export_active", { job_id: "retry" })
    ]);
    aws.dynamo.mockRejectedValueOnce(Object.assign(new Error("connection lost"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ ExportDescription: { ExportArn: "arn:retry" } });
    await processExports(store);
    expect((await store.get(exportPK, "JOB#retry"))?.data.status).toBe("pending");
    expect(await pointer()).toBe("retry");
    await processExports(store);
    const inputs = aws.dynamo.mock.calls.map(([command]) => command.input);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[0].ExportTime.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect((await store.get(exportPK, "JOB#retry"))?.data.status).toBe("running");
    expect(await pointer()).toBe("retry");
  });
  it("validates native manifests/checksums including multipart ETags", async () => {
    const manifest = manifests();
    expect(await validateExport("bucket", manifest, "arn:export:one")).toEqual({ location: "s3://bucket/exports/one/AWSDynamoDB/export-one/data/", count: 3 });
    await expect(validateExport("bucket", manifest, "arn:wrong")).rejects.toThrow(/ARN mismatch/);
  });
  it("does not advance latest when an older export finishes last", async () => {
    const manifest = manifests();
    await store.transact([
      write(exportPK, "LATEST", "snapshot", { snapshot_id: "new", snapshot_at: "2025-02-01T00:00:00.000Z", location: "s3://bucket/new/data/" }),
      write(exportPK, "JOB#one", "export_job", { job_id: "one", status: "running", requested_at: "2025-01-01T00:00:00Z", snapshot_id: "old", snapshot_at: "2025-01-01T00:00:00Z", export_arn: "arn:export:one" }),
      write(exportPK, activeSK, "export_active", { job_id: "one" })
    ]);
    aws.dynamo.mockResolvedValue({ ExportDescription: { ExportStatus: "COMPLETED", ExportManifest: manifest } });
    aws.glue.mockResolvedValue({ Table: { StorageDescriptor: { Columns: [] } } });
    await processExports(store);
    expect((await store.get(exportPK, "LATEST"))?.data.snapshot_id).toBe("new");
    expect((await store.get(exportPK, "JOB#one"))?.data.status).toBe("complete");
  });
  it("records failed exports explicitly while retaining the last good generation", async () => {
    await store.transact([
      write(exportPK, "LATEST", "snapshot", { snapshot_id: "good", snapshot_at: "2025-01-01T00:00:00Z", location: "s3://bucket/good/data/" }),
      write(exportPK, "JOB#failed", "export_job", { job_id: "failed", status: "running", requested_at: "2025-02-01T00:00:00Z", snapshot_id: "failed", snapshot_at: "2025-02-01T00:00:00Z", export_arn: "arn:failed" }),
      write(exportPK, activeSK, "export_active", { job_id: "failed" })
    ]);
    aws.dynamo.mockResolvedValue({ ExportDescription: { ExportStatus: "FAILED", FailureCode: "AccessDenied" } });
    await processExports(store);
    expect((await store.get(exportPK, "JOB#failed"))?.data).toMatchObject({ status: "failed", error: "AWS export failed: AccessDenied" });
    expect((await store.get(exportPK, "LATEST"))?.data.snapshot_id).toBe("good");
    expect(aws.glue).not.toHaveBeenCalled();
  });
});
describe("active export pointer", () => {
  it("an idle poll reads only the pointer, never job history", async () => {
    const history: StoreWrite[] = ["one", "two", "three", "four", "five"].map((id) => write(exportPK, `JOB#${id}`, "export_job", {
      job_id: id, status: "complete", requested_at: "2025-01-01T00:00:00Z", snapshot_id: id, snapshot_at: "2025-01-01T00:00:00Z"
    }));
    await store.transact([...history, write(exportPK, activeSK, "export_active", { job_id: null })]);
    const watched = recorded(store);
    await processExports(watched.store);
    // A query here would mean the poll is scanning history again, which scales with every job ever run.
    expect(watched.calls).toEqual([{ op: "get", key: `${exportPK}/${activeSK}` }]);
    expect(aws.dynamo).not.toHaveBeenCalled();
  });
  it("an active poll reads the pointer and its job, then writes that job only", async () => {
    await store.transact([
      write(exportPK, "JOB#busy", "export_job", { job_id: "busy", status: "pending", requested_at: "2025-01-01T00:00:00Z" }),
      write(exportPK, "JOB#old", "export_job", { job_id: "old", status: "complete", requested_at: "2024-12-01T00:00:00Z" }),
      write(exportPK, activeSK, "export_active", { job_id: "busy" })
    ]);
    aws.dynamo.mockResolvedValue({ ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { LatestRestorableDateTime: new Date("2025-01-01T00:00:00Z") } } });
    const watched = recorded(store);
    await processExports(watched.store);
    expect(watched.calls).toEqual([
      { op: "get", key: `${exportPK}/${activeSK}` },
      { op: "get", key: `${exportPK}/JOB#busy` },
      { op: "transact", key: "JOB#busy" }
    ]);
  });
  it("refresh requests across later slots return the live job instead of creating another", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-01-01T00:00:00Z");
    const first = await requestExport(store);
    at("2026-01-01T00:10:00Z");
    expect(await requestExport(store)).toBe(first);
    expect(await jobCount()).toBe(1);
    expect(await pointer()).toBe(first);
  });
  it("concurrent submissions activate exactly one job", async () => {
    const ids = await Promise.all([requestExport(store), requestExport(store), requestExport(store), requestExport(store)]);
    expect(new Set(ids).size).toBe(1);
    expect(await jobCount()).toBe(1);
    expect(await pointer()).toBe(ids[0]);
  });
  it("a stale pointer read retries and returns the live job rather than creating a second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-01-01T00:00:00Z");
    const first = await requestExport(store);
    at("2026-01-01T00:10:00Z");
    // The first read sees an idle pointer although one exists. The transaction must reject it.
    vi.spyOn(store, "get").mockImplementationOnce(async () => undefined);
    expect(await requestExport(store)).toBe(first);
    expect(await jobCount()).toBe(1);
  });
  it("a completed export releases the pointer in the same transaction that publishes LATEST", async () => {
    const manifest = manifests();
    await store.transact([
      write(exportPK, "JOB#one", "export_job", { job_id: "one", status: "running", requested_at: "2025-01-01T00:00:00Z", snapshot_id: "one", snapshot_at: "2025-01-01T00:00:00Z", export_arn: "arn:export:one" }),
      write(exportPK, activeSK, "export_active", { job_id: "one" })
    ]);
    aws.dynamo.mockResolvedValue({ ExportDescription: { ExportStatus: "COMPLETED", ExportManifest: manifest } });
    aws.glue.mockResolvedValue({ Table: { StorageDescriptor: { Columns: [] } } });
    const watched = recorded(store);
    await processExports(watched.store);
    const publish = watched.calls.filter((c) => c.op === "transact").at(-1);
    expect(publish?.key.split(",").sort()).toEqual(["ACTIVE", "JOB#one", "LATEST"]);
    expect(await pointer()).toBeNull();
    expect((await store.get(exportPK, "LATEST"))?.data.snapshot_id).toBe("one");
  });
  it("a publication that loses a race keeps the job active so the next poll finishes it", async () => {
    const manifest = manifests();
    await store.transact([
      write(exportPK, "JOB#one", "export_job", { job_id: "one", status: "running", requested_at: "2025-01-01T00:00:00Z", snapshot_id: "one", snapshot_at: "2025-01-01T00:00:00Z", export_arn: "arn:export:one" }),
      write(exportPK, activeSK, "export_active", { job_id: "one" })
    ]);
    aws.dynamo.mockResolvedValue({ ExportDescription: { ExportStatus: "COMPLETED", ExportManifest: manifest } });
    aws.glue.mockResolvedValue({ Table: { StorageDescriptor: { Columns: [] } } });
    vi.spyOn(store, "transact").mockRejectedValueOnce(new StoreConflict());
    await processExports(store);
    expect(await pointer()).toBe("one");
    expect((await store.get(exportPK, "JOB#one"))?.data.status).toBe("running");
    await processExports(store);
    expect(await pointer()).toBeNull();
    expect((await store.get(exportPK, "JOB#one"))?.data.status).toBe("complete");
  });
  it("a failed export releases the pointer so the next request submits a fresh job", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-01-01T00:00:00Z");
    const first = await requestExport(store);
    await store.transact([write(exportPK, `JOB#${first}`, "export_job", { ...runningJob(first), job_id: first }, await store.get(exportPK, `JOB#${first}`))]);
    aws.dynamo.mockResolvedValue({ ExportDescription: { ExportStatus: "FAILED", FailureCode: "AccessDenied" } });
    await processExports(store);
    expect(await pointer()).toBeNull();
    at("2026-01-01T00:10:00Z");
    const second = await requestExport(store);
    expect(second).not.toBe(first);
    expect(await pointer()).toBe(second);
    expect(await jobCount()).toBe(2);
  });
  it("a stale pointer to a finished job does not block a new submission", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-01-01T00:00:00Z");
    await store.transact([
      write(exportPK, "JOB#done", "export_job", { job_id: "done", status: "complete", requested_at: "2025-12-31T00:00:00Z" }),
      write(exportPK, activeSK, "export_active", { job_id: "done" })
    ]);
    const id = await requestExport(store);
    expect(id).not.toBe("done");
    expect(await pointer()).toBe(id);
  });
  it("a pointer naming a missing job is released by the worker without any AWS call", async () => {
    await store.transact([write(exportPK, activeSK, "export_active", { job_id: "ghost" })]);
    await processExports(store);
    expect(await pointer()).toBeNull();
    expect(aws.dynamo).not.toHaveBeenCalled();
  });
});
