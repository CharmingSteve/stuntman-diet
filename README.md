# stuntman-diet

A private food and calorie journal. You type what you ate or burned in plain
language (or attach a food photo) and the app keeps a per-day ledger, renders a
table with totals and net calories, and reports weekly/monthly trends.

The LLM (Amazon Bedrock, Nova Lite by default) only turns your message into
structured JSON. The app does everything else: catalog lookup, calorie math,
timestamps, day rules, idempotency, storage, and rendering.

AWS account profile Click, region `us-east-1`. Every local AWS command
in this repo uses `--profile click --region us-east-1`.

## Contents

- [stuntman-diet](#stuntman-diet)
  - [Contents](#contents)
  - [1. How a log entry is created](#1-how-a-log-entry-is-created)
  - [2. Local development](#2-local-development)
    - [Self-hosted SQLite (Orange Pi or any single machine)](#self-hosted-sqlite-orange-pi-or-any-single-machine)
  - [3. Preset calories: where they live and how to change them](#3-preset-calories-where-they-live-and-how-to-change-them)
    - [3.1 Where the presets are stored](#31-where-the-presets-are-stored)
    - [3.2 Anatomy of a food](#32-anatomy-of-a-food)
    - [3.3 How a typed item becomes calories](#33-how-a-typed-item-becomes-calories)
    - [3.4 Change a preset for everyone](#34-change-a-preset-for-everyone)
    - [3.5 Override a preset just for yourself](#35-override-a-preset-just-for-yourself)
  - [4. Manually editing entries](#4-manually-editing-entries)
    - [4.1 Fix commands (preferred: exact, and they never call the model)](#41-fix-commands-preferred-exact-and-they-never-call-the-model)
    - [4.2 Day controls in History](#42-day-controls-in-history)
    - [4.3 Burn and health readings](#43-burn-and-health-readings)
    - [4.4 Import corrections](#44-import-corrections)
    - [4.5 Direct store edits (last resort: no audit trail)](#45-direct-store-edits-last-resort-no-audit-trail)
  - [5. Tracking rules and what the numbers mean](#5-tracking-rules-and-what-the-numbers-mean)
  - [6. Historical import](#6-historical-import)
  - [7. Trends and analytics snapshots](#7-trends-and-analytics-snapshots)
  - [8. Known problems (verified)](#8-known-problems-verified)
  - [9. AWS architecture](#9-aws-architecture)
  - [10. Deployment and environments](#10-deployment-and-environments)
    - [Pipeline (`.github/workflows/ci.yml`)](#pipeline-githubworkflowsciyml)
    - [Manual deploy (only when intended)](#manual-deploy-only-when-intended)
    - [Environments](#environments)
  - [11. Backups and recovery](#11-backups-and-recovery)
  - [12. Data model](#12-data-model)
  - [13. HTTP API](#13-http-api)
  - [14. Configuration](#14-configuration)
  - [15. Repository map](#15-repository-map)
  - [16. Tests](#16-tests)

---

## 1. How a log entry is created

1. The PWA in `public/` signs in through Cognito (authorization code + PKCE)
   and sends the access token as `Authorization: Bearer <token>`.
2. The log box calls `POST /api/chat` with an `Idempotency-Key`, the text, and
   `client_time` (the browser clock as ISO 8601 with an offset). An image is
   allowed as multipart `image` (JPEG, PNG, or WebP, at most 5 MB).
3. `src/chat.ts` runs these steps:
   - **Stamp time.** `src/time.ts` turns `client_time` into a day key in the
     profile timezone (default `Asia/Jerusalem`). The entry keeps the original
     timestamp and offset.
   - **Parse.** `src/llm.ts` sends the text, the profile timezone, and the whole
     catalog (`FOOD_DB`) to Bedrock with the system prompt. The model must answer
     through the forced tool `record_food_intent`. The reply is validated with
     zod, and a malformed reply gets one retry.
   - **Burn override.** `src/parsing.ts` reads `1550 + 1200` or
     `burned so far 3250` directly and overrides the model's burn.
   - **Resolve.** `src/resolver.ts` matches each item against the catalog and
     computes calories (section 3). The model's own calorie guess is used only
     when nothing in the catalog matches.
   - **Corrections.** A correction marks the old entry `superseded` or `void`.
     It never deletes it.
   - **Write.** New entries are appended. The day record gets
     `completeness = partial`. The writes and an idempotency receipt
     (`REQUEST#<key>`) commit together.
   - **Render.** `src/renderer.ts` builds the Markdown table with Total Intake,
     Calories Burned, and Net Calories.
4. Retries are safe. The same key with the same payload returns the stored
   result. The same key with a different payload returns 409.
5. Food on a non-tracking day is refused with "Not tracking on this date"
   until you explicitly set that day to tracked (section 5).

## 2. Local development

```sh
npm ci
cp .env.example .env
npm run seed     # creates ./data/diet.db and loads seeds/foods.json
npm run dev      # http://localhost:3000 (tsx watch)
```

- **Cognito is required for API routes.** If `COGNITO_USER_POOL` or
  `COGNITO_CLIENT_ID` is blank, every `/api/*` route returns 503
  `Authentication is not configured`. Fill them from the outputs of the
  matching auth stack (`stuntman-diet-staging-auth` or
  `stuntman-diet-production-auth`):
  `aws cloudformation describe-stacks --profile click --region us-east-1 --stack-name stuntman-diet-staging-auth`.
- **Bedrock** is called with your AWS credentials. Run with
  `AWS_PROFILE=click` and make sure the principal may call
  `bedrock:InvokeModel` for `amazon.nova-lite-v1:0`.
- `.env.example` defaults to `STORE=sqlite` and `TRENDS=sqlite`. Locally,
  reports are live and no snapshot is needed.
- The system prompt file is read on every parse, so local prompt edits apply
  without a restart. The catalog is read at process start, so restart after
  editing `seeds/foods.json`.
- `npm test` runs the Vitest suites and the deployment-script tests.
  `npm run build` compiles `src/` to `dist/`. `npm start` runs `dist/server.js`.
- Set `DYNAMODB_ENDPOINT=http://127.0.0.1:8000` (DynamoDB Local) to run the
  DynamoDB half of the store contract tests. Without it, only SQLite runs.

### Self-hosted SQLite (Orange Pi or any single machine)

Set `STORE=sqlite`, `DB_PATH` to a persistent file, the Cognito values, and
`npm run build && npm start`. This repo has no Orange Pi-specific service file
or install script. The only trace is a note in `prompts/copilot-pivot-prompt-v2.md`
about "possible Orange Pi self-hosting". The AWS deployment always uses DynamoDB.
SQLite is for local development, the tests, and any self-hosted setup you build yourself.

## 3. Preset calories: where they live and how to change them

### 3.1 Where the presets are stored

| Copy | Location | Read by | How it changes |
| --- | --- | --- | --- |
| **Source catalog** | `seeds/foods.json` (61 foods) | Read at startup from `FOODS_PATH` (default `./seeds/foods.json`). Packaged into the AWS ZIP. | You edit the file, then restart locally or deploy. |
| **Runtime catalog** | `CATALOG / FOOD#<id>` items. Local: `store_items` table in `data/diet.db`. AWS: the DietTable. | Every chat parse and resolution. | Seeding on the first API call of each process upserts changed foods. Unchanged foods are skipped by digest. |
| **Aliases** | The `aliases` array of each `CATALOG` food. `ALIAS#<normalized>` items are also written but not read at runtime. | The resolver. | Same as above. |
| **Per-user override** | `USER#<sub> / FOOD_PREF#<id>` | The resolver, after the catalog. | `PUT /api/foods/:id/preferred-value` (no UI). |
| **Legacy SQLite tables** | `foods`, `food_aliases` in `data/diet.db` | Only `npm run seed` and the one-time migration. Not used at runtime. | Not meaningful to edit. |

Entries never recalculate. Each entry stores the calories computed when it was
logged, so editing a preset does not change past days.

### 3.2 Anatomy of a food

```json
{
  "id": "example_yogurt",
  "name": "Example yogurt (150g)",
  "aliases": ["example yogurt"],
  "category": "yogurt",
  "basis": { "type": "fixed_portion", "portion_grams": 150, "calories": 110 },
  "source": "prompt_seed"
}
```

- `id` is the key for per-user overrides and must stay stable.
- `aliases` are extra names that match this food. They are compared to the
  typed text as whole strings or as substrings (see section 8).
- `basis` decides the math. **The resolver branches on which fields exist.**
  `type` is documentation only.

| Basis fields | Meaning | Examples |
| --- | --- | --- |
| `calories` (+ optional `portion_grams`) | A fixed serving. Grams scale from `portion_grams` if it is set. Without it, grams and ml resolve to nothing. | `gil_yogurt`, `gil_yogurt_small`, `banana` |
| `calories_per_100g` (+ optional `portions: [{grams, calories}]`) | Mass-based. A "portion" uses `portions[0]`. | `cottage_9`, `tilapia_baked` |
| `calories_per_100ml` (+ `portions: [{ml, calories}]`) | Volume-based. | `obolon_beer` |
| `calories_per_gram` | Per gram. | `chia_seeds` |
| `calories_per_unit` | Per counted item (egg, mug, shot, tsp). | `fried_egg_medium`, `vegetable_soup` |
| `secondary: [{unit, calories}]` | Spoon or unit amounts, such as `tbsp` or `tsp`. Checked first. | `pure_peanut_butter`, `tuna` |
| `preferred_value` | A catalog-level override that beats `basis` for everyone. | `cream_cheese_lowfat`, `cream_cheese_highfat` |

The catalog has 61 foods: 14 `fixed_portion`, 37 `per_100g`, 8 `per_unit`,
1 `per_gram`, and 1 `per_100ml`.

### 3.3 How a typed item becomes calories

`src/resolver.ts` applies these rules in order:

1. **A number the user typed wins.** "protein drink 200 calories" uses 200 as
   the line total, regardless of quantity (section 8).
2. **Exact name**, then **alias** (exact or substring of the typed text), then
   **fuzzy** match by edit distance (up to `max(2, 18% of length)`, with a
   unique best score).
3. **More than one alias matches.** The candidates are priced. If they are
   within 50 kcal of each other, the middle one is used (for an even count, the
   higher one). If they differ by more than 50 kcal, the item is `unresolved`
   and the user is asked.
4. **Pricing** (`selectedCalories`), first applicable rule wins:
   `secondary` unit → `calories_per_100g` (preferred, then basis) →
   `calories_per_100ml` → `calories_per_gram` → `calories` (preferred, then
   basis) → `calories_per_unit`. Otherwise the item is `unresolved`.
5. **No catalog match.** If the model supplied calories, the entry is an
   `estimate` with those calories. Otherwise it is `unresolved`.

`unresolved` items are **not recorded** (section 8).

### 3.4 Change a preset for everyone

1. Edit `seeds/foods.json`. Keep the JSON valid and the `id`s unique.
2. Run `npm test`. A malformed file fails the server at startup.
3. Locally, restart `npm run dev`. The catalog is upserted on the first API call.
4. In AWS, commit to a branch, open a PR, merge to `main`, and let staging pass.
   Production then needs manual approval (section 10). The file is baked into
   the ZIP (`FOODS_PATH=seeds/foods.json`), so nothing changes in AWS until a
   deploy.

Notes:

- Seeding only **upserts**. Deleting a food from the file does not delete its
  `CATALOG` item. To remove one, delete the store item (section 4.5).
- `seedCatalog` overwrites a food's seed-level `preferred_value` with the file's
  value. Per-user overrides are stored separately and survive.

### 3.5 Override a preset just for yourself

There is no UI. Call the API with your access token. In the browser, find
`stuntman.accessToken` in DevTools → Application → Session Storage. Tokens last
15 minutes.

```sh
curl -X PUT "https://<WebFunctionUrl>/api/foods/cottage_9/preferred-value" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: pref-cottage-9-20261028" \
  -d '{"calories_per_100g": 100}'
```

The body must contain exactly one key, and it must match the food's basis:

| Body key | Limit | Works for | Ignored for (verified or read in code) |
| --- | --- | --- | --- |
| `calories_per_100g` | ≤ 1000 | `per_100g` foods | Use it only on per-100g foods. Sending it to a fixed-portion food can make portion amounts unresolved (read in code, not run). |
| `calories` | ≤ 10000 | `fixed_portion` and `per_unit` foods | `per_100g`, `per_100ml`, and `per_gram` foods. The request still returns success. Verified: `cottage_9` with `calories: 300` still gives 320 kcal for 250 g. |

Overrides cannot be removed through the API. To remove one, delete the
`FOOD_PREF#<id>` item (section 4.5).

## 4. Manually editing entries

There is no entry editor in the UI. Use these, in order of preference.

### 4.1 Fix commands (preferred: exact, and they never call the model)

Type a `fix` command in the log box. Times are in your profile timezone. Add a
date to fix another day. The UI prints this list under "Fix a wrong entry":

```
fix 10:44 PM delete
fix 22:44 burn 1430 + 1550
fix 10:44 PM burn
fix 10:41 PM calories 150
fix 2026-10-27 22:44 delete
fix 11:41 AM crackers delete
```

- **delete** voids the entry (it stays in history as `void`).
- **burn** voids the entry and sets that day's burn. Without numbers it uses the
  entry's calories. With `1430 + 1550` it records those components.
- **calories N** supersedes the entry with a corrected one.
- If several entries share that minute, the reply lists them. Add a word from
  the name. If none match, the reply lists the day's entries.
- A malformed `fix` is refused with the syntax, and nothing is written.

The incident that led to this is in
[`docs/incidents/2026-10-27-burn-recorded-as-food.md`](./docs/incidents/2026-10-27-burn-recorded-as-food.md).

Natural-language corrections ("only ate 2/3 of the eggs", "didn't eat the
cheese") still go through the model. Its target must match exactly one entry
on the request's day, and a burn is never accepted as a replacement food.

### 4.2 Day controls in History

Expand a day in History. You can set **Tracking** (tracked or not tracking),
**Completeness** (missing, partial, or complete), and **accept the assumed 2000
kcal burn** (only for tracked, complete days with no recorded burn). "Save day"
calls `PUT /api/days/:day`. These controls change the day record, not the
entries.

### 4.3 Burn and health readings

- **Burn:** type `1550 + 1200` (components) or `burned so far 3250` (total).
  Sending a new burn replaces the old one. Burn is stored as `burn_source =
  recorded`. Clearing it needs a direct edit (section 4.5).
- **Health readings** (glucose, blood pressure, weight) are created only through
  `POST /api/health-metrics` with an `Idempotency-Key`. The chat cannot create
  them, and there is no edit or delete endpoint. Units and ranges:
  `glucose` mg/dL (20–600), `bp_systolic` mmHg (50–300), `bp_diastolic` mmHg
  (30–200), `weight` kg (20–500).

### 4.4 Import corrections

Canonical import records may include `kind: "correction"` with `target_id`
(the original source message ID) and `action` (`void` or `replace`). Use this
only for historical data. See section 6.

### 4.5 Direct store edits (last resort: no audit trail)

Store items look like `{PK, SK, entity, version, data}`. The app checks
`version` on writes, so bump it whenever you change `data`. Only `status:
active` entries count in History, trends, and reports.

Key patterns:

| Thing | PK | SK |
| --- | --- | --- |
| Entry | `USER#<sub>` | `DAY#<yyyy-mm-dd>#ENTRY#<entry-id>` |
| Day record | `USER#<sub>` | `DAY#<yyyy-mm-dd>#META` |
| Food override | `USER#<sub>` | `FOOD_PREF#<food-id>` |
| Catalog food | `CATALOG` | `FOOD#<food-id>` |

Use `<sub>` from the Cognito token's `sub` claim.

**Before any AWS edit,** take an on-demand backup:
`aws dynamodb create-backup --profile click --region us-east-1 --table-name <TableName> --backup-name pre-edit-<date>`.
Get `<TableName>` from the stack output:
`aws cloudformation describe-stacks --profile click --region us-east-1 --stack-name stuntman-diet-staging --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text`.

Void one entry in AWS (conditional, so it fails if the entry changed):

```sh
aws dynamodb update-item --profile click --region us-east-1 \
  --table-name <TableName> \
  --key '{"PK":{"S":"USER#<sub>"},"SK":{"S":"DAY#2026-10-27#ENTRY#<entry-id>"}}' \
  --condition-expression "#d.#s = :active" \
  --update-expression "SET #d.#s = :void, #v = #v + :one" \
  --expression-attribute-names '{"#d":"data","#s":"status","#v":"version"}' \
  --expression-attribute-values '{":active":{"S":"active"},":void":{"S":"void"},":one":{"N":"1"}}'
```

Local SQLite (stop the server first). **Edit `store_items`, not `log_entries`.**
The running app ignores `log_entries` after the one-time migration:

```sh
sqlite3 data/diet.db "UPDATE store_items SET data = json_set(data, '$.status', 'void'), version = version + 1 WHERE PK = 'USER#<sub>' AND SK = 'DAY#2026-10-27#ENTRY#<entry-id>';"
```

Rules of thumb:

- Prefer superseding over editing calories in place, so the history stays
  intact. Set the old entry to `superseded` with `superseded_by`, and add a
  new entry.
- Use `PUT /api/days/:day` for day changes rather than editing `DAY#...#META`.
- Do not reuse an `Idempotency-Key` for a changed request. Receipts replay the
  old result.

## 5. Tracking rules and what the numbers mean

- **Day key:** the calendar date of `client_time` in the profile timezone.
  Changing the timezone does not move past entries.
- **Non-tracking days:** Friday and Saturday by default (Settings), plus any
  observed holiday dates you list. Food on those days is refused until you set
  the day to tracked in History. Health readings are allowed on any day.
- **Completeness:** `missing` means "No log". It is never zero intake.
  `partial` is set automatically when you log food or burn. `complete` is only
  set by you.
- **Burn:** `recorded` (a burn you wrote) or `assumed`. A tracked day with no
  written burn assumes **2000 kcal**, labelled "assumed". A recorded burn
  overrides it.
- **Net** = intake − burn. It is shown only for tracked, complete days. Otherwise
  it is "Unknown".
- **Frozen days:** a day's eligibility and timezone are saved when its first
  record is written. Later Settings changes do not rewrite it. Days with no
  saved record follow the current Settings.
- **Calendar window:** History opens on the last 30 calendar days. The UI
  loads up to 93 days at a time. The API allows up to 3660 days.

## 6. Historical import

Use **Import historical records** in the UI. Two formats are accepted:

- **Canonical JSON** (full fidelity): `meal`, `summary`, `correction`,
  `metric`, and `burn` messages with stable IDs and timestamps that include an
  offset. Summaries are reconciliation evidence, never extra intake.
- **ChatGPT or text conversation JSON** (table-only): only the active branch,
  only the latest two-column daily table per day, and every row needs review.
  Free-text meals, burn, metrics, and corrections are not extracted.

Flow: **preview** (structured records only; no raw HTML or transcripts are
stored) → **review** (Include with a verified day and timezone, or Skip, plus
optional `complete_days` and `tracked_days`) → **confirm** (commits up to 20
source groups per call; the UI loops until done) → **report** (inserted,
duplicate, corrected, skipped, unresolved, failed, and source-vs-ledger totals
per day).

Limits: 5 MB combined per upload, 5000 records per batch, 100 sources, and 30
records per source message (atomic). A DynamoDB transaction holds at most 100
writes.

Reimporting the same source IDs produces duplicates, not double counts. A
browser table revision replaces the earlier table for its day atomically. A
summary total that disagrees with the ledger leaves the day `partial`.

## 7. Trends and analytics snapshots

- **Local (`TRENDS=sqlite`):** reports are computed live from the local store.
- **AWS (`TRENDS=athena`):** a report queries **one** published snapshot in
  Athena. "Data as of" shows that snapshot's time. Writes made after it are not
  in the report until you refresh.
- **Snapshot source:** a native DynamoDB full export at the table's
  `LatestRestorableDateTime` (PITR). That time can lag the current clock.
- **Refresh analytics data** calls `POST /api/analytics/refresh`. It creates one
  export per 5-minute slot, or reuses a pending one. The export worker polls
  every minute, validates the manifest, checksums, and ETags, registers a Glue
  partition for the data directory only, then publishes `LATEST` only if the
  new snapshot is newer. If anything fails, the last good snapshot stays.
- **Nightly export:** 03:00 Asia/Jerusalem.
- **Queries** are asynchronous. They time out after 2 minutes, can be
  cancelled (`DELETE /api/trends/:id`), are capped at 100 MiB scanned per
  query, and write results to private, encrypted S3 for 7 days. Results are
  capped at 10,000 rows.
- **Reports:** weekly and monthly totals of intake, burn, net, and coverage
  counts (eligible, complete, partial, missing, excluded, assumed burn). Also
  per-food totals and daily glucose averages. Absent days are never
  extrapolated.

## 8. Known problems (verified)

These come from reading the code and running the resolver on the seed catalog
(`src/resolver.ts` via a read-only script, outside the repo). Nothing was
changed.

1. **"small gil" with no amount logs 120 kcal, not 75.** "gil" is a substring
   alias of "small gil", so both foods match. The 50-kcal rule then takes the
   higher candidate. Workaround: use the Hebrew alias `גיל קטן` (verified: 75 kcal).
   With an amount in grams ("small gil 125g") the item is unresolved instead.
2. **"eggplant spread" is unresolved, even with 100 g.** The short alias `egg`
   (fried egg) matches inside the word, the fried egg can't be priced in grams,
   and only one candidate is left, so no pick is made. Workaround: "squash
   spread" (verified: 181 kcal per 100 g).
3. **A stated number is the whole line.** "2 eggs 100 calories" logs 100 kcal,
   not 200. The quantity is kept for display only (verified).
4. **Per-user `calories` overrides can be silently ignored** on per-100g,
   per-100ml, and per-gram foods (section 3.5, verified).
5. **Unresolved items are not recorded, and the message is generic.** Every
   unresolved item gets the same reply, "could be options more than 50 kcal
   apart", even when the food is simply unknown (`src/chat.ts`, verified). The
   model's `needs_clarification` text is dropped whenever at least one item
   resolves (read in code).
6. **The model's `food_key` is ignored.** Matching uses only the typed text, so
   calories always come from the catalog or from a stated number (`bestFood`
   takes no `food_key`).
7. **Logging more food resets a complete day to partial** (`src/chat.ts`, read in
   code). Re-mark the day complete in History afterwards.
8. **Editing the legacy `log_entries` SQLite table has no effect** after the
   migration. The running app reads `store_items` (verified by grep). The
   `applyCorrection` helper that writes `log_entries` is called only by tests.
9. **Deleting a food from `seeds/foods.json` does not remove it.** Seeding only
   upserts (read in code). Remove the `CATALOG` item by hand if you need to.
10. **The system prompt and the catalog are fixed per deployment in AWS.** The
    deploy script copies `docs/stuntman-diet-system-prompt.md` into
    `releases/<sha>/` in the artifacts bucket. The "editable without rebuild"
    promise in the Copilot build brief applies only to local runs. The catalog
    is packaged into the ZIP the same way.
11. **Health readings have no UI.** Use the API (section 4.3).
12. **Backups:** `POST /api/admin/backup` returns 400 in the standard server
    path, because the app is not built with a raw SQLite handle (code reading).
    `src/backup-handler.ts` has no schedule: it is not wired into
    `infra/template.yaml`. Its default `DB_PATH` (`/mnt/data/diet.db`) is from
    the old EFS design.

## 9. AWS architecture

Per environment (`staging` and `production`), the stack `stuntman-diet-<env>`
is defined in `infra/template.yaml`. The Cognito stack `stuntman-diet-<env>-auth`
is defined in `infra/auth.yaml`. Shared release storage is
`stuntman-diet-artifacts` (`infra/artifacts.yaml`).

| Component | Resource | Notes |
| --- | --- | --- |
| **Web app Lambda** | `AWS::Lambda::WebFunction` (`stuntman-diet-<env>`) | Node 24 ZIP. Plain Hono server on `index.js` → `dist/server.js`. 60 s timeout. Up to 8 concurrent requests per environment, endpoint up to 2 environments. `ApplicationManaged` auth: the app checks Cognito JWTs itself. |
| **Export worker Lambda** | `stuntman-diet-<env>-exports` | `dist/export-handler.handler`. 120 s timeout, 256 MB, reserved concurrency 1, failures to an encrypted SQS dead-letter queue (14 days). Triggered every minute (poll) and nightly at 03:00 Asia/Jerusalem by EventBridge Scheduler. |
| **DynamoDB** | `DietTable` | On-demand, PK/SK strings, KMS encryption, PITR on, deletion protection on, retained on stack delete. |
| **S3 "data puddle"** | `PuddleBucket` | Private, SSE-S3, versioned, retained, access-logged. Prefixes: `exports/` (current 90 days, noncurrent 30), `results/` (Athena output, 7 days), `images/` (food photos, noncurrent 90 days), `analytics-table-root/` (empty on purpose). |
| **Glue / Athena** | Database `diet_<env>_<account>`, table `diet_items`, workgroup `stuntman-diet-<env>-trends` | Table location is the empty `analytics-table-root/`. Each snapshot is a partition at its own `data/` prefix. Workgroup enforces its configuration and a 100 MiB scan cap. |
| **Bedrock** | `amazon.nova-lite-v1:0` | The app role may invoke only that model. |
| **Cognito** | User pool per environment | Admin-created users only (no self-signup). Password ≥ 16 characters with MFA optional (TOTP). Advanced security enforced. Browser client uses authorization code + PKCE (no secret), with 15-minute access and ID tokens. Smoke client uses `client_credentials` with scope `diet-smoke/parse`, which only allows `POST /api/chat`. |
| **Logs** | Log groups with 30-day retention, KMS-encrypted | `/aws/lambda/web/<stack>` and `.local`, plus `/aws/lambda/<stack>-exports`. |
| **Keys** | KMS keys for DynamoDB and logs | Retained on stack delete. |
| **Restore** | `infra/restore.yaml` | Imports one export's `data/` prefix into a new table. |

Native DynamoDB exports write DynamoDB JSON. Athena reads them through an
OpenX JSON SerDe with `case.insensitive=true`. Queries use lowercase paths such
as `item.data.m.calories.n`.

## 10. Deployment and environments

### Pipeline (`.github/workflows/ci.yml`)

- **Pull requests:** start DynamoDB Local (`127.0.0.1:8000`), run `npm test`,
  `npm run build`, and `npm run package` on Linux x64. The ZIP is uploaded as an
  artifact.
- **Push to `main`:** deploy staging with `scripts/deploy.mjs staging`. Then
  `scripts/cloud-smoke.mjs stuntman-diet-staging --fixture` runs the three
  HTTP checks (`GET /health` 200, protected route without a token 401, and one
  Bedrock parse with a Cognito test token 200). It also seeds synthetic rows in
  staging, runs two native exports, and checks the Athena totals (intake 300,
  burn 2000, net −1700, no double count).
- **Production:** runs after a `main` push, or after a manual `workflow_dispatch`
  with `production=true`. It needs approval of the `production` environment.
  `scripts/verify-production-gate.mjs` fails unless required reviewers, a
  main-only deployment policy, and branch protection are all configured. It
  then deploys the same ZIP and runs the smoke checks. The production job has
  only `contents: read` and `actions: read`.

### Manual deploy (only when intended)

Packaging must run on Linux x64, because `better-sqlite3` is a native module.

```sh
export AWS_PROFILE=click AWS_REGION=us-east-1 AWS_PAGER=""
export BUILD_REVISION="$(git rev-parse HEAD)"
node scripts/check-deployment.mjs preflight      # read-only
node scripts/deploy.mjs staging                  # uploads ZIP and docs/ prompt, then CloudFormation
node scripts/cloud-smoke.mjs stuntman-diet-staging --fixture
node scripts/check-deployment.mjs post stuntman-diet-staging
```

`deploy.mjs` uploads `dist/stuntman-diet.zip` to `releases/<sha>.zip` and
`docs/stuntman-diet-system-prompt.md` to `releases/<sha>/system-prompt.md`. It
then deploys `infra/auth.yaml`, `infra/artifacts.yaml`, and `infra/template.yaml`.

### Environments

| | Staging | Production |
| --- | --- | --- |
| Stack | `stuntman-diet-staging` | `stuntman-diet-production` |
| Auth stack | `stuntman-diet-staging-auth` | `stuntman-diet-production-auth` |
| Fixtures | Synthetic data allowed | Never (the script refuses) |
| Gate | Automatic on `main` | Manual approval plus branch and reviewer checks |

## 11. Backups and recovery

- **PITR** on DynamoDB gives point-in-time restore.
- **Nightly native full exports** go to `exports/` in the puddle (current
  objects kept 90 days, noncurrent 30) and are indexed as Athena partitions.
- **Restore drill:** `infra/restore.yaml` imports one export's `data/` prefix
  into a **new** table. Verify counts, active calorie totals, receipts, and
  correction links there. Never union two exports.
- **Cutover:** the app has no table-name parameter yet. Switching to a restored
  table needs a reviewed CloudFormation change that updates the web app, worker,
  IAM, and outputs together. The original table stays retained.
- **SQLite mode:** `createBackup()` makes a `VACUUM INTO` copy and uploads it to
  `S3_BACKUP_BUCKET` at `backups/YYYY/MM/DD.db`. It is reachable only through
  `POST /api/admin/backup` (`ADMIN_SUB` only). That route returns 400 unless the
  app is built with a raw SQLite handle, which `npm start` does not do (code
  reading). `restoreBackup()` has no caller.
- **Photos:** food images are stored under `images/` in the puddle bucket.

## 12. Data model

All entities live in one key-value store. The same keys work in SQLite
(`store_items`) and DynamoDB.

| Key | Entity | Data (summary) |
| --- | --- | --- |
| `USER#<sub> / PROFILE` | `profile` | `timezone`, `holidays[]`, `non_tracking_weekdays[]` |
| `USER#<sub> / DAY#<d>#META` | `day` | `eligibility`, `completeness`, `burn_total`, `burn_source`, `accept_default_burn`, `burn_components`, `timezone` |
| `USER#<sub> / DAY#<d>#ENTRY#<id>` | `entry` | `occurred_at` (original), `timezone`, `display_name`, `quantity`, `unit`, `calories`, `calories_source` (`db`, `user_number`, `estimate`), `match_stage`, `status` (`active`, `superseded`, `void`), `superseded_by`, `food_id`, `raw_text`, `image_key`, `source_id` (imports) |
| `USER#<sub> / DAY#<d>#METRIC#<id>` | `metric` | `metric`, `value`, `unit`, `source` |
| `USER#<sub> / REQUEST#<key>` | `receipt` | `hash`, `result` (idempotency) |
| `USER#<sub> / FOOD_PREF#<food>` | `food_preference` | Per-user override body |
| `USER#<sub> / IMPORT#<job>` and `…#RECORD#<n>` | `import_job`, `import_record` | Import job and per-record state |
| `USER#<sub> / SOURCE#<source-id>` and `SOURCE#BROWSER_TABLE#<rev>` | `source`, `browser_table_revision` | Provenance receipts |
| `USER#<sub> / JOB#query#<id>`, `JOB#export#<id>` | `query_job`, `export_ref` | Trend and refresh job ownership |
| `CATALOG / FOOD#<id>` | `food` | Catalog entry (including seed `preferred_value`) |
| `ALIAS#<normalized> / FOOD#<id>` | `alias` | Written, not read at runtime |
| `SYSTEM#EXPORT / JOB#<id>` | `export_job` | Export state (`pending` → `running` → `complete` or `failed`) |
| `SYSTEM#EXPORT / LATEST` | `snapshot` | Newest published snapshot |

Each item has a `version`. Writes use optimistic concurrency: a write succeeds
only if the stored version matches `expectedVersion`. A mismatch returns 409.

## 13. HTTP API

All `/api/*` routes need a valid Cognito bearer token (except where noted).
Every write needs `Idempotency-Key` (8–120 characters from `A-Za-z0-9:_-`),
except `POST /api/admin/backup`.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Health check (no auth) |
| `GET /auth/config` | Cognito domain, client ID, redirect URI (no auth) |
| `GET /`, `/app.js`, `/styles.css`, `/manifest.webmanifest` | PWA assets |
| `GET /robots.txt` | Disallows all crawlers |
| `GET /api/profile` · `PUT /api/profile` | Timezone, holidays, non-tracking weekdays |
| `GET /api/foods` | Catalog with your overrides applied |
| `PUT /api/foods/:id/preferred-value` | Body `{calories_per_100g}` or `{calories}` (section 3.5) |
| `GET /api/history?from&to` | Calendar days, entries, burn, net, completeness |
| `PUT /api/days/:day` | `eligibility`, `completeness`, `accept_default_burn` |
| `POST /api/chat` | JSON `{text, client_time}` or multipart with optional `image` |
| `POST /api/health-metrics` | Glucose, BP, or weight (201) |
| `GET /api/trends?from&to` · `GET /api/trends/:id` · `DELETE /api/trends/:id` | Start, poll, or cancel a report |
| `POST /api/analytics/refresh` · `GET /api/analytics/refresh/:id` | Start or poll a snapshot refresh |
| `POST /api/imports/preview` · `PUT /api/imports/:id/review` · `POST /api/imports/:id/confirm` · `GET /api/imports/:id` | Import flow (section 6) |
| `POST /api/admin/backup` | SQLite backup to S3. `ADMIN_SUB` only. Returns 400 in the standard `npm start` path (section 11) |

Error bodies are `{error}`. Zod and input errors return 400. Store conflicts
return 409. Auth failures return 401, and a missing auth configuration returns
503. Other errors return 500 with a generic message, and details are logged.
The API caps bodies at 6 MB.

Security headers: CSP limits scripts and connections to `self` and the Cognito
origin, with `frame-ancestors 'none'`. API responses are `no-store`.

## 14. Configuration

| Variable | Default (`.env.example`) | Used by |
| --- | --- | --- |
| `PORT` | `3000` | Local server |
| `DB_PATH` | `./data/diet.db` | SQLite file |
| `STORE` | `sqlite` | `sqlite` or `dynamo` (AWS always `dynamo`) |
| `TABLE_NAME` | blank | DynamoDB table (required when `STORE=dynamo`) |
| `DYNAMODB_ENDPOINT` | blank | Loopback DynamoDB Local only |
| `COGNITO_USER_POOL` | blank | Pool ID or issuer URL |
| `COGNITO_CLIENT_ID` | blank | Browser client (also checked on tokens) |
| `COGNITO_DOMAIN` | blank | Hosted UI domain (login and logout) |
| `COGNITO_REDIRECT_URI` | blank | Sent to the browser (defaults to the origin) |
| `SMOKE_CLIENT_ID` | not set | Smoke client, limited to `POST /api/chat` |
| `BEDROCK_MODEL` | `amazon.nova-lite-v1:0` | Model ID |
| `AWS_REGION` | `us-east-1` | All SDK clients |
| `SYSTEM_PROMPT_PATH` | `./docs/stuntman-diet-system-prompt.md` | File path or `s3://bucket/key` |
| `FOODS_PATH` | `./seeds/foods.json` | Catalog file |
| `ADMIN_SUB` | blank | Only user allowed to run `/api/admin/backup` |
| `S3_BACKUP_BUCKET` | blank | SQLite backup target |
| `TRENDS` | `sqlite` | `sqlite` (live) or `athena` (snapshot) |
| `PUDDLE_BUCKET` | blank | Exports and Athena results (worker and web app) |
| `IMAGE_BUCKET` | falls back to `PUDDLE_BUCKET`, then `S3_BACKUP_BUCKET` | Food photo storage |
| `ATHENA_WORKGROUP`, `ATHENA_RESULTS_BUCKET` | blank | Athena queries |
| `GLUE_DATABASE`, `GLUE_TABLE` | blank | Snapshot partitions |
| `TABLE_ARN` | blank | Worker's export call |

The template sets `NODE_ENV=production`. `server.ts` reads
`AWS_LAMBDA_HTTP_ENDPOINT` for its listen address when the runtime provides it.
Do not set AWS credential variables on the Lambda: `check-deployment.mjs`
rejects reserved runtime keys.

## 15. Repository map

Every tracked file, grouped by purpose.

**Root**

- `README.md`: this document.
- `package.json`: scripts (`dev`, `build`, `start`, `seed`, `test`, `package`), dependencies, Node ≥ 24.
- `package-lock.json`: generated lockfile (not reviewed line by line).
- `tsconfig.json`: strict TypeScript, `src/` → `dist/`.
- `.env.example`: local configuration template (copy to `.env`; `.env` is git-ignored).
- `.gitignore`: ignores `node_modules/`, `dist/`, `coverage/`, `.env`, `data/`, `*.zip`, `.DS_Store`.
- `LICENSE`: MIT, copyright Steve Bar Yakov Gindi, 2026.

**`src/`: application**

- `server.ts`: Hono app and all routes. Security headers, body limit, error mapping, catalog seeding on first API call, admin backup. Also starts the server when not testing.
- `auth.ts`: Cognito JWT verification (JWKS, RS256, issuer, client and token-use checks). Smoke tokens limited to `POST /api/chat`.
- `chat.ts`: the write path for a message (section 1).
- `llm.ts`: Bedrock client. Forced tool call, zod validation, one retry. Also the grounded narration for health questions.
- `resolver.ts`: matching and calorie math (section 3.3).
- `parsing.ts`: deterministic burn parsing.
- `renderer.ts`: Markdown summary table and end-of-day rule.
- `time.ts`: `client_time` validation, offsets, day keys in a timezone.
- `ledger.ts`: profile, day state, history, `mutate()` idempotency receipts, versioned `write()`, date validation.
- `store.ts`: the store interface, pagination cursors, transaction validation, `StoreConflict`.
- `store-sqlite.ts`: SQLite implementation of the store. Migrates the legacy tables once (`store_migrations`).
- `store-dynamo.ts`: DynamoDB implementation. Consistent reads, transactional conditional writes, loopback-only endpoint.
- `db.ts`: SQLite connection (WAL) and the legacy schema.
- `seed.ts`: legacy SQLite seeding and the `npm run seed` entry point.
- `catalog.ts`: idempotent upsert of the catalog into the store, preserving user overrides.
- `analytics.ts`: trend reports. Live local mode, Athena snapshot mode, the pinned-snapshot SQL, refresh orchestration.
- `trends.ts`: re-exports the trend functions from `analytics.ts`.
- `export-handler.ts`: export worker Lambda handler. Starts and polls native exports, validates manifests, registers Glue partitions, publishes `LATEST`.
- `imports.ts`: import preview, review, confirm, and report, including browser-table revisions.
- `browser-import.ts`: converts ChatGPT or text conversation JSON to canonical records (active branch, daily tables only).
- `backup.ts`: SQLite `VACUUM INTO` backup to S3 and a restore helper.
- `backup-handler.ts`: scheduled-backup Lambda entry point. Not wired into the template.
- `types.ts`: shared types (`AppContext`, `FoodRecord`, `Dependencies`).

**`public/`: PWA**

- `index.html`: the single page (log, History, Trends, Import, Settings).
- `app.js`: browser logic: Cognito PKCE login, API calls, rendering, import flow.
- `styles.css`: styles.
- `manifest.webmanifest`: installable app metadata.

**`seeds/`, `docs/`: live content**

- `seeds/foods.json`: the 61-food preset catalog (section 3).
- `docs/stuntman-diet-system-prompt.md`: the instructions the LLM follows. Read locally on every parse. Copied into the release in AWS.
- `docs/AWS-WEB-FUNCTIONS.md`: the current deployment and operations reference.

**`infra/`: CloudFormation**

- `template.yaml`: web app, worker, DynamoDB, puddle, Glue, Athena, IAM, logs, KMS, schedules.
- `auth.yaml`: Cognito user pool, browser client, smoke client.
- `artifacts.yaml`: release bucket and access-log bucket.
- `restore.yaml`: restore drill into a new table.

**`scripts/`: build, deploy, and checks**

- `package.mjs`: builds the Linux ZIP (production dependencies, `dist/`, `public/`, `docs/`, `seeds/`, `index.js`).
- `deploy.mjs`: uploads artifacts and deploys the three stacks.
- `check-deployment.mjs`: read-only preflight, and post-deploy checks (PITR, deletion protection, bucket settings, Athena workgroup, worker wiring).
- `cloud-smoke.mjs`: post-deploy HTTP smoke and the staging export fixture.
- `verify-production-gate.mjs`: fails closed unless production approval and branch protection are configured.
- `wait-dynamo.mjs`: waits for DynamoDB Local in CI.
- `deployment.test.mjs`: tests of the scripts and templates, using a fake `aws` CLI.

**`.github/workflows/ci.yml`**: the CI and deployment workflow (section 10).

**`prompts/`: older copies and agent briefs. Not read by the app or the deploy scripts.**

- `stuntman-diet-system-prompt.md`: an older prompt. It has the earlier "ask about pizza" rule, not the current 50-kcal rule in `docs/`.
- `foods.json`: an older catalog. It lacks the peanut-butter `secondary` units now in `seeds/foods.json`.
- `AWS-WEB-FUNCTIONS.md`: the superseded EFS/SQLite deployment brief.
- `copilot-build-prompt.md`: the original v1 build brief.
- `copilot-pivot-prompt-v2.md`: the DynamoDB pivot brief, the source of the store design.

Edit `seeds/` and `docs/`, not `prompts/`.

**`tests/`**: see section 16.

## 16. Tests

| File | Covers |
| --- | --- |
| `app.test.ts` | Time rules, resolution, corrections, HTTP routes, idempotent profile and day updates, rendering |
| `auth.test.ts` | JWT verification, wrong client, expiry, smoke-token scope, error mapping |
| `catalog.test.ts` | Catalog reseeding keeps overrides, stated amounts, ambiguity tolerance |
| `export.test.ts` | Native export publication with mocked AWS: refresh slots, retries, manifest checks, no regression to older snapshots, failures keep the last good one |
| `import-revisions.test.ts` | Browser daily-table revisions: replacement, duplicates, conflicts, crash recovery, concurrency, transaction size |
| `ledger.test.ts` | Day policy, idempotency, chat logging and corrections, canonical imports, 18-month import, Athena SQL pinning, local reconciliation |
| `llm.test.ts` | Forced tool contract and the retry rule |
| `store.test.ts` | Store contract on SQLite and DynamoDB Local (pagination, conflicts, receipts), SQLite migration, DynamoDB request safety |

`npm test` runs `vitest run tests` and `node --test scripts/deployment.test.mjs`.
