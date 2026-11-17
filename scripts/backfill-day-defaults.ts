import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { daySchema } from "../src/ledger.js";
import { repairStoredDay } from "../src/backfill.js";

// One-time production repair (see src/backfill.ts). Dry run unless --apply is given.
// Usage: npx tsx scripts/backfill-day-defaults.ts --table <TableName> [--region us-east-1] [--today YYYY-MM-DD] [--apply]
// Take a DynamoDB backup before --apply. Each write is conditional on the version it read.

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const table = arg("table");
if (!table) throw new Error("--table is required");
const region = arg("region") ?? "us-east-1";
const today = arg("today") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
const apply = process.argv.includes("--apply");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
type Change = { PK: string; SK: string; version: number; data: Record<string, unknown>; summary: string };
const changes: Change[] = [];
let scanned = 0;
let startKey: Record<string, unknown> | undefined;
do {
  const page = await client.send(new ScanCommand({
    TableName: table,
    ExclusiveStartKey: startKey,
    FilterExpression: "entity = :e AND contains(SK, :meta)",
    ExpressionAttributeValues: { ":e": "day", ":meta": "#META" }
  }));
  startKey = page.LastEvaluatedKey;
  for (const item of page.Items ?? []) {
    scanned += 1;
    const before = daySchema.parse(item.data);
    const after = repairStoredDay(before, today);
    const fields = ["burn_total", "burn_source", "completeness"] as const;
    if (fields.every((f) => before[f] === after[f])) continue;
    changes.push({
      PK: String(item.PK), SK: String(item.SK), version: Number(item.version),
      data: { ...item.data, burn_total: after.burn_total, burn_source: after.burn_source, completeness: after.completeness },
      summary: `${before.day_key} ${before.eligibility}: completeness ${before.completeness}→${after.completeness}, burn ${before.burn_total ?? "none"} ${before.burn_source ?? ""}→${after.burn_total ?? "none"} ${after.burn_source ?? ""}`
    });
  }
} while (startKey);

console.log(`Scanned ${scanned} day records; today is ${today}; ${changes.length} would change.`);
for (const change of changes) console.log(`  ${change.summary}`);

if (!apply) {
  console.log("Dry run only. Re-run with --apply to write.");
} else {
  let written = 0;
  for (const change of changes) {
    await client.send(new UpdateCommand({
      TableName: table,
      Key: { PK: change.PK, SK: change.SK },
      ConditionExpression: "#v = :expected",
      UpdateExpression: "SET #data = :data, #v = :next",
      ExpressionAttributeNames: { "#v": "version", "#data": "data" },
      ExpressionAttributeValues: { ":expected": change.version, ":next": change.version + 1, ":data": change.data }
    }));
    written += 1;
  }
  console.log(`Wrote ${written} day records.`);
}
