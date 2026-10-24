import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stack = process.argv[2];
assert.match(stack ?? "", /^stuntman-diet-(staging|production)$/);
const fixture = process.argv.includes("--fixture");
assert.ok(!fixture || stack.endsWith("-staging"), "Fixtures are staging-only");
function aws(...args) {
  const output = execFileSync("aws", [...args, "--output", "json"], {
    encoding: "utf8", env: { ...process.env, AWS_PAGER: "" }, maxBuffer: 8 * 1024 * 1024
  });
  return output.trim() ? JSON.parse(output) : {};
}
assert.equal(aws("sts", "get-caller-identity").Account, "570989156105");
assert.equal(process.env.AWS_REGION, "us-east-1");
function outputs(name) {
  return Object.fromEntries(aws("cloudformation", "describe-stacks", "--stack-name", name).Stacks[0].Outputs
    .map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
}
const deployed = outputs(stack);
const auth = outputs(`${stack}-auth`);
const base = deployed.WebFunctionUrl;
assert.equal((await fetch(`${base}/health`)).status, 200, "health smoke");
console.info("PASS GET /health -> 200");
assert.equal((await fetch(`${base}/api/history`)).status, 401, "unauthenticated protected-route smoke");
console.info("PASS protected route without token -> 401");
const secret = aws("cognito-idp", "describe-user-pool-client", "--user-pool-id", auth.CognitoUserPool,
  "--client-id", auth.SmokeClientId).UserPoolClient.ClientSecret;
if (process.env.GITHUB_ACTIONS) console.info(`::add-mask::${secret}`);
const tokenResponse = await fetch(`${auth.CognitoDomain}/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${Buffer.from(`${auth.SmokeClientId}:${secret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", scope: "diet-smoke/parse" })
});
assert.equal(tokenResponse.status, 200, "Cognito client_credentials");
const { access_token: token } = await tokenResponse.json();
assert.ok(token, "Missing access token");
if (process.env.GITHUB_ACTIONS) console.info(`::add-mask::${token}`);
const parse = await fetch(`${base}/api/chat`, {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "protein drink 200 calories", client_time: "2025-01-05T12:00:00+02:00" })
});
assert.equal(parse.status, 200, "Bedrock parse smoke");
const parsed = await parse.json();
assert.equal(parsed.intent, "food_log");
assert.ok(parsed.summary);
assert.equal(parsed.items[0].calories, 200);
console.info("PASS one Bedrock-backed parse with Cognito test JWT -> 200");

function marshal(value) {
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshal) };
  return { M: Object.fromEntries(Object.entries(value).map(([key, val]) => [key, marshal(val)])) };
}
function put(item) {
  aws("dynamodb", "put-item", "--table-name", deployed.TableName, "--item", JSON.stringify(marshal(item).M),
    "--condition-expression", "attribute_not_exists(PK)");
}
function get(PK, SK) {
  return aws("dynamodb", "get-item", "--table-name", deployed.TableName,
    "--key", JSON.stringify({ PK: { S: PK }, SK: { S: SK } }), "--consistent-read").Item;
}
async function waitFor(test, seconds, label) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await test();
    if (result) return result;
    await sleep(15000);
  }
  throw new Error(`Timed out: ${label}`);
}
async function query(sql) {
  const id = aws("athena", "start-query-execution", "--work-group", deployed.AthenaWorkgroupName,
    "--query-execution-context", JSON.stringify({ Database: deployed.GlueDatabaseName }),
    "--query-string", sql).QueryExecutionId;
  await waitFor(() => {
    const execution = aws("athena", "get-query-execution", "--query-execution-id", id).QueryExecution;
    if (["FAILED", "CANCELLED"].includes(execution.Status.State)) {
      throw new Error(`Athena smoke failed: ${execution.Status.StateChangeReason}`);
    }
    return execution.Status.State === "SUCCEEDED";
  }, 180, "Athena query");
  return aws("athena", "get-query-results", "--query-execution-id", id).ResultSet.Rows;
}
if (fixture) {
  const { analyticsSQL } = await import(pathToFileURL(resolve(process.env.ANALYTICS_MODULE ?? "dist/analytics.js")).href);
  const user = `smoke:${auth.SmokeClientId}:fixture:${randomUUID()}`;
  const PK = `USER#${user}`;
  const day = "2026-01-05";
  const seeded = [];
  try {
    const common = { user_id: user, day_key: day, timezone: "Asia/Jerusalem" };
    put({ PK, SK: "PROFILE", entity: "profile", version: 1,
      data: { user_id: user, timezone: "Asia/Jerusalem", holidays: [], non_tracking_weekdays: [] } });
    seeded.push("PROFILE");
    for (const [id, calories] of [["a", 100], ["b", 200]]) {
      const SK = `DAY#${day}#ENTRY#${id}`;
      put({ PK, SK, entity: "entry", version: 1,
        data: { ...common, display_name: `Synthetic fixture ${id}`, calories, status: "active", calories_source: "user" } });
      seeded.push(SK);
    }
    const SK = `DAY#${day}#META`;
    put({ PK, SK, entity: "day", version: 1,
      data: { ...common, burn_total: 2000, burn_source: "recorded", eligibility: "tracked", completeness: "complete" } });
    seeded.push(SK);
    const seededAt = Date.now();
    // DynamoDB PITR intentionally trails live writes. Never export before the fixture is restorable.
    await waitFor(() => {
      const pitr = aws("dynamodb", "describe-continuous-backups", "--table-name", deployed.TableName)
        .ContinuousBackupsDescription.PointInTimeRecoveryDescription;
      return new Date(pitr.LatestRestorableDateTime).getTime() >= seededAt;
    }, 900, "PITR includes seeded fixture");
    const snapshots = [];
    for (let index = 0; index < 2; index++) {
      const job = randomUUID();
      put({ PK: "SYSTEM#EXPORT", SK: `JOB#${job}`, entity: "export_job", version: 1,
        data: { job_id: job, status: "pending", requested_at: new Date().toISOString() } });
      const finished = await waitFor(() => {
        const row = get("SYSTEM#EXPORT", `JOB#${job}`);
        const status = row?.data.M.status.S;
        assert.notEqual(status, "failed", "Scheduled export worker reported failure");
        return status === "complete" ? row : null;
      }, 1800, "scheduled worker publishes native export");
      const snapshot = finished.data.M.snapshot_id.S;
      snapshots.push(snapshot);
      const partition = aws("glue", "get-partition", "--database-name", deployed.GlueDatabaseName,
        "--table-name", deployed.GlueTableName, "--partition-values", snapshot).Partition;
      assert.ok(partition.StorageDescriptor.Location.startsWith(`s3://${deployed.PuddleBucketName}/exports/`));
      assert.ok(partition.StorageDescriptor.Location.endsWith("/data/"), "Partition must exclude manifests");
      const rows = await query(`
        WITH selected AS (
          SELECT item FROM "${deployed.GlueTableName}"
          WHERE snapshot = '${snapshot}' AND item.pk.s = '${PK}'
        ), intake AS (
          SELECT sum(CAST(item.data.m.calories.n AS double)) AS total, count(*) AS entries
          FROM selected WHERE item.entity.s = 'entry' AND item.data.m.status.s = 'active'
        ), burn AS (
          SELECT sum(CAST(item.data.m.burn_total.n AS double)) AS total
          FROM selected WHERE item.entity.s = 'day'
            AND item.data.m.completeness.s = 'complete' AND item.data.m.eligibility.s = 'tracked'
        )
        SELECT intake.total, burn.total, intake.total - burn.total, entries FROM intake CROSS JOIN burn`);
      assert.deepEqual(rows[1].Data.map(cell => Number(cell.VarCharValue)), [300, 2000, -1700, 2],
        "Selected snapshot totals must not multiply across exports");
      const reports = await query(analyticsSQL(deployed.GlueDatabaseName, deployed.GlueTableName,
        snapshot, user, day, "2026-01-07", finished.data.M.snapshot_at.S));
      const headers = reports[0].Data.map(cell => cell.VarCharValue);
      const records = reports.slice(1).map(row => Object.fromEntries(
        headers.map((header, offset) => [header, row.Data[offset]?.VarCharValue])));
      for (const kind of ["weekly", "monthly"]) {
        const report = records.find(row => row.kind === kind);
        assert.ok(report, `Application analytics must return ${kind} report`);
        assert.deepEqual(["intake", "burn", "net", "entries", "eligible", "complete", "partial", "missing", "excluded", "assumed"]
          .map(key => Number(report[key])), [300, 2000, -1700, 2, 3, 1, 0, 2, 0, 0],
        "Actual analyticsSQL must include two absent tracked dates without inventing burn");
      }
      console.info(`PASS native export ${index + 1}: selected-snapshot intake=300 burn=2000 net=-1700`);
    }
    assert.notEqual(snapshots[0], snapshots[1], "Two distinct exports must exist");
    assert.ok(get("SYSTEM#EXPORT", "LATEST")?.data.M.snapshot_id.S, "Missing atomically published latest pointer");
  } finally {
    for (const SK of seeded) {
      aws("dynamodb", "delete-item", "--table-name", deployed.TableName,
        "--key", JSON.stringify({ PK: { S: PK }, SK: { S: SK } }));
    }
  }
}
