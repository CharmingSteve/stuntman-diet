import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../src/db.js";
import { SQLiteStore } from "../src/store-sqlite.js";
import { write } from "../src/ledger.js";
import { exportPK, requestExport, processExports, validateExport } from "../src/export-handler.js";

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
afterEach(() => { store.close(); vi.unstubAllEnvs(); });
function manifests(arn = "arn:export:one") {
  const prefix = "exports/one/AWSDynamoDB/export-one/";
  const files = JSON.stringify({ itemCount: 3, dataFileS3Key: `${prefix}data/a.json.gz`, md5Checksum: "content-checksum", etag: "multipart-2" });
  const summary = JSON.stringify({ exportArn: arn, itemCount: 3, manifestFilesS3Key: `${prefix}manifest-files.json`, outputFormat: "DYNAMODB_JSON" });
  aws.s3.mockImplementation(async (command: { constructor: { name: string }; input: { Key: string } }) => {
    if (command.constructor.name === "HeadObjectCommand") return { ContentLength: 100, ETag: '"multipart-2"' };
    const content = command.input.Key.includes("manifest-summary") ? summary : files;
    return { Body: { transformToString: async () => command.input.Key.endsWith(".checksum") ? createHash("md5").update(content).digest("base64") : content } };
  });
  return `${prefix}manifest-summary.json`;
}
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
    await store.transact([write(exportPK, "JOB#retry", "export_job", {
      job_id: "retry", status: "pending", requested_at: "2025-01-01T01:00:00Z", snapshot_at: "2025-01-01T00:00:00Z", snapshot_id: "retry"
    })]);
    aws.dynamo.mockRejectedValueOnce(Object.assign(new Error("connection lost"), { name: "TimeoutError" }))
      .mockResolvedValueOnce({ ExportDescription: { ExportArn: "arn:retry" } });
    await processExports(store);
    expect((await store.get(exportPK, "JOB#retry"))?.data.status).toBe("pending");
    await processExports(store);
    const inputs = aws.dynamo.mock.calls.map(([command]) => command.input);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[0].ExportTime.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect((await store.get(exportPK, "JOB#retry"))?.data.status).toBe("running");
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
      write(exportPK, "JOB#one", "export_job", { job_id: "one", status: "running", requested_at: "2025-01-01T00:00:00Z", snapshot_id: "old", snapshot_at: "2025-01-01T00:00:00Z", export_arn: "arn:export:one" })
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
      write(exportPK, "JOB#failed", "export_job", { job_id: "failed", status: "running", requested_at: "2025-02-01T00:00:00Z", snapshot_id: "failed", snapshot_at: "2025-02-01T00:00:00Z", export_arn: "arn:failed" })
    ]);
    aws.dynamo.mockResolvedValue({ ExportDescription: { ExportStatus: "FAILED", FailureCode: "AccessDenied" } });
    await processExports(store);
    expect((await store.get(exportPK, "JOB#failed"))?.data).toMatchObject({ status: "failed", error: "AWS export failed: AccessDenied" });
    expect((await store.get(exportPK, "LATEST"))?.data.snapshot_id).toBe("good");
    expect(aws.glue).not.toHaveBeenCalled();
  });
});
