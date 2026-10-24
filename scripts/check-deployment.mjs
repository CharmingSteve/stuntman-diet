import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function validateEnvironmentKeys(template) {
  const lines = template.split("\n");
  const reserved = new Set([
    "_HANDLER", "_X_AMZN_TRACE_ID", "AWS_DEFAULT_REGION", "AWS_REGION", "AWS_EXECUTION_ENV",
    "AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "AWS_LAMBDA_FUNCTION_VERSION",
    "AWS_LAMBDA_INITIALIZATION_TYPE", "AWS_LAMBDA_LOG_GROUP_NAME", "AWS_LAMBDA_LOG_STREAM_NAME",
    "AWS_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_KEY", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_LAMBDA_RUNTIME_API", "LAMBDA_TASK_ROOT", "LAMBDA_RUNTIME_DIR"
  ]);
  let environmentIndent = null;
  for (const line of lines) {
    if (/^\s*EnvironmentVariables:\s*$/.test(line)) {
      environmentIndent = line.search(/\S/);
      continue;
    }
    if (environmentIndent === null || !line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent <= environmentIndent) { environmentIndent = null; continue; }
    const key = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):/)?.[1];
    assert.ok(!reserved.has(key), `Web Function environment contains reserved runtime key ${key}`);
  }
}
validateEnvironmentKeys(readFileSync(new URL("../infra/template.yaml", import.meta.url), "utf8"));

function aws(...args) {
  return JSON.parse(execFileSync("aws", [...args, "--output", "json"], {
    encoding: "utf8", env: { ...process.env, AWS_PAGER: "" }
  }));
}
const mode = process.argv[2] ?? "preflight";
assert.ok(["preflight", "post"].includes(mode), "Usage: check-deployment.mjs [preflight|post] [stack]");
assert.equal(aws("sts", "get-caller-identity").Account, "570989156105", "Wrong AWS account");
if (mode === "preflight") {
  for (const type of ["WebFunction", "WebFunctionRevision", "WebFunctionEndpoint"]) {
    const schema = JSON.parse(aws("cloudformation", "describe-type", "--type", "RESOURCE",
      "--type-name", `AWS::Lambda::${type}`).Schema);
    if (type === "WebFunctionRevision") {
      const props = schema.properties.ServiceConfig.properties;
      assert.ok(props.EnvironmentVariables && props.ExecutionRoleArn, "Missing durable-store environment support");
      assert.ok(schema.properties.BuildConfig.properties.CodeConfig, "Missing ZIP code support");
    }
    if (type === "WebFunctionEndpoint") {
      const min = schema.definitions.ScalingConfig.properties.MaxEnvironments.minimum;
      assert.ok(typeof min === "number" && min <= 2, `Unsupported minimum environment count ${min}`);
      assert.ok(schema.properties.AuthType.enum.includes("ApplicationManaged"));
    }
  }
  console.info("Preflight passed: native Web Functions support DynamoDB configuration and two environments. No deployment performed.");
} else {
  const stack = process.argv[3];
  assert.ok(stack, "post requires a stack name");
  const outputs = Object.fromEntries(aws("cloudformation", "describe-stacks", "--stack-name", stack)
    .Stacks[0].Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
  for (const key of ["WebFunctionUrl", "TableName", "PuddleBucketName", "AthenaWorkgroupName", "GlueDatabaseName", "ExportWorkerName"]) {
    assert.ok(outputs[key], `Missing ${key}`);
  }
  const backup = aws("dynamodb", "describe-continuous-backups", "--table-name", outputs.TableName);
  assert.equal(backup.ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus, "ENABLED");
  const table = aws("dynamodb", "describe-table", "--table-name", outputs.TableName).Table;
  assert.equal(table.DeletionProtectionEnabled, true);
  assert.equal(aws("s3api", "get-bucket-versioning", "--bucket", outputs.PuddleBucketName).Status, "Enabled");
  assert.ok(aws("s3api", "get-bucket-encryption", "--bucket", outputs.PuddleBucketName)
    .ServerSideEncryptionConfiguration.Rules.length);
  assert.ok(Object.values(aws("s3api", "get-public-access-block", "--bucket", outputs.PuddleBucketName)
    .PublicAccessBlockConfiguration).every(Boolean));
  const workgroup = aws("athena", "get-work-group", "--work-group", outputs.AthenaWorkgroupName).WorkGroup;
  assert.equal(workgroup.Configuration.EnforceWorkGroupConfiguration, true);
  const worker = aws("lambda", "get-function-configuration", "--function-name", outputs.ExportWorkerName);
  assert.equal(worker.Handler, "dist/export-handler.handler");
  assert.equal(worker.Environment.Variables.TABLE_NAME, outputs.TableName);
  console.info("Post-deployment checks passed: durable encrypted storage, PITR, private versioned exports, and worker wiring.");
}
