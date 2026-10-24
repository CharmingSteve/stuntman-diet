# AWS Web Functions: DynamoDB + S3 data puddle

The production architecture supersedes the old SQLite/EFS deployment blocker.
Use native CloudFormation `AWS::Lambda::WebFunction`,
`AWS::Lambda::WebFunctionRevision`, and `AWS::Lambda::WebFunctionEndpoint`.
The HTTP app remains a plain Hono Node.js server: no API Gateway, Lambda HTTP
adapter, custom deployment resource, EFS mount, or single-writer assumption.
Local SQLite is a development/import backend only.

References:
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html
- https://docs.aws.amazon.com/lambda/latest/dg/web-functions-testing.html

## Account, runtime, and authentication

- Account **570989156105**, region **us-east-1**, local AWS profile **click**.
- Node.js **24**, ZIP deployment. `index.js` starts `dist/server.js`.
- `ApplicationManaged` endpoint authentication: Cognito JWT validation in Hono;
  protected routes reject missing tokens with 401. No Cognito admin permission
  is granted to the application.
- Each environment has a separate auth stack, browser client, and isolated
  `client_credentials` smoke client (`diet-smoke/parse`). Machine credentials
  are obtained at test time and never embedded in the bundle or logged.
- Public self-registration is disabled (`AdminCreateUserConfig:
  AllowAdminCreateUserOnly: true`). An authenticated deployment administrator
  must invite the actual owner through Cognito using the owner's explicitly
  supplied email/username; no owner identity or password is fabricated by
  deployment. The owner completes Cognito's invitation/password-change flow.
  Do not enable public signup to bootstrap access. Browser authentication is
  authorization-code flow; deploy operators, not the application role, perform
  any administrative user invitation. Application IAM has no Cognito `Admin*`
  permissions.
- The raw Web Function HTTPS endpoint is the application URL. After initial
  deployment the auth stack callback/logout URL is updated to that endpoint.
- The live registry was checked with the deployment profile: endpoint
  `ScalingConfig.MaxEnvironments` currently has minimum **2**. DynamoDB allows
  two concurrent environments safely; this is not an EFS workaround.

## CloudFormation resources and boundaries

`infra/artifacts.yaml` creates private, encrypted, versioned release storage
and an access-log bucket. The release read policy is constrained to native
Web Function revisions in the staging and production stacks.
`infra/auth.yaml` creates environment-isolated Cognito resources.
The system prompt is uploaded under immutable
`releases/<full-commit-SHA>/system-prompt.md`; each revision's environment
and IAM object-read grant select that exact key. Staging cannot change a
running production revision's prompt by overwriting a shared prompt path.
`infra/template.yaml` creates:

- An on-demand DynamoDB table (`PK`, `SK` string keys) with KMS customer-managed
  encryption, PITR, deletion protection, and retention on stack deletion.
- A private, encrypted, versioned, retained puddle bucket. Only prefixes have
  lifecycle expiration: `exports/` current objects 90 days, noncurrent 30;
  `results/` current/noncurrent objects 7 days; `images/` current objects are
  retained, noncurrent versions expire after 90 days. Keep/export required
  snapshots before their retention period ends.
- A Glue external JSON table and an enforced Athena workgroup with SSE-S3
  results, metrics, and a 100 MiB per-query scan cutoff.
- A native Web Function app role: table CRUD/queries, configured Bedrock model,
  images, read-only exports, Athena workgroup queries/results and Glue reads.
  It cannot invoke the worker, initiate native DynamoDB exports, or create
  Glue partitions. Table export requests are durable table jobs.
- A **separate conventional Lambda worker** using
  `dist/export-handler.handler`, 120-second timeout, reserved concurrency 1.
  Its role has table job CRUD/queries, PITR description, native full export,
  export status, export objects/manifests, and Glue partition registration.
  It has no Bedrock or Athena query permissions.
- EventBridge Scheduler every minute with input `{}` processes pending and
  running jobs. A second schedule runs at **03:00 Asia/Jerusalem** with
  `{"nightly":true}` to initiate nightly exports. Scheduler's role can invoke
  only that worker. Lambda async failures go to an encrypted 14-day SQS DLQ.
- Separate 30-day KMS-encrypted app centralized, app `.local`, and worker log
  groups. Native Web Functions always write to the `.local` companion first;
  inspect it for immediate regional errors, not only the asynchronously
  centralized group. Both are created before the revision receives traffic,
  and execution-role stream access is scoped to exactly those two groups.
  The worker needs
  only regional AWS APIs, not a VPC/NAT; this is a documented Checkov exception.
  The access-log destination's recursive-logging exception is also documented.
  KMS key policy `Resource: "*"` denotes **the attached key only**, with the
  Logs principal constrained to the exact three encryption-context log ARNs;
  application IAM policies never grant account-wide resources/actions.

Environment settings for the app:

```text
STORE=dynamo
TABLE_NAME=<stack table>
PUDDLE_BUCKET=<stack puddle bucket>
TRENDS=athena
ATHENA_WORKGROUP=<stack workgroup>
ATHENA_RESULTS_BUCKET=<same puddle bucket; results/ prefix>
GLUE_DATABASE=<stack database>
GLUE_TABLE=diet_items
```

Worker settings include `TABLE_NAME`, `TABLE_ARN`, `PUDDLE_BUCKET`,
`GLUE_DATABASE`, and `GLUE_TABLE`. PITR export time is chosen from
`LatestRestorableDateTime`, not live wall-clock time: the UI must display
snapshot age rather than promise real-time analytics.

### Nightly full-export cost

The AWS Price List API for `USE1-ExportDataSize-Bytes` currently quotes
**$0.10 per GB exported** in us-east-1. AWS's current
[export documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/S3DataExport.HowItWorks.html)
states full exports are billed on table data plus local secondary indexes at
the selected time; it documents a **10 MB incremental-export minimum**, not a
10 GB full-export minimum. Do not assert an unsupported 10 GB minimum or
promise a fixed pennies-per-month bill. Thirty nightly full exports of a
10 GB table cost approximately **$30/month for exports alone**; use actual
table/export billed bytes and current pricing for this personal table.
PITR, KMS keys, S3 requests/storage/versioning, logs, Athena, Lambda, Bedrock,
and Cognito are additional charges. The authorized nightly FULL-export
schedule remains unchanged; user-requested refreshes add full-export cost.

## Export and Glue contract

Native DynamoDB full exports preserve marshalled JSON:

```json
{"Item":{"PK":{"S":"USER#synthetic"},"SK":{"S":"DAY#2026-01-05#META"},"entity":{"S":"day"},"version":{"N":"1"},"data":{"M":{"day_key":{"S":"2026-01-05"},"burn_total":{"N":"2000"}}}}}
```

The external table has one column `item` and partition `snapshot string`.
OpenX JSON SerDe has `case.insensitive=true`: `Item/PK/SK/S/M/N/BOOL/L` are
read through lowercase SQL paths. Examples:
`item.pk.s`, `item.entity.s`, `item.data.m.day_key.s`,
`CAST(item.data.m.calories.n AS double)`.

`item` is a struct of `pk:struct<s:string>`, `sk:struct<s:string>`,
`entity:struct<s:string>`, `version:struct<n:string>`, and
`data:struct<m:struct<...>>`. The data struct includes string wrappers for
`user_id`, `day`, `day_key`, `status`, `display_name`, `burn_source`,
`completeness`, `eligibility`, `metric`, `timezone`; numeric-string wrappers
for `calories`, `burn_total`, `value`; `accept_default_burn:struct<bool:boolean>`,
`holidays:struct<l:array<struct<s:string>>>`, and
`non_tracking_weekdays:struct<l:array<struct<n:string>>>`.
Snapshot profile policy supplies calendar coverage for absent dates.

Every partition must point **only** to the validated native export's `data/`
directory, never to its ancestor containing manifests or to a puddle root.
The worker validates manifests before registering the partition and atomically
publishing the `SYSTEM#EXPORT / LATEST` pointer. Every analytics query selects
exactly one published snapshot; do not union snapshots or sum multiple exports.
Global jobs are `SYSTEM#EXPORT / JOB#<id>` with entity `export_job` and data
`{job_id,status,requested_at,export_arn?,snapshot_id?,snapshot_at?,error?}`.
The latest row has entity `snapshot` and
`{snapshot_id,snapshot_at,location}`. User-visible job rows reference global
jobs without giving the HTTP application export/invocation permissions.

## Build, deploy, and checks

Build on **Linux x64 with Node.js 24** while `better-sqlite3` remains a local
backend dependency. `npm ci` in the packaging directory rebuilds the native
production dependency for that platform; do not upload a macOS `node_modules`.
Packaging uses a project-local staging directory, excludes previous ZIPs,
and cleans up on success or failure.

```bash
set -euo pipefail
npm ci
npm test
npm run build
npm run package
```

The following commands create/update infrastructure; run only when deployment
is intended, from the repository root with a verified Linux-built ZIP:

```bash
set -euo pipefail
export AWS_PROFILE=click AWS_REGION=us-east-1 AWS_PAGER=""
export BUILD_REVISION="$(git rev-parse HEAD)"
node scripts/check-deployment.mjs preflight
node scripts/deploy.mjs staging
node scripts/cloud-smoke.mjs stuntman-diet-staging --fixture
# Only after reviewing staging and obtaining production approval:
node scripts/deploy.mjs production
node scripts/cloud-smoke.mjs stuntman-diet-production
```

Preflight is **read-only**, checks account and live registry support, and no
longer rejects the removed EFS/single-writer design. Post-deploy checks are
separate:

```bash
node scripts/check-deployment.mjs post stuntman-diet-staging
actionlint .github/workflows/ci.yml
zizmor .github/workflows/ --no-progress
cfn-lint infra/template.yaml infra/auth.yaml infra/artifacts.yaml
checkov -d infra --framework cloudformation --compact --quiet
```

Post-deploy checks verify stack outputs, PITR, table deletion protection,
private encrypted versioned object storage, enforced Athena results, and worker
handler/table wiring. Cloud smoke checks preserve exactly these HTTP cases:
1. `GET /health` -> 200.
2. Protected route with no token -> 401.
3. One Bedrock-backed parse with a real Cognito machine JWT -> 200, parsed
   food item 200 calories.

Staging additionally seeds only uniquely isolated **synthetic** DynamoDB rows
using the AWS CLI: two active entries (100 + 200 calories) and a tracked,
complete day with burn 2000. It waits until PITR includes those writes, creates
two sequential durable export jobs, lets the scheduled worker process them,
checks data-only Glue partitions, and independently queries each selected
snapshot for intake **300**, burn **2000**, net **-1700**, exactly two entries.
It deletes the live fixture rows in `finally`; synthetic historical export
rows remain until export lifecycle expiry. It never prints table records or
uses personal data. Production never runs the fixture path.
The smoke also imports the deployed application's `analyticsSQL` from
`dist/analytics.js` (override with `ANALYTICS_MODULE` when unpacking the ZIP).
It verifies weekly/monthly totals and calendar coverage over three tracked
dates: one complete fixture day and two absent/missing days, with no invented
burn on missing days. CI unpacks the tested ZIP so this uses the same compiled
application and Linux dependencies, not a smoke-only reimplementation.

## CI/CD and production approvals

PRs run tests, TypeScript build, and Linux ZIP packaging. A digest-pinned
DynamoDB Local 3.1.0 service is bound only to loopback port 8000; readiness is
checked before `npm test`, with `DYNAMODB_ENDPOINT` explicitly configured so
both SQLite and DynamoDB store contract suites execute. CI fails closed if
the endpoint is absent. Main pushes deploy
staging and run all cloud smokes. Existing repository secrets
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` configure the account-restricted
deployment identity; no OIDC migration or new long-lived secrets are required.

Production is eligible after a **main push**, or a main `workflow_dispatch`
with `production=true`, after that same run passes staging. Every promotion
still waits for manual approval of the protected `production` environment;
PRs can never deploy. It uses the same uploaded ZIP. Configure
the repository's `production` environment with required reviewers and an
explicit deployment-branch policy allowing only branch `main`; protect main
with required PR/status checks. `scripts/verify-production-gate.mjs` fails
closed if reviewer/main-only/branch-protection settings cannot be verified
through the GitHub API. These repository settings cannot be provisioned by
CloudFormation and must be configured before production promotion.
The production job grants its GitHub token only `contents: read` and
`actions: read`, including read access required for environment-protection
verification; it cannot edit approval or branch-protection settings.

Cloud smoke execution and full package verification require deployed
resources/Linux respectively; passing read-only preflight or template lint
is not proof that a deployment has occurred.

## Restore drill: new CloudFormation-managed table

`infra/restore.yaml` imports **one selected native full export** into a new
table using native `ImportSourceSpecification`, never an imperative DynamoDB
import or a mutation of the live table. Obtain `location` from a completed
`SYSTEM#EXPORT / JOB#...` partition or the validated latest pointer; split
its `s3://bucket/prefix/` into bucket and exact `data/` prefix. For example:

```bash
set -euo pipefail
aws cloudformation deploy --template-file infra/restore.yaml \
  --stack-name stuntman-diet-restore-check \
  --parameter-overrides \
    "TableName=stuntman-diet-restore-check" \
    "ExportBucket=${EXPORT_BUCKET}" \
    "ExportDataPrefix=${EXPORT_DATA_PREFIX}" \
  --no-fail-on-empty-changeset
```

The restoration uses GZIP DynamoDB JSON, on-demand billing, PK/SK string keys,
KMS encryption, PITR, deletion protection, and retention. Verify synthetic
fixture entries/day in the restored table using the same synthetic user PK
used in staging, and verify intake 300 / burn 2000 / net -1700 without editing
the production table. Stack deletion intentionally does not delete the
restored table or encryption key. Re-importing requires a **new table name**.

### Controlled cutover

The current application template **does not expose an existing-table or
table-name parameter**. Restoring the drill table does not switch the app.
Do not pass an invented deployment parameter or replace/delete the original
`DietTable`. Keep the original table retained and encrypted throughout.

For a real disaster-recovery cutover, freeze app writes, verify the restored
table's integrity and required owner records, and review a separate
CloudFormation change adding an explicit existing-table name/ARN selection.
That reviewed change must consistently select the restored table for both
Web Function and worker environment variables, all table/export IAM ARNs,
and outputs, while preserving the original table resource and its retention
policies. Review the change set before execution, deploy, invalidate/rebuild
the latest snapshot pointer, run the complete staging smoke sequence against
the selected table, and only then resume writes. Reverting the reviewed
selection must remain possible without deleting either table. This
operational cutover is deliberately separate from the restore drill.
