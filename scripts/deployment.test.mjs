import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const fakeAws = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const command = args.slice(0, 2).join(" ");
const option = name => args[args.indexOf(name) + 1];
let state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, "utf8"));
let result;
switch (command) {
case "sts get-caller-identity": result = {Account: process.env.TEST_ACCOUNT ?? "570989156105"}; break;
case "cloudformation describe-type": {
 const type = option("--type-name");
 const schema = type.endsWith("Endpoint") ? {
   definitions:{ScalingConfig:{properties:{MaxEnvironments:{minimum:2}}}},
   properties:{AuthType:{enum:["ApplicationManaged"]}}
 } : {properties:{ServiceConfig:{properties:{EnvironmentVariables:{},ExecutionRoleArn:{}}},
   BuildConfig:{properties:{CodeConfig:{}}}}};
 result = {Schema:JSON.stringify(schema)}; break;
}
case "cloudformation describe-stacks": {
 const auth = option("--stack-name").endsWith("-auth");
 const values = auth ? {CognitoUserPool:"pool",SmokeClientId:"client",CognitoDomain:"https://auth.example"} :
 {WebFunctionUrl:"https://app.example",TableName:"table",PuddleBucketName:"puddle",
  AthenaWorkgroupName:"workgroup",GlueDatabaseName:"diet_staging",GlueTableName:"diet_items",ExportWorkerName:"worker"};
 result = {Stacks:[{Outputs:Object.entries(values).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]}; break;
}
case "cognito-idp describe-user-pool-client": result={UserPoolClient:{ClientSecret:"synthetic-secret"}}; break;
case "dynamodb put-item": {
 const item = JSON.parse(option("--item"));
 state.puts.push(item);
 if (item.entity.S === "export_job") state.job=item.data.M.job_id.S;
 result={}; break;
}
case "dynamodb delete-item": state.deletes.push(JSON.parse(option("--key"))); result={}; break;
case "dynamodb describe-continuous-backups":
 result={ContinuousBackupsDescription:{PointInTimeRecoveryDescription:{
 PointInTimeRecoveryStatus:"ENABLED",LatestRestorableDateTime:new Date(Date.now()+86400000).toISOString()}}}; break;
case "dynamodb get-item":
 result={Item:{data:{M:{status:{S:"complete"},snapshot_id:{S:state.job},snapshot_at:{S:"2026-01-08T00:00:00Z"}}}}}; break;
case "glue get-partition":
 result={Partition:{StorageDescriptor:{Location:"s3://puddle/exports/"+state.job+"/AWSDynamoDB/id/data/"}}}; break;
case "athena start-query-execution": {
 const sql=option("--query-string");
 if (!sql.includes("snapshot = '"+state.job+"'") || !sql.includes("item.pk.s = 'USER#smoke:client:fixture:"))
   throw new Error("Query is not snapshot/user scoped");
 state.application=sql.includes("APP_ANALYTICS");
 state.queries.push(sql); result={QueryExecutionId:"query"}; break;
}
case "athena get-query-execution": result={QueryExecution:{Status:{State:"SUCCEEDED"}}}; break;
case "athena get-query-results":
 result={ResultSet:{Rows:state.application ?
 [["kind","intake","burn","net","entries","eligible","complete","partial","missing","excluded","assumed"],
 ["weekly","300","2000","-1700","2","3","1","0","2","0","0"],
 ["monthly","300","2000","-1700","2","3","1","0","2","0","0"]].map(values=>({Data:values.map(VarCharValue=>({VarCharValue}))})) :
 [{Data:[]},{Data:["300","2000","-1700","2"].map(VarCharValue=>({VarCharValue}))}]}}; break;
default: throw new Error("Unexpected AWS command: "+command);
}
writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));
console.log(JSON.stringify(result));
`;
const preload = `
globalThis.fetch = async (url, options) => {
 const path = new URL(url).pathname;
 let status=200;
 let body={};
 if(path==="/api/history") status=401;
 else if(path==="/oauth2/token") body={access_token:"synthetic-token"};
 else if(path==="/api/chat") {
   if(!/^[A-Za-z0-9:_-]{8,120}$/.test(options?.headers?.["Idempotency-Key"] ?? ""))
     return new Response(JSON.stringify({error:"Missing idempotency key"}),{status:400});
   if(JSON.parse(options.body).client_time !== "2025-01-05T12:00:00+02:00")
     throw new Error("Smoke chat must use the tracked synthetic Sunday");
   body={intent:"food_log",summary:"synthetic",items:[{calories:200}]};
 }
 else if(path.endsWith("/environments/production")) body={
   protection_rules:process.env.TEST_NO_APPROVAL ? [] : [{type:"required_reviewers",reviewers:[{type:"User",id:1}]}],
   deployment_branch_policy:{custom_branch_policies:true}};
 else if(path.endsWith("/deployment-branch-policies")) body={branch_policies:[{name:"main",type:"branch"}]};
 else if(path.endsWith("/branches/main")) body={protected:true};
 else if(path!=="/health") throw new Error("Unexpected HTTP path");
 return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
};
`;
function fixture(run) {
  const directory = mkdtempSync(join(root, ".deployment-test-"));
  const state = join(directory, "state.json");
  writeFileSync(join(directory, "aws"), fakeAws, { mode: 0o700 });
  writeFileSync(join(directory, "preload.mjs"), preload);
  writeFileSync(join(directory, "analytics.mjs"),
    "export const analyticsSQL = (db,table,snapshot,user) => `APP_ANALYTICS snapshot = '${snapshot}' item.pk.s = 'USER#${user}'`;\n");
  writeFileSync(state, JSON.stringify({ puts: [], deletes: [], queries: [] }));
  const execute = (script, args = [], extra = {}) => spawnSync(process.execPath, [
    "--import", join(directory, "preload.mjs"), `scripts/${script}`, ...args
  ], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
    AWS_REGION: "us-east-1", FIXTURE_STATE: state, GH_TOKEN: "synthetic", GH_REPOSITORY: "owner/repo",
    GITHUB_ACTIONS: "", ANALYTICS_MODULE: join(directory, "analytics.mjs"), ...extra } });
  try { run(execute, () => JSON.parse(readFileSync(state, "utf8"))); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
test("preflight accepts durable native Web Functions and refuses a different AWS account", () => fixture(execute => {
  const accepted = execute("check-deployment.mjs", ["preflight"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /No deployment performed/);
  assert.notEqual(execute("check-deployment.mjs", ["preflight"], { TEST_ACCOUNT: "000000000000" }).status, 0);
}));
test("cloud smoke retains three HTTP checks and two independently scoped export queries", () => fixture((execute, state) => {
  const result = execute("cloud-smoke.mjs", ["stuntman-diet-staging", "--fixture"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/PASS/g) ?? []).length, 5);
  assert.ok(!result.stdout.includes("synthetic-secret") && !result.stdout.includes("synthetic-token"));
  assert.equal(state().puts.length, 6);
  assert.equal(state().queries.length, 4);
  assert.equal(state().deletes.length, 4);
}));
test("production cannot run synthetic fixture exports", () => fixture(execute => {
  assert.notEqual(execute("cloud-smoke.mjs", ["stuntman-diet-production", "--fixture"]).status, 0);
}));
test("production gate requires configured reviewers and branch protection", () => fixture(execute => {
  assert.equal(execute("verify-production-gate.mjs").status, 0);
  assert.notEqual(execute("verify-production-gate.mjs", [], { TEST_NO_APPROVAL: "1" }).status, 0);
}));
test("Web Function environment omits AWS runtime-reserved keys", () => {
  const template = readFileSync(join(root, "infra/template.yaml"), "utf8");
  const environment = template.split("EnvironmentVariables:")[1].split("BuildConfig:")[0];
  for (const key of ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    assert.doesNotMatch(environment, new RegExp(`^\\s*${key}:`, "m"));
  }
  const checker = readFileSync(join(root, "scripts/check-deployment.mjs"), "utf8");
  const functionSource = checker.slice(checker.indexOf("export function validateEnvironmentKeys("),
    checker.indexOf('validateEnvironmentKeys(readFileSync'));
  const validate = new Function("assert", `${functionSource.replace("export ", "")}; return validateEnvironmentKeys;`)(assert);
  assert.doesNotThrow(() => validate(template));
  assert.throws(() => validate(template.replace("EnvironmentVariables:", "EnvironmentVariables:\n          AWS_REGION: us-east-1")),
    /reserved runtime key AWS_REGION/);
});
test("production promotion only follows main push or explicitly requested main dispatch and retains approval gates", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const production = workflow.split("  deploy-production:")[1];
  assert.match(production, /if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.production\)\)/);
  assert.match(production, /needs: deploy-staging-and-smoke-test/);
  assert.match(production, /environment: production/);
  assert.match(production, /node scripts\/verify-production-gate\.mjs/);
});
test("DynamoDB readiness only permits loopback endpoints", () => fixture(execute => {
  for (const endpoint of ["https://127.0.0.1:8000", "http://user:pass@localhost:8000",
    "http://example.com:8000", "http://localhost:8000/path", "http://localhost:8000?x=1"]) {
    assert.notEqual(execute("wait-dynamo.mjs", [], { DYNAMODB_ENDPOINT: endpoint }).status, 0);
  }
}));
test("production gate can read environment protection and prompt objects are revision-scoped", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const production = workflow.split("  deploy-production:")[1];
  assert.match(production, /permissions:\s+contents: read\s+actions: read/);
  const deploy = readFileSync(join(root, "scripts/deploy.mjs"), "utf8");
  assert.ok(deploy.includes("`releases/${process.env.BUILD_REVISION}/system-prompt.md`"));
  assert.ok(deploy.includes("`SystemPromptKey=${promptKey}`"));
  const template = readFileSync(join(root, "infra/template.yaml"), "utf8");
  assert.ok(template.includes("SYSTEM_PROMPT_PATH: !Sub s3://${CodeBucket}/${SystemPromptKey}"));
  assert.ok(template.includes("arn:${AWS::Partition}:s3:::${CodeBucket}/${SystemPromptKey}"));
  assert.ok(!deploy.includes("/prompts/stuntman-diet-system-prompt.md"));
});
test("Glue table uses an inert empty root and snapshot partitions select export data only", () => {
  const template = readFileSync(join(root, "infra/template.yaml"), "utf8");
  const table = template.split("  GlueTable:")[1].split("  AthenaWorkgroup:")[0];
  assert.match(table, /Location: !Sub s3:\/\/\$\{PuddleBucket\}\/analytics-table-root\//);
  assert.doesNotMatch(table, /Location:.*\/exports\//);
  const smoke = readFileSync(join(root, "scripts/cloud-smoke.mjs"), "utf8");
  assert.ok(smoke.includes('Location.endsWith("/data/")'));
  assert.ok(smoke.includes('Scheduled export worker reported failure: ${typeof error === "string" ? error.slice(0, 500)'));
});
