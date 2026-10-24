# stuntman-diet — Copilot pivot prompt (v2): DynamoDB + S3 data puddle

## Read first and scope
Read `docs/AWS-WEB-FUNCTIONS.md`, `docs/stuntman-diet-system-prompt.md`,
`prompts/copilot-build-prompt.md`, and the current `src/` before changing
anything. This prompt supersedes the older production SQLite/EFS, single-writer,
21-day history, and SQL-only analytics requirements where they conflict.

Keep the Node.js/TypeScript Hono Web Function and CloudFormation deployment.
Replace production storage with DynamoDB and S3/Athena analytics. Keep SQLite
for local development, tests, and possible Orange Pi self-hosting.
Preserve existing food resolution, rendering, time handling, LLM JSON contract,
and seed data except for mechanical store-interface changes and the explicit
tracking-policy, import, and UI requirements below. Do not rewrite unrelated
modules or assume the existing implementation is defect-free.

## Why
Web Function revisions cannot mount EFS and their endpoint MaxEnvironments
minimum is 2. DynamoDB removes both production SQLite constraints and supports
concurrent execution environments. S3 holds immutable point-in-time exports
(the "data puddle"); Athena queries a selected export, never a mixture of
overlapping full exports. Do not promise a particular operating cost: document
export, Athena, Cognito, and retained-storage charges.

## Store interface and keys
- Add asynchronous `src/store.ts` operations for profiles, days, entries,
  corrections, foods/aliases, preferences, health metrics, import checkpoints,
  idempotency results, and export/query jobs.
- `src/store-sqlite.ts` wraps the existing schema in `src/db.ts`; preserve
  `DB_PATH` and migrate existing files safely. `src/store-dynamo.ts` implements
  the same contract. Select using `STORE=sqlite|dynamo`, default sqlite locally.
- DynamoDB table name comes from `TABLE_NAME`. Use on-demand billing,
  encryption at rest, PITR, deletion protection, and retain-on-delete.
- Use `PK` and `SK` with explicit entity types. Prefer this base-key layout,
  which supports strongly consistent reads without a GSI:
  - Profile: `PK=USER#<id>`, `SK=PROFILE`.
  - Day: `PK=USER#<id>`, `SK=DAY#<yyyy-mm-dd>#META`.
  - Entry: `PK=USER#<id>`, `SK=DAY#<yyyy-mm-dd>#ENTRY#<stable-entry-id>`.
  - Health metric: `PK=USER#<id>`, `SK=DAY#<yyyy-mm-dd>#METRIC#<stable-metric-id>`.
  - Mutation receipt: `PK=USER#<id>`, `SK=REQUEST#<idempotency-key>`.
  - Import job/checkpoint: `PK=USER#<id>`, `SK=IMPORT#<job-id>`.
  - Export/query job: `PK=USER#<id>`, `SK=JOB#<kind>#<job-id>`.
  - Food: `PK=CATALOG`, `SK=FOOD#<food-id>`.
  - Alias candidate: `PK=ALIAS#<normalized-alias>`, `SK=FOOD#<food-id>`.
  - User food override: `PK=USER#<id>`, `SK=FOOD_PREF#<food-id>`.
- Query a day's prefix or a bounded day-prefixed date range; follow ALL
  pagination cursors. Filter entity types explicitly. Do not attempt to find
  `ENTRY#...` keys using a `DAY#...` range. Add a GSI only for a demonstrated
  access pattern; never depend on a GSI for immediate read-after-write results.
- Preserve original timestamp/offset, application-computed day key, timezone
  active at logging, status, superseded_by, calorie provenance, and image keys.
  Use UTC instants for chronological comparisons, not offset-string ordering.
  Timezone changes must not rewrite historical day assignments.

## Idempotency, corrections, and catalog
- Every mutation carries a durable user-scoped idempotency key and canonical
  payload hash. Repeating a request returns its recorded result without another
  write; reusing a key with different content returns an explicit conflict.
  DynamoDB's short-lived transaction client token is not sufficient alone.
- Supersede + insert + receipt is a MULTI-item TransactWriteItems operation.
  Require the original entry to exist, belong to the authenticated user, and
  still be active. Insert the replacement conditionally and link it to the
  original atomically. Competing corrections produce a conflict, not two
  replacements. Void preserves the original and is conditional/idempotent.
- Implement equivalent SQLite transactions and respect DynamoDB transaction
  limits. Oversized user/import groups require explicit chunk semantics; never
  claim atomicity across separately committed chunks.
- Seed upserts never overwrite user preferences. Alias keys can have multiple
  candidates: resolve uniquely or ask, never silently choose an arbitrary food.
- Exact/alias lookups use GetItem/Query; fuzzy matching stays in-process.
  Load the catalog at warm start and use a documented bounded refresh/version
  policy across instances. Read user overrides consistently so stale caches
  cannot ignore a just-saved correction. No OpenSearch.

## Tracking policy: Fridays, Saturdays, and holidays
- Default non-tracking weekdays are Friday and Saturday in the profile zone.
  Settings must support observed holiday dates/ranges and per-day overrides.
  Do not guess which Jewish, religious, or civil holidays the user observes;
  manual date selection is required, automatic calendar suggestions optional.
- Separate tracking eligibility (`tracked` or `untracked`) from log completeness
  (`missing`, `partial`, or user-confirmed `complete`). Preserve historical
  eligibility decisions and explicit overrides; a timezone/settings change
  must not silently reinterpret old days.
- Untracked/missing days are NOT zero-intake days. Never invent intake, default
  burn, or deficits for them. Logging actual food on an untracked date requires
  an explicit day override; historical imports flag such records for review
  rather than discarding them.
- Default burn 2000 may remain a proposed value on tracked days, but mark it
  as assumed. Whole-day deficit reports use complete eligible days with
  recorded burn, or with a default burn explicitly accepted by the user.
  Missing burn means unknown net, not zero burn.
- Reports show eligible, complete, partial, missing, and excluded day counts,
  actual intake coverage, and assumed-burn counts. Do not extrapolate absent
  days into weekly/monthly deficits. Label partial-period totals clearly.
  Health readings remain available on non-tracking days; calorie exclusions
  must not remove glucose/BP data.

## Default history UI
- Show the last 30 CALENDAR days, not the last 30 tracked days and not the full
  chat transcript. Use the store for expandable daily food tables with tally,
  burn provenance, net/unknown net, completeness, and tracking status.
- Show "Not tracking" for excluded dates and "No log" for missing eligible
  dates, not fabricated zero-calorie tables or deficits.
- Older dates are available via an explicit date-range action with bounded
  loading/pagination. Retain all imported data for analytics regardless of
  this default display window. Never fetch/render all raw chat history merely
  to show the daily tables.

## Historical import: at least 1.5 years
- Support at least 18 months of chats extracted from browser history, including
  multiple files, overlapping exports, corrections, and repeated daily tables.
  Inspect representative source formats before writing extraction adapters.
- Add an authenticated import UI: upload, preview, review uncertainties,
  confirm, then monitor resumable progress and a reconciliation report.
  Source uploads must be private, size-limited, and validated; never put raw
  personal chats in public assets, logs, Bedrock unnecessarily, or Athena's
  published analytics data prefix. Record an explicit source-retention policy.
- Preserve batch/source provenance and source conversation/message identifiers
  where available. Derive stable record IDs from those identities, not random
  IDs or text alone. Without source IDs, fingerprint stable source context and
  surface uncertain overlaps for review. Identical text can be legitimate
  repeated meals; never merge it solely because the text matches.
- Retrying/reimporting the same source records must not duplicate entries,
  metrics, burn, or corrections. Checkpoint confirmed source groups; commit
  each within transaction limits and resume safely after interruption.
- Repeated cumulative assistant tables and end-of-day totals are evidence for
  reconciliation, NOT additional meals. Prefer original meal/correction
  evidence; if only cumulative tables exist, reconcile successive revisions
  into one final ledger. Never add both details and summary totals as intake.
- Resolve source dates/timezones through the app time engine, never the LLM
  clock or current date fallback. Require review for ambiguous/missing dates,
  timezone assumptions, uncertain duplicate identity, untracked-day conflicts,
  inconsistent daily totals, and unmatched correction targets.
- Report inserted, already imported, superseded, voided, excluded-by-confirmation,
  unresolved, and failed records, with source-vs-ledger daily total comparisons.
  Do not silently mark incomplete imports as complete days.

## S3 point-in-time exports and recovery
- `src/export.ts` orchestrates DynamoDB's NATIVE FULL point-in-time export to
  S3 using PITR, NOT paginated Scan. A scan is not a consistent snapshot even
  with strongly consistent reads. Use the service's actual supported export
  time window; expose the chosen snapshot timestamp (which may lag now).
- Nightly 03:00 Asia/Jerusalem EventBridge Scheduler starts an export job.
  A separate conventional Lambda/orchestration handles initiation and bounded
  status checks; the web app remains a plain HTTP server with no handler.
- Add authenticated on-demand refresh. Persist job identity, idempotency key,
  selected point in time, AWS export ARN, progress, and failures. Deduplicate
  concurrent equivalent refreshes and rate-limit refreshes per user/account.
  Do not hold an HTTP request or one Lambda invocation open for the full job.
- Each export uses an immutable generation prefix. Accept only AWS-completed
  exports whose manifests/data objects validate; a non-empty object alone is
  not proof of success. Track empty-but-valid exports explicitly.
- Prepare queryable metadata before atomically publishing a latest-complete
  pointer using conditional writes. Never let an older finishing job replace
  a newer snapshot. Keep the last good generation usable during failures.
- The private puddle bucket is versioned, SSE-S3, retain-on-delete, with explicit
  retention/lifecycle rules. PITR and retained exports are complementary backups,
  not interchangeable. Keep SQLite backup support for SQLite mode only.
- Document and exercise restoration into a NEW table, record/count/tally
  verification, and a controlled cutover. Native exports contain all entity
  types; private job/receipt/profile data must not be exposed in analytics APIs.

## Athena: exactly one generation per report
- Create Glue/Athena resources in CloudFormation. Use the actual native DynamoDB
  export format (typed DynamoDB JSON, compressed data files) with tested schema/
  deserialization, not an assumed flat JSONL shape.
- Register each complete generation's DATA-ONLY location as an explicit
  snapshot partition (or equivalent immutable selection). Do not point a table
  at the parent exports prefix, include manifests, or silently discover
  incomplete generations with a crawler.
- Each request pins one snapshot ID and every query filters that ID and the
  authenticated user. All dashboard panels for that request use that same ID,
  even if a newer snapshot publishes meanwhile. Never union full daily exports
  or add overlapping live records. Partition pruning must avoid scanning other
  generations. Display the snapshot timestamp in every result.
- Aggregate active entries only, excluding superseded/voided rows. Aggregate
  entries per day BEFORE joining metadata/metrics so burn is counted once per
  day and joins cannot multiply food, calorie, or metric counts.
- Weekly/monthly reports, top foods, and glucose trends cover the selected
  range up to ALL retained history, including the 18+ month import. Respect
  tracking/completeness/burn rules and show coverage, not invented deficits.

## UI-driven puddle analytics
- Trends must actually call authenticated server endpoints that execute Athena
  against the puddle, not merely show pre-generated files or live-store totals.
  Provide date-range controls, "All history", and deterministic reports/charts.
- Show "Data as of" and explain that nightly snapshots may be stale. Provide
  "Refresh analytics data": initiate/reuse export, show progress/failure, and
  rerun the selected report against the newly published generation. Writes
  after the snapshot time are not promised to appear in that refresh.
- Athena query jobs are asynchronous with bounded polling, cancellation,
  explicit errors/timeouts, and user-authorized job/result retrieval. Persist
  ownership; never let a client supply another user's arbitrary query ID or
  read arbitrary S3 query-result keys.
- Use fixed SQL templates and validated parameters, not arbitrary browser/LLM
  SQL. Derive user identity server-side. LLM trend answers narrate pre-computed
  aggregates and coverage only, never raw chats or the entire table.
- Enforce WorkGroup configuration, scan limits (e.g. 1 GB/query), encrypted
  private result storage and retention. Bound result sizes and paginate.
  Do not send AWS credentials to the browser.

## CloudFormation and permissions
- Deploy all AWS resources through CloudFormation: Web Function/revision/endpoint,
  DynamoDB, Cognito, S3, Glue, Athena WorkGroup, export/job orchestration, IAM,
  and timezone-aware schedule. No EFS or single-environment requirement remains.
  Concurrent writers are safe through transactions, not process-local queues.
- Separate least-privilege web-app, export, and analytics responsibilities.
  Scope DynamoDB actions to the table and only indexes actually used. Native
  export needs its specific DynamoDB export/status and S3 permissions, not just
  CRUD. Keep Bedrock access limited to the permitted configured Nova Lite/Haiku
  model ARNs. Preserve private image upload storage/permissions.
- Scope export writes, Athena reads, Glue metadata, query execution/cancellation,
  and query-result access to their actual resources. Do not grant Action "*"
  or Resource "*"; scoped object prefixes such as `exports/*` are legitimate,
  not unrestricted account-wide access. Document unavoidable service-level
  scoping limitations rather than silently granting broad permissions.
- Replace the old gate: PRE-deployment validate supported resource schemas and
  template/IAM configuration; POST-deployment verify actual PITR, encryption,
  authentication, role policies, workgroup limits, and export/query readiness.

## Tests and CI acceptance
- Preserve existing behavior/tests except documented requirement changes.
  Mechanical async/caller changes are allowed; update 21-day expectations to
  30 calendar days and unsafe empty-day burn behavior to the policy above.
- One store-contract suite runs against BOTH SQLite and DynamoDB Local (pinned
  Docker service in CI): pagination, read-after-write, time/day/travel boundaries,
  scoped preferences, alias ambiguity, 30-day history, exclusions, concurrent
  supersede/void, payload conflicts, and replay after process/retry-token expiry.
- Import fixtures cover 18+ months, overlapping files, repeated identical meals,
  cumulative tables, source corrections, ambiguous dates, non-tracking dates,
  interrupted jobs, and reimport with zero additional logical records.
- Test failed/incomplete exports, retries, concurrent refresh jobs, older jobs
  finishing last, last-good fallback, and immutable request snapshot selection.
  Mock AWS APIs for unit tests; validate real native export/Athena format in
  staging (DynamoDB Local does not implement the managed export service).
- Critical analytics fixture: two full snapshots containing the same ledger.
  Querying the selected generation returns the original totals, NOT double.
  Multiple entries/metrics on one day must count burn once; untracked/missing
  days create no fictitious deficit. Verify policy coverage and assumed burn.
- CI: tests -> Linux ZIP build -> CloudFormation staging deploy -> exact smoke
  checks `/health` 200, protected route without JWT 401, Bedrock parse with test
  JWT 200 -> manually invoke export initiation, wait for managed completion and
  publication, then run an Athena aggregate against isolated known test records.
  Validate counts/totals and exclusion of the older snapshot, not just non-empty
  output. Test identities/data must never pollute personal reports.
- Manual production approval only after staging passes. Run actionlint, zizmor,
  and IaC security checks before pushing workflow changes. Never bypass a
  failed gate or claim deployment complete based on template validation alone.

## Delivery and configuration
- All changes to main via PR linked to the relevant issue; branch from
  `first-prompts` HEAD. Do not merge or deploy production without approval.
- Update directly related architecture/setup docs to supersede the old EFS and
  default-history requirements. Keep the editable system prompt and foods file;
  change renderer/time/parsing/LLM modules only when required by the explicit
  new policy or mechanical interfaces, with focused regression tests.
- Document `.env` additions: `STORE`, `TABLE_NAME`, `PUDDLE_BUCKET`, `TRENDS`,
  `ATHENA_WORKGROUP`, `ATHENA_RESULTS_BUCKET`, and export/job configuration.
  Use the Click account, local AWS profile `click`, and existing GitHub secrets;
  never put credentials or imported personal chats into source control.
