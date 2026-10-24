# stuntman-diet — AWS Lambda Web Functions brief (READ FIRST)

This app deploys on **AWS Lambda Web Functions** (new Oct 2026). Copilot/AI agents:
this is NOT a classic Lambda handler. Read this file before touching deployment,
server, or CI code.

Docs: https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html
Auth: https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html
Testing: https://docs.aws.amazon.com/lambda/latest/dg/web-functions-testing.html

## What it is
- The app is a **plain Node.js HTTP server** (Hono). It listens on a port
  (default: `process.env.PORT`). No Lambda handler export, no API Gateway
  adapter, no serverless-http wrapper. NEVER add those.
- Runs locally like any Node web app (`node server.js` / `npm run dev`).
- Deployed as a **.zip** package. Lambda creates the HTTPS endpoint and scales
  to zero. No API Gateway, no ALB.

## Auth (endpoint)
- Endpoint `AuthType`: **`ApplicationManaged`** — Lambda does NO auth itself.
- Authentication is **Cognito JWT middleware inside the Hono app**:
  verify Bearer token (ID/access token) against the Cognito User Pool
  (JWKS). Unauthenticated -> 401. Do NOT use `IamAuth` (browser PWA cannot
  SigV4-sign easily).
- No Cognito Identity Pool, no `cognito-idp:Admin*` calls anywhere.

## Runtime wiring
- **SQLite on EFS**: DB file lives on an EFS access point mounted at
  `/mnt/data`. WAL mode, `synchronous=NORMAL`. Local dev: plain file in
  `./data/`.
- **Bedrock**: role allows `bedrock:InvokeModel` on ONLY
  `arn:aws:bedrock:*:::foundation-model/amazon.nova-lite-v1*` and
  `anthropic.claude-haiku*`. No wildcards. Model id comes from config/env.
- **S3 backup**: role allows `s3:PutObject` on ONLY
  `arn:aws:s3:::stuntman-diet-backups/*`. Nightly `VACUUM INTO` snapshot upload.
- **EFS**: role allows mount/write on ONLY the specific access point ARN.

## Testing (per AWS docs)
- Unit + HTTP integration tests run **locally with normal Node tools**
  (vitest/jest + supertest against Hono). No LocalStack, no Lambda runtime mock.
- Cloud smoke tests in CI (staging Web Function):
  1. `curl /health` -> 200
  2. `curl` protected route without token -> 401
  3. one Bedrock-backed parse with a test JWT -> 200
- Never mock the Web Function runtime; there is nothing Lambda-specific to mock.

## CI rules
- All changes to main via PR (branch protection). Standard flow:
  branch -> commit -> push -> open PR linked to the issue.
- CI: run tests -> build zip -> deploy staging -> smoke test -> (manual) prod.


## SQLite on EFS — architecture (decided)
- The .db file lives on **EFS** (`/mnt/data/diet.db`), NOT inside the Lambda.
  EFS persists independently of execution environments; cold starts re-mount
  the same file. Local dev uses `./data/diet.db` — identical code paths.
- Writes are ordinary SQL from the Hono app (INSERT on each log; corrections
  supersede, never UPDATE/DELETE history).
- **Single-writer rule**: serialize DB access in-app (one connection/queue).
  Set endpoint `maxEnvironments: 1` — single user, ~50 writes/day, no
  concurrency need. Do NOT allow multiple environments writing concurrently.
- **Images: store references only** (S3 keys), never image bytes in the DB.
- Size is a non-issue: 4 months of raw chat = 276 KB; structured, a decade of
  logging is a few MB. No DynamoDB — trends need SQL (SUM/GROUP BY/date
  ranges), and one-file backup beats batch-write plumbing.

## S3 backup schedule
- EventBridge cron nightly 03:00 Asia/Jerusalem -> tiny separate Lambda
  (not the web function).
- It runs `VACUUM INTO` snapshot of the EFS db -> uploads to
  `s3://stuntman-diet-backups/YYYY/MM/DD.db`.
- Bucket has **versioning on** (point-in-time restore for free).
- Backup Lambda role: EFS read + `s3:PutObject` on the backup prefix ONLY.

## Web UI requirements
- History view: at least 3 weeks of daily logs (expandable day rows with
  table + tally) — one SQL query, no pagination needed at this size.
- Trend analysis, two paths:
  1. Deterministic dashboards: SQL aggregates on request (weekly net,
     monthly deficit, top foods, glucose trend). No LLM.
  2. LLM trend questions: Lambda computes SQL aggregates FIRST, then passes
     the numbers (never the raw DB) to Bedrock to narrate. LLM interprets
     pre-computed facts only.


## Custom domain (FQDN) — decided

- Use the Default raw URL `https://<id>.lambda-url.<region>.on.aws` remains as prod FQDN URL.


## Time & day boundaries (decided — LLM never touches time)
- Every request carries `client_time` (ISO 8601 with offset, from the device
  clock — always NTP-correct). Server fallback: Lambda UTC clock converted
  to profile timezone.
- `user.timezone` in DB, default `Asia/Jerusalem`, changeable in the app UI
  (travel). Day boundary = midnight in the profile zone, computed in app code.
- Entries stored with original UTC offset; each day row stores the tz active
  at log time — history never rewrites when timezone changes.
- The LLM system prompt FORBIDS it from emitting timestamps/dates; any
  timestamp in LLM output = bug.
