# Infrastructure

Status: **staging is built** — its own account, both distributions, the
relay behind `api.staging.joinmimoza.com`. Blobs are the exception: the
distribution is up at `cdn.staging.joinmimoza.com` but the relay only signs
for it once its settings parameter exists (below). Prod is not built: the
Terraform is written and its settings decided, but there is no account
yet, and `env_domain` is unset. Each section marks what is decided, open,
or deferred.

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

Per account: Terraform state bucket (`mimoza-terraform-<env>`), deploy
role, and the SSM SecureStrings created by hand because Terraform would
put them in state as plaintext — `/mimoza-<env>/fcm-service-account`,
`/mimoza-<env>/apns-auth-key`, `/mimoza-<env>/cloudfront-signing-key`.

**Where settings live**, now that there are three places they could:

| | |
|---|---|
| `envs/*/main.tf` (`settings`) | Tuning — blob size cap, invite retention, rate limits. In git, so a change is a reviewable diff, and applied by `terraform apply` alone. |
| `<env>.env` → `push-config.sh` → SSM `/config/*` | Values only a human has: Google/Apple client IDs, APNs key/team/topic. |
| SSM, written by Terraform | Things Terraform created that the Lambda can't be told directly — see *How the relay finds the CDN*. |

The Lambda's environment is those first two merged, prefix last
(`modules/lambda/lambda.tf`), so nothing can override `RESOURCE_PREFIX` —
every table, bucket and parameter path derives from it.

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

**CloudFront over the Lambda function URL, at `api.<env_domain>`** —
`api.staging.joinmimoza.com` today, and whatever zone prod is given.

`EXPO_PUBLIC_RELAY_URL` is compiled into each app build
(`app/src/core/services/relay.ts`), so installed apps dial that hostname
forever. An AWS-generated URL cannot be that hostname — it must be a name
we control before any build ships to a real user.

- Cache policy `CachingDisabled`, origin request policy
  `AllViewerExceptHostHeader` — the relay serves per-user encrypted data,
  so nothing here is cached. Blobs are the opposite; see below.
- DNS at Cloudflare, **"DNS only"**. Proxying would stack two CDNs.
- **The function URL stays publicly callable** (`lock_function_url =
  false`). Origin access control is built and can be switched on, but
  Lambda rejects unsigned payloads: every POST/PUT would have to carry
  `x-amz-content-sha256` with the body's hash, put there by the client.
  An edge function can't — it never sees the body. Making the app aware of
  how its origin is protected is the wrong contract, so the lock is off.
  The hostname is 32 random characters and isn't in certificate
  transparency (Lambda serves it under a wildcard), so it is obscurity,
  not access control — what's behind it is the same bearer-token auth.
  **If bypass ever matters** (a WAF worth enforcing, say), the fix is API
  Gateway in place of the function URL: the Lambda stops being publicly
  reachable and nothing is asked of the client, for ~$1/M requests.
- Free tier covers it: 1 TB out, 10M requests/month, permanent.

Sync payloads still gain from the nearby TLS handshake and the AWS
backbone on the long leg.

Built as `modules/cdn`, wired into both envs but inert until `api_domain`
is set — with it empty, `api_endpoint` stays the raw function URL.
Certificate validation is manual: the first apply blocks on the record,
which the `cdn` output prints for adding at Cloudflare.

---

## Blob delivery

**Downloads via CloudFront signed URLs at `cdn.<env_domain>`. Uploads stay
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
  Best-effort: the bytes are already destroyed by then, so a failed
  invalidation is logged rather than failing the delete.
- Invite previews carry no blob — name and avatar ride inline, encrypted
  under the invite key (`INVITE_FLOW.md`). No pre-membership blob access.

Provider portability comes from the domain plus the relay handing out
URLs at request time; clients never see S3. Signing is CloudFront-specific
and stays behind the `BlobStore` interface.

### How the relay finds the CDN

The distribution needs the Lambda's function URL, so the Lambda can't be
told about the distribution in its own environment — that closes a
dependency cycle. **SSM is the handover instead: Terraform writes what it
created, the relay reads it at runtime.**

| | |
|---|---|
| `/mimoza-<env>/cdn` | `{baseUrl, keyPairId, distributionId}` as JSON, written by `modules/cdn`. One parameter, so a read can't see a half-updated set. Not secret. |
| `/mimoza-<env>/cloudfront-signing-key` | The RSA-2048 private key, **created by hand** — Terraform would put it in state. |

Both paths are derived from `RESOURCE_PREFIX` on each side
(`internal/config`, `modules/cdn/blobs.tf`), and nothing checks the two
spellings against each other.

**Whether blobs come from the CDN is a runtime answer, not configuration.**
`internal/synclog/cdn` reads the settings parameter once per cold start:
present means sign CloudFront URLs, `ParameterNotFound` means keep
presigning S3. That is what makes local runs work unchanged — LocalStack
has SSM but no CloudFront — and it means switching an environment over is
an apply, with no redeploy.

Consequences worth knowing:

- A warm Lambda keeps what it read. Changes land on the next cold start,
  or immediately after a deploy.
- Deploy Terraform before code that needs a new field: old parameter plus
  new code fails the shape check and falls back to S3, quietly.
- Generating the key is manual, once per environment:
  `openssl genrsa 2048` → private half to SSM, public half to
  `blob_signing_public_key`.

---

## Backups

**Point-in-time recovery on `sync-log` and `accounts`, in prod only.**

PITR is not snapshots and there is no interval to tune: it captures
changes continuously and restores to any second in the last 35 days, by
building a **new table**. It cannot roll one row back and it cannot be
queried as history — it is disaster recovery, not an audit log, and not a
debugging tool. It also only covers what happened after it was switched
on, which is why it goes on before launch rather than after the first
incident.

Those two tables because they are the ones holding data nobody else can
reconstruct — the archive itself, and the encrypted recovery manifest.
`sessions`, `invites` and `rate-limit` are all ephemeral by design
(expiry, TTL, counters), and `push` self-heals as devices re-register.

This is worth paying for despite the recovery floor in `SYNC_DESIGN.md`
("every device holds the full archive and all keys locally"), because that
floor has one hole: it assumes a device survived. Relay data loss *and* a
dead phone leaves nothing to re-upload from. At $0.20/GB-month against
tables holding ciphertext and metadata — the photos are in S3, not here —
this is cents a month for years.

**Open: blobs have no backup at all.** The bucket has neither versioning
nor replication, so a deleted or corrupted photo is gone, and photos are
the part of this product users would actually grieve. Versioning plus a
lifecycle rule expiring old versions is the obvious answer; it is not
built.

## Deploys

GitHub Environments (`staging`, `production`), each holding its own
`AWS_ROLE_ARN`. OIDC — no stored AWS keys; the trust policy names the repo
and environment.

- Merge to `main` → staging.
- Tag → prod, with required approval.

Tags pick the release: `server-v*` deploys the relay, `app-v*` builds and
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
| Relay URL | `api.staging.joinmimoza.com` | `api.<prod zone>` |
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
   as `modules/alarms`, off until `alert_email` is set.
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
