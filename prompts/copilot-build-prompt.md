# stuntman-diet — Copilot build prompt (v1)

Read `docs/AWS-WEB-FUNCTIONS.md` and `docs/stuntman-diet-system-prompt.md`
in this repo BEFORE writing any code. They are the source of truth for
deployment and LLM behavior. Do not contradict them; if you must deviate,
stop and ask in the PR description.

## Task
Build the complete app: a Node.js (TypeScript) Hono HTTP server that is a
plain web app locally and deploys as an AWS Lambda Web Function (.zip,
no handler export, no adapters, listens on process.env.PORT).

## Repo layout to create
- src/server.ts — Hono app: serves static PWA (public/), /health route,
  JWT auth middleware, API routes
- src/auth.ts — Cognito JWT verification (JWKS from env COGNITO_USER_POOL),
  Bearer token, 401 on fail
- src/db.ts — SQLite (better-sqlite3), WAL, synchronous=NORMAL. Path from
  env DB_PATH (local ./data/diet.db, prod /mnt/data/diet.db). Single
  connection, serialized writes. Schema per docs (foods, food_aliases,
  log_entries with status/superseded_by, days with tz + burn, health_metrics,
  turns, user profile incl. timezone default Asia/Jerusalem)
- src/time.ts — timestamp engine: client_time (ISO 8601 with offset) from
  every request, server-UTC fallback, day boundary = midnight in profile
  tz, entries keep original offset, day rows store active tz. NO time logic
  anywhere else, never in the LLM path
- src/resolver.ts — cascade: user number verbatim -> exact/alias/fuzzy DB
  match -> recent-log ("same as yesterday") -> Bedrock estimate -> ask user.
  Record match_stage + calories_source per entry
- src/llm.ts — Bedrock client (model id from env, default
  amazon.nova-lite-v1). Sends FOOD_DB + the system prompt from
  docs/stuntman-diet-system-prompt.md (loaded from file, EDITABLE — do not
  hardcode). Strict JSON output, validate with zod, retry once on invalid
- src/renderer.ts — deterministic table renderer: 2 columns (Food left,
  Calories right), bold summary block below (Total Intake / Calories Burned /
  Net Calories), timestamp header per display rules in the system prompt doc
- src/trends.ts — SQL aggregates (weekly net, monthly deficit, top foods,
  glucose trend); LLM narrates pre-computed numbers only
- src/backup.ts — VACUUM INTO snapshot + S3 upload (invoked by separate
  scheduled Lambda; also a manual /admin/backup route)
- seeds/foods.json — the common foods list, seeded from
  seeds/diet-prompt-source.md (kept in repo, editable; re-seed script is
  idempotent, never overwrites user corrections/preferred_value)
- public/ — PWA: login (Cognito), daily log view (text + image upload),
  3-week history (expandable days), trend dashboard, timezone setting
- tests/ — vitest + supertest: resolver stages, portion parsing ("2/3 of",
  "1550 + 1200"), supersede/void, day boundaries incl. midnight-snack and
  travel-tz cases, renderer golden files, auth 401s
- .github/workflows/ci.yml — tests -> build zip -> deploy staging Web
  Function (maxEnvironments: 1, ApplicationManaged auth) -> smoke:
  /health 200, protected route 401, one Bedrock parse with test JWT
- infra/template.yaml — CloudFormation: Web Function, EFS + access point,
  role (bedrock:InvokeModel on the two model ARNs only, EFS access point
  only, s3:PutObject on backup prefix only), EventBridge nightly backup,
  versioned S3 bucket

## Editability requirements (important)
- The system prompt lives in docs/ as a FILE, loaded at runtime (env
  SYSTEM_PROMPT_PATH). Editing the file changes LLM behavior, no rebuild.
- The foods list lives in seeds/foods.json; the app reads the DB (seeded
  from it). A user correction to a food writes preferred_value in the DB —
  seeds never clobber it.
- All config via .env: PORT, DB_PATH, COGNITO_USER_POOL, BEDROCK_MODEL,
  S3_BACKUP_BUCKET, SYSTEM_PROMPT_PATH.

## Rules
- All changes to main via PR (branch protection). Standard flow: branch ->
  commit -> push -> open PR linked to the issue.
- No Lambda-specific code anywhere. No API Gateway. No DynamoDB.
- Images: upload to S3, store references only.
- Don't be chatty: the app's responses are the rendered table + summary;
  conversational text only on question/clarification/anomaly, per the
  system prompt doc.
