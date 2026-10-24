# stuntman-diet
Personal Diet app that counts daily calories 

This app resides in @click account

## Local development

This is a Node.js 24+ Hono HTTP server with Cognito JWT authentication and a
PWA. Start with:

```sh
npm ci
cp .env.example .env
npm run seed
npm run dev
```

Set Cognito and Bedrock configuration in `.env` before using authenticated API
routes. SQLite defaults to `./data/diet.db`; the system prompt is read from
[`docs/stuntman-diet-system-prompt.md`](./docs/stuntman-diet-system-prompt.md)
on each parse, and the editable seed catalog is
[`seeds/foods.json`](./seeds/foods.json). Run `npm test` and `npm run build`
to verify changes.

## Storage and tracking

Production uses a transactional DynamoDB ledger, with PITR and immutable native
full exports to a private S3 "data puddle". Local SQLite remains supported;
existing databases migrate atomically into the shared async store contract
without deleting the legacy tables. Production has no EFS, ephemeral database,
or single-writer restriction.

Every write needs an `Idempotency-Key`. Durable receipts prevent request replay
from adding meals twice. Corrections atomically preserve the original entry
and insert/link the replacement. Food preferences are user-scoped; reseeding
does not overwrite them. Catalog caches expire after 60 seconds, while user
preferences are read consistently on each request.

The history UI defaults to **30 calendar days**, with older date-range loading.
Friday and Saturday are non-tracking days by default. Select observed holiday
dates in Settings, and override individual dates in History when appropriate.
Missing, partial, complete, and excluded dates are distinct. Confirm a tracked
day complete before calculating its deficit; burn must be recorded or the
labelled 2000 kcal assumption explicitly accepted. Empty/excluded dates never
generate invented deficits. Settings changes do not rewrite saved historical
day metadata.

## Historical import

Use Import to upload multiple overlapping JSON files (5 MB combined, at most
5000 structured records per batch; split larger exports). There are two paths:

- ChatGPT conversation exports with `mapping` and `current_node`, or extracted
  text conversations with `id`/`conversation_id` and `messages` containing
  `id`, `role`, `timestamp` (ISO offset) or `create_time` (epoch seconds), and
  `content` (text or `{ "parts": ["text"] }`). This adapter selects the latest
  supported two-column daily food table per date on the active branch.
  **Every extracted table requires review.** It does not infer free-text-only
  meals, health readings, burn, or undocumented holidays. Review inferred food
  dates: the timestamp of a retrospective table may not be its food date.
- Normalized JSON for full-fidelity meals, corrections, burn and metrics:

```json
{
  "conversation_id": "stable-original-conversation-id",
  "messages": [
    {
      "id": "stable-original-message-id",
      "timestamp": "2025-01-05T12:00:00+02:00",
      "timezone": "Asia/Jerusalem",
      "kind": "meal",
      "display_name": "Eggs",
      "calories": 150
    },
    {
      "id": "correction-message",
      "timestamp": "2025-01-05T13:00:00+02:00",
      "timezone": "Asia/Jerusalem",
      "kind": "correction",
      "target_id": "stable-original-message-id",
      "action": "replace",
      "display_name": "Eggs",
      "calories": 100
    }
  ]
}
```

Other kinds: `summary`/`burn` use `total`; `metric` uses `metric`, `value`, and
`unit`; correction supports `void` or `replace`. Supported readings are glucose
(mg/dL), BP systolic/diastolic (mmHg), and weight (kg). Source IDs must stay
stable across exports; repeated text alone is not a duplicate identity.

Preview and resolve or skip uncertain records before confirmation. Import
checkpoints commit up to 20 source groups per request and resume without reinserting
completed records. Source-identity conflicts fail explicitly; changed data must
be represented as a correction, not silently overwrite an imported source.
Repeated summary tables are never added as additional food intake. Reconciliation
disagreements keep the day partial, even if it was initially marked complete.
One original message/table commits atomically (at most 30 structured records);
larger groups fail explicitly and must be split into reviewed source chunks.
The regression suite covers more than 18 months of imported history.

Raw browser HTML/transcripts are processed in memory and are not saved or sent
to Bedrock by the importer. Structured evidence, provenance, import checkpoints,
and receipts are retained with the ledger and its backups. Deleting a local
browser export does not erase the imported ledger or retained snapshots.

## On-demand trends and backup freshness

Trends queries Athena over **exactly one completed generation** and the
authenticated user's data. Date ranges and All history include older imports,
not just the default history window. Reports include calendar coverage and
assumed-burn counts. Daily meals aggregate before joining burn, so multiple
meals/readings cannot multiply daily burn.

Nightly exports start at 03:00 Asia/Jerusalem. "Refresh analytics data" starts or
reuses a durable job; background checks publish it only after AWS completion,
manifest/checksum validation, and Glue partition registration. The last good
snapshot remains available on failure. Refreshes are coalesced into five-minute
slots. Native PITR's latest restorable time may lag the current clock: always
check **Data as of**, especially immediately after importing. Writes after that
timestamp need a later refresh.

Athena runs asynchronously with cancellation, a two-minute polling time limit,
workgroup scan limits and private encrypted results. No browser AWS keys or
arbitrary SQL are accepted. Local `TRENDS=sqlite` uses the same policies against
the local store and is labelled live rather than a historical snapshot.

PITR and retained exports are complementary recovery mechanisms. Use the
CloudFormation restore template with one selected generation's `data/` prefix
to restore to a **new** table; never union generations. Verify entity counts,
active calorie totals, source receipts and correction links before changing the
application's table parameter. Retain the original table through cutover.

## CloudFormation delivery

All infrastructure is CloudFormation-managed. CI runs SQLite/DynamoDB Local
contracts, app and deployment tests, builds a Linux x64 ZIP, deploys staging,
then checks `/health` 200, protected-route 401, and a Bedrock parse with a scoped
Cognito test JWT 200. Native exports and Athena totals are tested using isolated
synthetic staging records, including two full snapshots without double counting.
Production deployment is manually gated after successful staging.

See [`infra/template.yaml`](./infra/template.yaml),
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml), and
[`docs/AWS-WEB-FUNCTIONS.md`](./docs/AWS-WEB-FUNCTIONS.md).
The Linux package includes SQLite's matching native binary for local-mode
compatibility, but production always selects `STORE=dynamo`.

GitHub uses the existing `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets
and verifies account `570989156105` (Click). Local AWS commands use
`--profile click --region us-east-1`. Standalone Cognito is declared in
[`infra/auth.yaml`](./infra/auth.yaml); the smoke client can only call
`POST /api/chat` with an isolated identity. No personal password or Cognito
Admin APIs are needed.
