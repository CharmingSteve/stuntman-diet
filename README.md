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

## Deployment status

CI builds a ZIP and is wired to deploy a staging Lambda Web Function with
CloudFormation followed by the three required smoke tests: `/health` -> 200,
a protected route without a JWT -> 401, and a Bedrock-backed parse using a
Cognito test JWT -> 200. See [`infra/template.yaml`](./infra/template.yaml) and
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml).
The native SQLite ZIP is built on the workflow's Linux x64 runner so its
`better-sqlite3` binary matches the Web Function runtime.

CI uses the existing `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` GitHub
secrets and checks the destination account is `570989156105` (Click).
Local AWS commands must use `--profile click --region us-east-1`.
Standalone authentication is declared in [`infra/auth.yaml`](./infra/auth.yaml).
The smoke test obtains a short-lived, scoped Cognito client-credentials JWT;
the app restricts this client to `POST /api/chat` and an isolated smoke data
identity. No personal password or `cognito-idp:Admin*` calls are required.

**Deployment is blocked, not deployed.** Before creating any resources, CI
runs [`scripts/check-deployment.mjs`](./scripts/check-deployment.mjs) against
AWS's live CloudFormation registry. The required production database is SQLite
on EFS with a single writer, but Web Function revisions have no EFS mount
property and endpoint `MaxEnvironments` has a minimum of **2**, not the required
**1**. The template preserves the requested value of 1, so `cfn-lint` correctly
reports this unsupported value rather than hiding the mismatch.

The staging template's `/tmp` database is only a placeholder for isolated
smoke tests, not durable storage. Production CD and the scheduled EFS backup
cannot safely be enabled until the architecture is explicitly revised or AWS
supports both requirements. See [`docs/AWS-WEB-FUNCTIONS.md`](./docs/AWS-WEB-FUNCTIONS.md).
