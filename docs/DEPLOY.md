# Deploying the tester and judge sites

One Docker image serves everything: the landing page, the guided tour, and a private sandbox per visitor (`services/stack/src/serve.ts`). Two copies run side by side:

| Site | Agents | Sandboxes | For |
|---|---|---|---|
| **Public** | offline (instant, free, deterministic) | up to 60, 30 min idle expiry, 6 new per IP per hour | testers |
| **Judge** | Amazon Bedrock, Nova 2 Lite (`LLM_MODE=bedrock`) | up to 10 | judges and the video |

Before any deploy, check locally:

```bash
pnpm build:web
PORT=8080 ADMIN_KEY=local pnpm serve        # http://localhost:8080
pnpm tour http://localhost:8080 local       # drives the whole tour in Chrome; must print TOUR CHECK PASSED
```

## AWS (once the account is active)

`infra/lib/host-stack.ts` (`StoopHostStack`): a t3.small in a public subnet builds the image from this GitHub repo at boot and runs both containers; a CloudFront distribution in front of each gives HTTPS on a `*.cloudfront.net` address. The admin key for the feedback export is generated into Secrets Manager.

```bash
aws login --profile stoop
pnpm --filter @stoop/infra exec cdk bootstrap aws://428516841578/us-east-1 --profile stoop   # once
pnpm --filter @stoop/infra exec cdk deploy StoopHostStack --profile stoop --require-approval never --outputs-file outputs-host.json
```

CloudFront takes about 5–10 minutes; the instance needs another 5–8 minutes to build the image after it starts. Then:

```bash
curl https://<PublicUrl>/healthz                       # {"ok":true,...}
ADMIN_KEY=$(aws secretsmanager get-secret-value --profile stoop --secret-id <AdminKeySecretArn> --query SecretString --output text)
pnpm tour https://<PublicUrl> "$ADMIN_KEY"              # adds one "Automated tour check" row; the summary skips it
```

**Ship an update** (after pushing to `main`):

```bash
aws ssm send-command --profile stoop --instance-ids <InstanceId> --document-name AWS-RunShellScript --parameters 'commands=[
  "cd /opt/stoop && git pull && docker build -t stoop .",
  "docker rm -f public judge",
  "ADMIN_KEY=$(aws secretsmanager get-secret-value --region us-east-1 --secret-id <AdminKeySecretArn> --query SecretString --output text)",
  "docker run -d --name public --restart always --network host -e PORT=8080 -e PUBLIC_PROTO=https -e ADMIN_KEY=$ADMIN_KEY -v /opt/stoop-data-public:/data stoop",
  "docker run -d --name judge --restart always --network host -e PORT=8081 -e PUBLIC_PROTO=https -e ADMIN_KEY=$ADMIN_KEY -e LLM_MODE=bedrock -e AWS_REGION=us-east-1 -e MAX_SANDBOXES=10 -v /opt/stoop-data-judge:/data stoop"
]'
```

Feedback lives on the instance's disk (`/opt/stoop-data-*/feedback.jsonl`) and survives container updates.

**Cost:** about $0.02 an hour for the instance (roughly $15 a month), CloudFront within its free tier at tester scale, $0.40 a month for the secret, plus Bedrock calls on the judge site. All within the account's credits. **Tear down:** `pnpm --filter @stoop/infra exec cdk destroy StoopHostStack --profile stoop`.

## Fallback if AWS is still blocked (about 15 minutes)

Any host that runs a Dockerfile from GitHub works. On Render: New → Web Service → this repo → runtime **Docker** → port **8080** → environment `PUBLIC_PROTO=https`, `ADMIN_KEY=<long random string>` → a persistent disk mounted at `/data` if you want feedback to survive restarts. The free plan sleeps when idle (the first visit then takes about a minute); a paid plan stays up. Leave `LLM_MODE` unset there: public testers get the offline agents, and no AWS credentials leave your machine.

## Read the feedback

```bash
node tools/feedback-summary.mjs "https://<PublicUrl>/api/feedback.jsonl?key=<ADMIN_KEY>"
```

Responses, average usefulness, would-use split (overall and among people who actually sell secondhand), tour completion, and every comment. Automated tour-check rows are excluded. Only quote numbers and comments that come from this file.
