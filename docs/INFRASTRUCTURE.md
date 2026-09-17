# Infrastructure

Status: **plan, not built.** Today everything runs in one AWS account
behind a raw Lambda function URL, with blobs served by presigned S3 URLs.
Each section below marks what is decided, open, or deferred.

---

## Accounts

One AWS account per environment. A mistake in staging cannot reach prod
when the credentials can't see it.

| Account | Root email | Holds |
|---|---|---|
| Management | `<user>+aws-root@gmail.com` | Organization and sign-in only |
| Prod | `<user>+mimoza-prod@gmail.com` | `envs/prod` |
| Staging | `<user>+mimoza-staging@gmail.com` | `envs/staging` |

`envs/local` runs against LocalStack and needs no account.

**Root emails are Gmail plus-addresses, never the domain.** A lapsed
domain hands account recovery to whoever registers it next. Never use an
email whose domain is registered inside the account it recovers.

Per account: Terraform state bucket, deploy role, and the two SSM
SecureStrings (`/mimoza-<env>/fcm-service-account`,
`/mimoza-<env>/apns-auth-key`, created by hand — Terraform would put them
in state as plaintext).

Shared across accounts: APNs `.p8` key, Google/Apple sign-in client IDs.

Providers take `aws_profile` and `aws_account_id`, so applying with the
wrong credentials fails instead of building in the wrong place. Neither is
committed — locally they come from the environment, in CI from a GitHub
Environment variable beside the role ARN:

```bash
export AWS_PROFILE=mimoza-staging
export TF_VAR_aws_account_id=<account>
```

---

## The front door

**CloudFront over the Lambda function URL, at `api.mimoza.app`.**

`EXPO_PUBLIC_RELAY_URL` is compiled into each app build
(`app/src/core/services/relay.ts`), so installed apps dial that hostname
forever. An AWS-generated URL cannot be that hostname — it must be a name
we control before any build ships to a real user.

- Cache policy `CachingDisabled`, origin request policy
  `AllViewerExceptHostHeader` — the relay serves per-user encrypted data,
  so nothing here is cached. Blobs are the opposite; see below.
- DNS at Cloudflare, **"DNS only"**. Proxying would stack two CDNs.
- Free tier covers it: 1 TB out, 10M requests/month, permanent.

Sync payloads still gain from the nearby TLS handshake and the AWS
backbone on the long leg.

Built as `modules/cdn`, wired into both envs but inert until `api_domain`
is set — with it empty, `api_endpoint` stays the raw function URL.
Certificate validation is manual: the first apply blocks on the record,
which the `cdn` output prints for adding at Cloudflare.

---

## Blob delivery

**Downloads via CloudFront signed URLs at `cdn.mimoza.app`. Uploads stay
presigned S3 POSTs direct to the bucket.**

Every member of a circle downloads identical ciphertext, so the second
reader onward should be served from the edge.

- **S3 reachable only via the distribution** (origin access control), or
  old-style URLs bypass signing and the cache.
- **Signing parameters stay out of the cache key**, so all members share
  one object: the cache policy sets query strings to `none`, and
  CloudFront strips `Expires`/`Key-Pair-Id`/`Policy`/`Signature` before
  the origin sees them.
- **Post photos are immutable** (`<syncId>/<entryId>`) — long TTL.
- **Covers overwrite in place** at `<syncId>/cover`
  (`internal/synclog/s3/blob_store.go`), so that path is **uncached**
  until the hash moves into it — `cover_photo_set` already carries
  `photoHash`, so devices know it before fetching.
- **Invalidate on delete only.** Nothing else ever changes. One path per
  photo; one wildcard (`/<syncId>/*`) per circle for bulk deletion, which
  counts as a single path. First 1,000 paths/month free, account-wide.
- Invite previews carry no blob — name and avatar ride inline, encrypted
  under the invite key (`INVITE_FLOW.md`). No pre-membership blob access.

Provider portability comes from the domain plus the relay handing out
URLs at request time; clients never see S3. Signing is CloudFront-specific
and stays behind the `BlobStore` interface.

The distribution, key group and bucket policy are in `modules/cdn`, inert
until `blob_domain` is set. **The relay still hands out presigned S3
URLs** — switching it to CloudFront signing (private key in SSM under
`/mimoza-<env>/`, key pair id from the `blob_key_pair_id` output) is the
next step, along with invalidation on delete.

---

## Deploys

GitHub Environments (`staging`, `production`), each holding its own
`AWS_ROLE_ARN`. OIDC — no stored AWS keys; the trust policy names the repo
and environment.

- Merge to `main` → staging.
- Tag → prod, with required approval.

Tags pick the release: `relay-v*` deploys the relay, `app-v*` builds and
submits the app.

**Relay first, then the app.** One relay serves every installed version,
and a rollback can't unwrite what new clients appended — older clients
discard entry types they don't know (`SYNC_DESIGN.md` invariant 5).

### App builds

One build per environment; `EXPO_PUBLIC_RELAY_URL` is compiled in, so the
environment is fixed at build time.

| | Staging | Prod |
|---|---|---|
| Bundle ID | `com.eozsahin.mimoza.staging` | `com.eozsahin.mimoza` |
| Relay URL | `staging-api.mimoza.app` | `api.mimoza.app` |
| Distribution | TestFlight internal | App Store |

A separate bundle ID means its own Firebase app, its own Google/Apple
sign-in client IDs (the relay's `GOOGLE_CLIENT_ID_*` / `APPLE_CLIENT_ID_IOS`
must match per env), and its own `APNS_TOPIC` — the topic *is* the bundle
ID. The APNs `.p8` key is shared. `APNS_PRODUCTION` already selects
sandbox versus production.

Version is plain semver; the build number is separate
(`ios.buildNumber`, `android.versionCode`, both auto-incremented — iOS
needs a unique build per version, Android a strictly increasing integer).
Neither is set in `app.json` today. Surface `1.0.0 (15) · <commit> · <env>`
in-app: the SHA is the only identifier that can't drift.

### Verifying an upgrade

Client migrations apply by index in one transaction and are gap-safe
(`app/src/data/db/migrations/run.ts`), but every test starts from an empty
database — the **upgrade-with-data path is untested**. Install the previous
staging build, use it, then install the new one *over* it. Deleting the app
between builds is what makes staging pass and real upgrades fail.

Adopting OTA (`expo-updates`, not installed) changes this: a JS-only
update can carry a migration, and rolling that update back leaves old JS
against a newer schema. Treat anything touching `migrations/` as a native
release.

---

## Cost

Estimate at 1,000 monthly users, ~3 photos each, with CloudFront:

| | |
|---|---|
| Lambda (~1.6M invocations) | ~$1 |
| DynamoDB (~6M ops, on-demand) | ~$1.50 |
| S3 storage (6 GB/month added) | ~$0.15 |
| CloudFront, S3 egress | $0 (free tier; S3→CloudFront is free) |
| **Total** | **~$3–4/month** |

Bandwidth stops mattering until ~1 TB/month (~500k photo downloads).
Requests bind first: the 30s foreground sync caps out near 10M/month
around ~6k users, and that cadence is tunable.

Accounts created after 2025-07-15 get credits, not the old 12-month free
tier. Storage accumulates; nothing deletes photos unless asked.

**Guardrails, in order:**

1. Billing alarm — free, and the only thing that reports a problem. Built
   as `modules/billing-alarm`, off until `billing_alert_email` is set.
2. Lambda reserved concurrency — free, caps how fast money can leave.
   Defaults to 50; every table is `PAY_PER_REQUEST`, so nothing else
   bounds spend.
3. WAF — deferred. ~$6/month per environment, and the account-level rate
   limiter already handles fairness. IP rules are a cost shield, not a
   replacement: shared carrier and household IPs force loose thresholds.

`POST /push/send` is unauthenticated by design (`PUSH_DESIGN.md`) — the
one endpoint reachable without an account.

---

## Deferred

- **Cloudflare R2 for blobs** — zero egress, S3-compatible. Revisit if
  bandwidth becomes a real line item; splits providers.
- **Origin Shield** — collapses edge misses into one origin fetch. Pays
  off only once origin fetches cost something.
- **Parallel photo downloads** — the queue drains one at a time
  (`app/src/core/photo/photo-queue.ts`), which is slow on high-latency
  links. Edge caching addresses the same symptom first.
