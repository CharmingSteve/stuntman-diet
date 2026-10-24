import assert from "node:assert/strict";

assert.ok(process.env.GH_TOKEN && process.env.GH_REPOSITORY, "GitHub token and repository are required");
assert.match(process.env.GH_REPOSITORY, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
async function get(path) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GH_REPOSITORY}/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28" }
  });
  assert.ok(response.ok, `Cannot verify production protection (${response.status}); refusing deployment`);
  return response.json();
}
const environment = await get("environments/production");
assert.ok(environment.protection_rules.some(rule => rule.type === "required_reviewers" && rule.reviewers?.length),
  "Production environment must have required reviewers configured");
assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true,
  "Production must restrict deployment to an explicit main branch policy");
const branches = await get("environments/production/deployment-branch-policies");
assert.ok(branches.branch_policies.length > 0 && branches.branch_policies.every(policy =>
  policy.name === "main" && policy.type === "branch"), "Production deployment policies must allow only main");
assert.equal((await get("branches/main")).protected, true, "main branch protection must be enabled");
console.info("Production reviewer, main-only deployment, and branch protection gates verified.");
