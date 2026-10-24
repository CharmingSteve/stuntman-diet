import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const environment = process.argv[2];
assert.ok(["staging", "production"].includes(environment), "Choose staging or production");
assert.equal(process.env.AWS_REGION, "us-east-1", "Deployment region must be us-east-1");
assert.match(process.env.BUILD_REVISION ?? "", /^[a-f0-9]{40}$/, "BUILD_REVISION must be a full commit SHA");
const stack = `stuntman-diet-${environment}`;
const auth = `${stack}-auth`;
function aws(...args) {
  return execFileSync("aws", args, { encoding: "utf8", env: { ...process.env, AWS_PAGER: "" } });
}
function outputs(name) {
  return Object.fromEntries(JSON.parse(aws("cloudformation", "describe-stacks", "--stack-name", name,
    "--output", "json")).Stacks[0].Outputs.map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]));
}
function deploy(template, name, parameters = [], iam = false) {
  aws("cloudformation", "deploy", "--template-file", template, "--stack-name", name,
    "--no-fail-on-empty-changeset", ...(iam ? ["--capabilities", "CAPABILITY_IAM"] : []),
    ...(parameters.length ? ["--parameter-overrides", ...parameters] : []));
  console.info(`CloudFormation complete: ${name}`);
}
execFileSync(process.execPath, ["scripts/check-deployment.mjs", "preflight"], { stdio: "inherit" });
const stacks = JSON.parse(aws("cloudformation", "list-stacks", "--stack-status-filter",
  "CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "--output", "json")).StackSummaries;
const callback = stacks.some(({ StackName }) => StackName === stack) ? `${outputs(stack).WebFunctionUrl}/` : "http://localhost:3000/";
deploy("infra/auth.yaml", auth, [`CallbackUrl=${callback}`]);
deploy("infra/artifacts.yaml", "stuntman-diet-artifacts");
const authentication = outputs(auth);
const artifacts = outputs("stuntman-diet-artifacts");
const key = `releases/${process.env.BUILD_REVISION}.zip`;
aws("s3", "cp", "dist/stuntman-diet.zip", `s3://${artifacts.ArtifactBucketName}/${key}`, "--sse", "AES256", "--only-show-errors");
const promptKey = `releases/${process.env.BUILD_REVISION}/system-prompt.md`;
aws("s3", "cp", "docs/stuntman-diet-system-prompt.md",
  `s3://${artifacts.ArtifactBucketName}/${promptKey}`, "--sse", "AES256", "--only-show-errors");
deploy("infra/template.yaml", stack, [
  `CodeBucket=${artifacts.ArtifactBucketName}`, `CodeKey=${key}`,
  `SystemPromptKey=${promptKey}`,
  `AccessLogsBucket=${artifacts.AccessLogsBucketName}`, `Environment=${environment}`,
  ...["CognitoUserPool", "CognitoDomain", "CognitoClientId", "SmokeClientId"].map(k => `${k}=${authentication[k]}`)
], true);
deploy("infra/auth.yaml", auth, [`CallbackUrl=${outputs(stack).WebFunctionUrl}/`]);
execFileSync(process.execPath, ["scripts/check-deployment.mjs", "post", stack], { stdio: "inherit" });
console.info(`Endpoint: ${outputs(stack).WebFunctionUrl}`);
