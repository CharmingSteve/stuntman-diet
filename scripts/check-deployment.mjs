import { execFileSync } from "node:child_process";

function resourceSchema(typeName) {
  const result = execFileSync("aws", [
    "cloudformation", "describe-type",
    "--type", "RESOURCE",
    "--type-name", typeName,
    "--query", "Schema",
    "--output", "text"
  ], { encoding: "utf8", env: { ...process.env, AWS_PAGER: "" } });
  return JSON.parse(result);
}

const endpoint = resourceSchema("AWS::Lambda::WebFunctionEndpoint");
const revision = resourceSchema("AWS::Lambda::WebFunctionRevision");
const minimum = endpoint.definitions?.ScalingConfig?.properties?.MaxEnvironments?.minimum;
const serviceConfig = revision.definitions?.ServiceConfig?.properties;
const blockers = [];
if (typeof minimum !== "number" || minimum > 1) {
  blockers.push(`CloudFormation cannot enforce MaxEnvironments=1 (schema minimum: ${minimum ?? "unknown"}).`);
}
if (!serviceConfig?.FileSystemConfigs) {
  blockers.push("The Web Function revision schema has no FileSystemConfigs for the required EFS mount.");
}
if (blockers.length) {
  console.error("Deployment blocked: the required persistent, single-writer SQLite architecture is unsupported.");
  for (const blocker of blockers) console.error(`- ${blocker}`);
  process.exitCode = 1;
} else {
  console.info("CloudFormation supports the required single-writer EFS architecture. Review template wiring before deployment.");
}
