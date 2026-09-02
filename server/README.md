# circle-relay

The relay server for the Circle app — a blind relay for encrypted circle
content, plus account auth/recovery plumbing. It never sees plaintext
content and is designed to infer as little as possible about circle
membership or social structure. See [DESIGN.md](DESIGN.md) for the full
architecture writeup and the reasoning behind each decision; this file is
just a map to find your way around the code.

## Layout

```
cmd/
  server/    entry point for `go run` / local dev — http.ListenAndServe
  lambda/    entry point for AWS Lambda (behind a Function URL)
internal/
  api/       one subpackage per endpoint ("vertical slice": handler + service + route),
             plus router.go, the composition root that wires everything together
  storage/   one subpackage per data domain — port (interface) + dynamodb/s3 impl
  secrets/   KMS-backed root secret storage
  crypto/    server-side key derivation (HKDF from the KMS root secret)
  config/    reads every env var once, in one place
  testsupport/ real adapters against LocalStack, shared by every package's tests
provision/   Terraform — prod in this directory, a LocalStack mirror under local/
```

Both `cmd/` entry points call the same `api.NewRouter(...)` — nothing
below `internal/api` knows or cares whether it's running on Lambda or as a
long-lived process.

## Storage: three tables, three different reasons

- **sync-log** (`internal/storage/logstore`) — one row per circle-log
  entry, keyed by `circleLogId` + `epoch`. TTL'd (`LOG_RETENTION_DAYS`) —
  the relay is a sync cache, not a permanent archive; each device's local
  SQLite is the real source of truth.
- **sessions** (`internal/storage/authstore`) — one row per bearer token.
  TTL'd (90 days from issuance). Looked up by token, never by account.
- **accounts** (`internal/storage/manifeststore`) — one row per account,
  holding a single opaque `blob` the client encrypted itself. Never
  TTL'd. The relay only ever reads/writes ciphertext here — see
  DESIGN.md's "Account recovery" section.

Each table exists because its access pattern and lifecycle genuinely
differ from the others — see each package's own doc comment for the
specific reasoning, and `internal/storage/dynamoutil` for the handful of
attribute-encoding helpers all three share.

## Auth flow, end to end

This is the part that trips people up, so it's worth walking through
directly rather than just reading five files in isolation.

1. **Sign-in** (`internal/api/auth/google`, `.../apple`) verifies the
   client's ID token against the provider's own public keys
   (`internal/api/auth/oidcverify`), then builds an **accountId**:
   `"google:" + sub` or `"apple:" + sub`. `sub` is the OIDC subject claim
   — a permanent, provider-issued identifier, required on every token by
   spec. The `provider:` prefix exists purely so Google's and Apple's
   independently-issued `sub` values can never collide with each other;
   it's not a lookup key for anything server-side.

   Identity is keyed on `sub`, not email, because email can change
   (a person edits their account email, or an Apple private-relay
   address gets regenerated) while `sub` can't — see DESIGN.md's
   "Account recovery" section for the full reasoning.

2. **`auth.Issue`** (`internal/api/auth/session.go`) mints a random
   bearer token and stores `authstore.Session{AccountID: accountID,
   ExpiresAt: ...}` in the sessions table, keyed by that token. The
   token — not the accountID — is what the client gets back and sends on
   every future request. This indirection is what makes a session
   revocable (logout deletes the token's row) without needing to touch
   the account itself.

3. **Every request to a protected route** goes through
   `auth.RequireSession` (`internal/api/auth/middleware.go`), which pulls
   the bearer token off the `Authorization` header, looks up its session,
   checks `ExpiresAt`, and stashes the account on the request's context:

   ```go
   type contextKey int
   const accountIDKey contextKey = iota
   ```

   `accountIDKey` is just a private, collision-proof key for
   `context.WithValue`, which takes `any` as its key — a plain string
   (`"accountID"`) would risk colliding with some other package's context
   value of the same name; an unexported custom type makes that
   impossible, since no other package can construct one.

4. **The handler** retrieves it with `auth.AccountID(ctx)`, which does the
   lookup and type-asserts it back to a `string` — the same value built
   in step 1 (`"google:<sub>"` etc.).

(If you're reading old code, docs, or a diff and see `DeviceID` — that
was this exact field before a rename; it was never actually
device-specific, just the account identifier under an earlier, more
confusing name from when it was `emailHmac`.)

## Identity model: four things that are easy to conflate

This spans both sides (the relay only ever touches the first one), but it
belongs in one place — the confusing part is exactly how these relate to
*each other*, and that's lost if each piece is documented separately next
to its own code.

| | What it is | Derived from | Who needs it to match |
|---|---|---|---|
| **accountId** | `"google:<sub>"` / `"apple:<sub>"` | Provider's OIDC `sub` claim | The relay, for session lookup. See "Auth flow" above. |
| **masterSeed** | 128 bits of entropy behind the 12-word recovery phrase | Random, generated once at onboarding (`generateSeedPhrase()`) | Nobody but your own devices — never leaves the client, never sent to the relay in any form. |
| **circleId** | A local UUID | `generateUUID()`, freely chosen per circle | Only your own devices, across time (see below) — never other members. |
| **circleLogId** | The relay-visible address for a circle's log | `sha256("circle-log" \|\| circleSecret)` | Every member — it's the one thing that *has* to match, since it's how independent devices agree on a relay address with zero coordination. |

The relationship: your circle **identity keypair** is
`deriveCircleIdentity(masterSeed, circleId)` — a pure function of your own
seed and your own private label for the circle. Nobody else ever
recomputes it; they only ever learn your public half by reading it out of
the circle's roster, which syncs like any other content. So `circleId`
only has one real job: staying *stable for your own account across a lost
device*, which is exactly what the account-recovery manifest
(`internal/storage/manifeststore`) exists to guarantee — it's a durable,
client-encrypted list of the circleId values your account used, so a
recovering device reproduces the *same* keypairs the rest of the circle
already recognizes, instead of showing up as an unrecognized stranger.

**How `circleId` and the secret get paired**: not by any derivation —
`circleId` and the circle secret are two independently-random values with
no mathematical relationship. They're linked purely by local storage: the
moment a device obtains a circle's secret (generating it, for the
founder; decrypting the mailbox's approval response, for a joiner), it's
saved to Keychain keyed by that device's own `circleId`
(`saveCircleSecret(circleId, secret)`) — before anything else happens.
From then on, `circleId` is just the lookup key that gets the secret back
out; the secret itself is what everything cryptographic (`circleLogId`,
decrypting entries) actually derives from.

**How you actually fetch a circle's content**: look up the secret via
`circleId` (a plain local read, not a derivation), derive `circleLogId`
from *that*, then `GET /v1/circles/{circleLogId}/entries?since=` — see
`fetchEntries` (app-side) / `internal/api/fetchentries` (this repo).
Concretely, this two-step chain is exactly what `drainOutbox` does on
every sync:

```ts
const secret = await getCircleSecret(circleId);   // local lookup
const circleLogId = deriveCircleLogId(secret);    // real derivation
```

Everything needed to read a circle comes from the secret alone once
you've looked it up; the local `circleId` never itself talks to the
relay, it only ever unlocks what's stored under it.

**How you get the circle secret in the first place** (join-by-invite,
design only — not built yet, see DESIGN.md's "Mailbox" section): the
invite code itself carries no secret, just a lookup tag
(`hash(invite_code)`). The requester generates a one-time keypair, posts
a join request to that tag; the inviter encrypts the circle secret to the
requester's one-time public key and posts the response to the same tag.
Only the requester's matching private key can open it — the relay
forwards ciphertext under an opaque tag either side can compute, never
learning what's inside or that the two messages are related to the same
handshake beyond sharing a tag.

## Running locally

```
cd provision/local && terraform init && terraform apply   # provisions LocalStack tables/bucket/KMS key
cd ../..
cp .env.example .env   # fill in values from `terraform output` above
export $(cat .env | xargs) && go run ./cmd/server   # see .env.example — Go doesn't load .env itself
```

`go test ./...` runs against the same LocalStack instance (`testsupport`
creates tables lazily on first use, shared across test packages — see its
own doc comment for why IDs in tests are always freshly generated, never
hardcoded).
