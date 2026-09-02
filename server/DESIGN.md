# Relay server design

Status: **partially built**. This documents the architecture decided in
design discussion, so it survives past a chat transcript. What actually
exists: the relay server itself (`server/`, Go — append/fetch/blob for a
generic per-circle log) and the app's outbox + push-to-relay half of sync
(`app/src/domain/usecases/sync-circle.ts`'s `drainOutbox`, posts only).
Not built: the pull side (`pullCircle`, a local `circleLog` mirror table),
invites/roles/kick actually syncing through the relay (today these are
local-only — see `app/src/domain/usecases/invite-to-circle.ts` etc.), push
notifications (section 2 below is a full design, zero implementation), the
client-side onboarding UI for email auth (server-side API is built — see
"Email auth" below), and account recovery (see that section below — the
master seed exists and is already framed in the UI as the way back into
your circles, but nothing today actually makes that true yet).

The relay's core property: it is blind. It never sees plaintext content, and
it's designed so it can infer as little as possible about circle membership,
identity, or social structure from the traffic it handles.

## Two separate jobs, two separate mechanisms

It's tempting to reach for one mechanism ("mailboxes") for everything the
relay does. That was the original design and it's wrong — it can't support
new members seeing circle history, among other problems. The relay actually
does two structurally different jobs:

1. **Serving circle content** — durable, shared, replayable. Handled by an
   append-only log.
2. **Waking a device up / one-shot private handoffs** — ephemeral,
   per-individual, not shared. Handled by push + ephemeral mailboxes.

Conflating these is what caused the new-member-history gap. Keep them
separate.

## 1. Circle content: one append-only, epoch-indexed log per circle

- Every circle-scoped event — a new post, a member joining, a member being
  removed — is an entry appended to **one ordered log per circle**. Not
  separate mechanisms per event type.
- The relay's job here is dumb and mechanical: accept appends, and answer
  "give me every entry after epoch E" for a circle. It doesn't interpret
  content.
- **Local SQLite is a synced replica, not an inbox.** Each device tracks its
  own "last synced epoch" per circle. Reconnecting (app foreground, network
  back) means: for every circle the device is a member of, ask for deltas
  since its last epoch, apply them in order, advance the local epoch marker.
  This works identically whether the device missed 2 minutes or 5 hours —
  it's not dependent on which/whether push notifications fired.
- **This is what solves new-member history.** A new member's starting epoch
  is just their join point (or 0, if they should see full history) — they
  replay forward exactly like any returning device catching up. Under the
  old ephemeral-mailbox model this was structurally impossible: a mailbox
  only ever held what was delivered *after* it existed, and existing
  members' copies were long gone (fetched-and-deleted) by the time someone
  new joined.
- **Log entries should be lightweight, not embed full content.** Actual
  ciphertext (e.g. a compressed photo) lives once in a separate
  content-addressed blob store, keyed by an opaque random id unrelated to
  the circle or any member. A log entry is just a pointer: "new post,
  content at id X." Devices fetch the blob on demand. This avoids storing
  the same bytes once per recipient, and keeps log entries cheap to sync.
- **Kicking a member is just another log entry** (`member_removed`), which
  every remaining device applies on its next sync — same mechanism as
  everything else, not a special case.
- Kicking must always be bundled with **rotating the circle secret** and
  redistributing it (encrypted individually) to remaining members — removal
  from the roster alone doesn't necessarily stop a removed device from
  continuing to compute tags/derive access, depending on whether mailbox/log
  fetch ends up gated by tag-knowledge alone or by proof of current
  membership. Decide that protocol detail before building kick.

### Privacy trade-off, named honestly

A shared per-circle log id is something every member (including future new
ones) can independently derive from the circle secret — which means, unlike
per-member push tags, it's the *same* identifier for everyone in the circle.
That is a real, smaller leak: the relay can see "some cluster of connections
is polling this one opaque log," i.e. activity/cluster-size. It is **not**
the same as the identity-correlation leak per-member tags exist to prevent
(linking a specific device's durable push token across circles) — this
leaks presence/size, not who. Accepted trade-off in exchange for actually
getting correct replay/history, which the pure-mailbox model couldn't
provide at all.

The relay can also observe **timing correlation** — related fetches/pushes
clustered in the same short window can hint that they're connected, even
without revealing who. Known, not fully closeable (Signal only partially
mitigates the equivalent), not worth blocking on for v1.

## 2. Push notifications: rich, but the relay never knows why

Superseded an earlier thin/data-only design (push carries nothing, device
just wakes and syncs). Decided against: a silent-only push can't show
"Sarah posted in Family Circle" the way competitors do, and push
UX is table-stakes for adoption — but getting there without leaking
plaintext circle names/identities to the relay needs a few pieces
together, not one.

- **Routing ID, not a durable per-member tag.** Each device generates a
  fresh **random** (not derived) routing ID per circle — same
  don't-reuse-across-circles principle as `generateIdentity()`. Random
  rather than `HMAC(circle_secret, memberId)` specifically so the ID
  carries zero brute-forceable structure — nothing to reverse even if the
  derivation scheme is public.
- **Two different lifetimes for two different things:**
  - `routingId → realPushToken`: a real, durable, relay-held table,
    registered by each device independently of any circle. On its own it
    reveals nothing about circle membership — just "opaque ID reaches this
    device." One row per device, updated in place on token rotation, so a
    device's many per-circle routing IDs never need updating individually.
  - `circleLogId → [routingIds]`: **never stored**. It already exists
    durably, but encrypted — inside the roster, which syncs through the
    same append-only log as posts (routing IDs just ride along as one more
    encrypted roster field). The relay only ever sees the plaintext list
    *ephemerally*, supplied by the poster's device (which decrypted its
    own roster) as a parameter on the append request, used once to
    trigger fanout, never written down. No standing, queryable
    circle-to-routing-ID table exists anywhere.
- **Fanout is per-target, not a single group push** — same reasoning as
  before: N individual dispatches so the relay can't cluster them into
  "these belong to one circle" from the send pattern alone.
- **The relay constructs nothing from real data.** It sends either a
  minimal wake signal or the entry's existing ciphertext — never a
  server-assembled string built from plaintext circle name / poster
  identity, which would mean sending both to the relay on every post.
  Instead: **iOS Notification Service Extension** / **Android FCM data
  message → `onMessageReceived`** — both let the *device* intercept the
  push before display, decrypt with the circle secret it already holds,
  and construct the real notification text itself. Same mechanism Signal
  uses. If decryption fails (bogus routing ID, corrupted payload, wrong
  circle), fall back to nothing shown, logged locally only — never a
  broken/generic notification, never anything sent back to the relay.
- **Abuse case, and why it's mostly self-limiting:** the relay trusts
  whatever routing-ID list a poster supplies — it can't independently
  verify the claimed IDs are legitimate members of that circle without
  reintroducing the standing membership table this design avoids. But a
  bogus/malicious list can't produce a *meaningful* notification either
  way — decryption fails on the recipient's device (attacker doesn't have
  the circle secret), so the worst case is a dropped or generic
  fallback, not real spam content. Same encryption that protects content
  gates spam value, for free. Residual, cheap mitigations if it's ever
  worth tightening: cap notify-targets per request, rate-limit triggers
  per routing ID (a plain counter, no circle context attached).
- The real, complete fix — the relay cryptographically verifies "this
  poster shares a circle with this routing ID" without learning which
  circle or who — is a zero-knowledge group-membership proof (what
  Signal's Groups v2 does for a related problem). Named here as the
  ceiling, not something to build now; disproportionate engineering for
  this project's current stage and stakes.
- **Timing correlation via APNs/FCM's own delivery analytics is a real,
  unclosable side channel**, independent of anything the relay's own
  infrastructure does. Whoever's registered as the app's developer has
  legitimate access to Apple/Google's own push delivery dashboards, and
  could infer "these tokens got notified together" from timing alone.
  Nothing here (routing IDs, enclaves, ZK proofs) touches this — it lives
  entirely in the platforms' own systems. Jitter/delay per-recipient
  dispatch raises the cost of correlating it, doesn't eliminate it.
  Accepted, same category as the log-id activity/cluster-size leak above:
  known, not fully closeable, not worth blocking on.
- True peer-to-peer push isn't achievable on iOS/Android — platform
  constraint, not a design choice. Has to go through APNs/FCM either way.

## 3. Mailbox: ephemeral, one-shot, for things that truly aren't shared

Reserved for private, per-individual exchanges — not circle content.

- **Invite join requests**: the requester doesn't have the circle secret
  yet, so they can't derive a normal per-member tag. Instead the invite
  itself carries its own tag: `hash(invite_code)`. The requester computes
  this from the link/code alone and delivers their join request there.
- **Approval responses**: the creator's device encrypts the circle secret
  directly to the requester's public key and sends it back through the
  relay, which just forwards ciphertext it can't read.
- Semantics: **fetch, then ack, then delete** — not delete-on-fetch. If a
  device fetches but crashes before persisting locally, delete-on-fetch
  would destroy the only copy. Ack only after the item is safely applied
  locally.
- Ordering: FIFO by arrival, so a mailbox with several pending items
  replays in the order they actually happened.
- Deletion is scoped per-mailbox-entry — acking Alice's copy has no effect
  on Bob's independent copy of a logically-related delivery.

## Invites

- **One mechanism, no individual/group split.** Same invite flow whether
  shared 1:1 or dropped in a group chat — open until TTL, uncapped
  redemptions, every join requires approval. Simplifies to one code path,
  no user-facing choice to make.
- TTL: 7 days by default (`INVITE_TTL_MS` in
  `app/src/domain/usecases/invite-to-circle.ts`).
- Invite code: 12 characters from a 32-symbol confusion-resistant alphabet
  (`INVITE_CODE_ALPHABET` in `app/src/services/crypto.ts`) — 60 bits of
  entropy, short enough to type/read aloud, exact power-of-two alphabet
  size so there's no per-byte modulo bias. The same code backs the
  shareable link, the QR code, and the manual-entry fallback — one secret,
  multiple presentations, not three different things.
- **Approval is always the invite's specific creator, never "any admin."**
  An admin who didn't create a given invite has no real context to judge a
  join request against — they'd just be reading an unverified, self-reported
  name, no stronger a signal than the creator has anyway. Restricting to
  creator-only also avoids real plumbing cost: "any admin approves" would
  need a *second* routing tag scheme (since admins need visibility into
  invites they didn't personally create) plus an admin-to-admin invite-sync
  event. Not worth it for a speculative resilience benefit — if a creator
  goes unreachable, anyone else can just generate a fresh invite and become
  its creator, which is a free workaround requiring no new infrastructure.
- Self-reported display name in a join request is **not verified identity**
  — it's exactly as spoofable as typing any name at profile setup. The
  approval screen should be framed around what the approver actually knows
  ("someone used the invite you created on Tuesday"), not imply the name is
  confirmed fact.
- Revoke is a real, useful escape hatch but explicitly **not load-bearing**
  — TTL and the creator-approval gate already don't depend on anyone
  remembering to do anything. Revoke is a bonus for whoever happens to
  notice something's wrong, not something the security model assumes will
  get used.

## Roles

- `circleMembers.role: 'admin' | 'member'` (see `app/src/data/db/schema.ts`,
  values centralized as `MemberRole`/`MemberRoles` in
  `app/src/data/db/members.ts`).
- Admins can create invites and remove (kick) members. Regular members
  can't — modeled on why WhatsApp gates group-adding to admins, though our
  reasoning differs: WhatsApp gates it because they have *no* per-join
  approval step at all, so link-creation control is their only lever. This
  design already gates every invite behind creator-approval regardless of
  who made it, so admin-only invite-creation here is really about
  controlling circle growth/bloat, not security — the security boundary is
  the approval step, which exists no matter who created the invite.
- No persistent circle "owner." Authority is scoped to what you actually
  did: creating an invite makes you its approver; the founding member gets
  `role: 'admin'` automatically (`createCircle` in
  `app/src/domain/usecases/create-circle.ts`), and promoting others later
  is a small, separate, not-yet-built action.

## Email auth (partially built)

Not about content — content stays E2E encrypted regardless. This is about
closing the one real gap the blind design leaves open: nothing currently
stops unauthenticated spam against the relay itself (fabricate a random
circleLogId, hit the append endpoint forever, run up real infra cost). A
free-to-mint identity (a keypair, generated locally, same as any circle
identity) doesn't raise the bar against that — the fix has to impose real
cost on registering.

**Email, not phone — reversed after building the phone version first.**
The original design (and a first full implementation) used phone-number
OTP, on the reasoning that every major app requiring this property lands
on phone verification specifically. That fell apart on a regulatory wall,
not a technical one: sending OTP SMS to most countries (Turkey, Ireland,
Spain, and most of the EU) requires registering an alphanumeric sender ID
with the destination country's telecom regulator, and that registration
requires a certificate of incorporation — a registered business entity.
This is true of every SMS provider (confirmed for both AWS SNS and
Twilio), since it's the regulator's requirement, not the vendor's. For a
solo, pre-incorporation project, several target countries (Turkey
specifically has no long-code fallback either) are simply unreachable via
SMS OTP. Email OTP has none of this — no per-country registration, no
business-entity requirement, works identically everywhere. The scarce-
resource/abuse-prevention property email provides is weaker than phone's
(free email addresses are easier to mint than phone numbers), but the
primary threat here is scripted infra abuse, not sophisticated multi-
identity abuse — see the concurrency-cap/budget-alert mitigation below,
which is the actual backstop either way.

- **OTP flow**: app sends email address → server emails an OTP (via AWS
  SES — see delivery choice below) → user confirms → server computes a
  `deviceId` and discards the raw address immediately, never persisting
  it, never logging it.
- **`deviceId = HMAC(derivedKey, email)`, not a plain hash.** Email
  addresses are low-entropy (guessable/dictionary-able) — a plain hash is
  trivially reversible by precomputing the whole space. Keying it closes
  that, but only if the key never leaves the server: a key embedded in
  the client app is extractable by anyone motivated to look, which makes
  client-side hashing no safer than an unkeyed hash against a real
  attacker.
- **Email delivery: AWS SES, not a third-party API (Resend, Postmark,
  etc.).** SES is cheaper at any volume beyond a token free tier ($0.10
  per 1,000 emails flat, no minimum — third-party APIs compared were
  4-20x more expensive past their free tiers), and — more importantly for
  the key-management story below — needs no stored credential at all.
  Auth is the Lambda's own IAM role (`ses:SendEmail`), standard AWS
  SigV4 signing, not an API key that has to be generated, stored, and
  protected. Every third-party alternative considered needs exactly that
  extra secret; SES makes the question disappear.
- **One KMS-protected root secret, purpose-specific keys derived from it
  app-side via HKDF** (`derive(rootSecret, "email-hmac")`, later
  `derive(rootSecret, "push-token-decrypt")`, etc. as new purposes show
  up) — same hierarchical-key pattern the app's own `generateSeedPhrase()`/
  `saveMasterSeed()` already intends for circle keys, just applied
  server-side. One-way in one direction only: root → derived is cheap and
  intended (that's the whole point), derived → root or derived →
  sibling-derived is computationally infeasible with a proper KDF (HKDF).
  Only one thing is ever KMS-encrypted (`server/provision/kms.tf`'s
  `random_id.root_secret`) regardless of how many purposes exist —
  cheaper to operate than one KMS-encrypted secret per feature (KMS
  bills per-key, no free tier), and a leaked derived key doesn't expose
  the root secret or any other purpose's key. `internal/crypto` is the one
  place this derivation happens; nothing else is allowed to compute a
  purpose key by hand.
- **Even the operator's own code shouldn't read the master key** — the
  actual protection needed is against the operator's *normal* code path
  (or a compromised Lambda), not just external attackers, since the
  operator otherwise has unrestricted plaintext access to anything a
  key merely "at rest encrypts." Real fix: an attestation-gated KMS key
  (AWS Nitro Enclaves) — KMS releases the key only to a process that
  cryptographically proves, via hardware attestation, it's running the
  exact published, unmodified code. Same technique Signal uses for
  contact discovery (SGX/Nitro), applied here to phone-HMAC derivation
  and push-token decrypt-and-send specifically — not the entire request
  path, which would balloon the trusted boundary for no reason.
- **Honest ceiling, not a loophole to pretend away**: the operator
  typically retains rights to edit the KMS key policy itself, so
  "can't bypass attestation to decrypt directly" doesn't mean "can never
  get the data," it means "can't get it silently" — changing the policy
  is a visible, auditable action (more so with the server already open
  source), not an invisible one. Full protection against the operator
  needs the policy-edit right itself given up permanently, which isn't
  realistic for a solo-maintained project without losing the ability to
  operate your own infrastructure. This is the actual, practical ceiling
  for anything short of Signal's org-scale, multi-party-governance model
  — worth being honest about rather than overselling the enclave as
  absolute.
- **Trust model for this app's real audience isn't the same problem
  Signal solves anyway.** Signal's enclave apparatus targets strangers
  who need institutional trust with no personal relationship to fall
  back on. This app's initial audience — family, close friends — starts
  from a place of already trusting the person building it. The blind
  content design alone is already a stronger privacy story than most
  mainstream apps; the enclave-grade "protect against the operator too"
  layer is worth building deliberately, later, once real user count and
  stakes justify the engineering — not a prerequisite before the core
  product works.
- Env vars are **not** a substitute for any of this — a Lambda env var is
  readable by any normal code running in that function, no attestation
  gate at all. Fine for values the server is *supposed* to read freely
  (`TABLE_NAME`, `BUCKET_NAME`, already env vars); wrong for anything
  meant to be hidden from the server's own normal code path.
- Abuse mitigation that doesn't need any of the above: cheap infra-level
  bounding, not identity-based prevention — a Lambda reserved-concurrency
  cap plus an AWS Budgets alert. Identity-based defenses don't actually
  stop a scripted attacker here, since minting a new device identity is
  free and instant either way; the concurrency cap + budget alert turns
  "could cost millions" into "costs a bounded, known ceiling and I get
  paged," regardless of how many fake identities are involved. **Not yet
  provisioned** — no `reserved_concurrent_executions` is set on the
  Lambda and no `aws_budgets_budget` exists in Terraform today, so
  nothing currently bounds a real spend spike. The concurrency cap is a
  real-time, self-recovering throttle (AWS rejects new invocations past
  the ceiling, no code involved); the budget piece is an alert only
  unless paired with AWS Budget Actions, which can automatically attach
  a deny-policy to the Lambda's own execution role past a threshold —
  blunt (it can't tell an abusive account from a legitimate traffic
  spike, and takes down the service for everyone either way), but a real
  automated stop if wanted instead of a page.
- **No per-account rate limiting either** — `RequireSession` only checks
  "is this a valid signed-in account," not how fast that account is
  calling. The concurrency cap above bounds aggregate cost but not one
  account crowding out others. Deferred for the same reason: not worth
  building before there's real concurrent multi-user traffic for a
  "noisy neighbor" to actually degrade. When it is built, the window
  needs to be day-scale, not minute-scale — `drainOutbox` flushes a
  device's backlog sequentially but as fast as the network allows, so a
  device back online after two offline weeks can legitimately fire
  dozens of `appendEntry` calls within a minute or two. A per-minute
  limiter would mistake normal catch-up sync for abuse; a generous daily
  cap (sized to plausible worst-case human-paced backlog) still catches
  sustained scripted abuse without breaking it.

## Account recovery (not built)

The master seed already exists (`generateSeedPhrase()`/`saveMasterSeed()`)
and is already framed in the UI as the way back into your circles
(`account/recovery.tsx`, `signOut()`'s own doc comment) — but nothing today
actually makes that true. Circle identities and secrets are pure-random
(`generateIdentity()`, `generateCircleSecret()`), not derived from the seed,
so having the 12 words back doesn't currently let you regenerate a lost
circle's keys. This section is what closes that gap.

**The audience rules out "write down 12 words" as the primary path.** This
isn't a self-selected crypto-wallet audience opting into self-custody — it's
family photo sharing, likely including people who will never back up a seed
phrase, ever. Recovery has to happen automatically, as a side effect of
something people already do (getting a new phone, signing back in), not as
an opt-in chore. The phrase stays available as a manual/portable fallback,
never the primary mechanism.

**Rejected: PIN + server-side escrow, even with real hardware attestation.**
A memorable PIN (4-6 digits) is too low-entropy to protect with encryption
alone — a KDF only raises the cost of brute force, it doesn't make brute
force infeasible against that few possibilities. Making a PIN actually safe
needs an attempt counter enforced somewhere the operator can't bypass even
with full access to the stored data — an AWS Nitro Enclave with an
attestation-gated KMS key, the same class of investment "Email auth" above
already defers for the (simpler) email-HMAC secret. Building it here first,
for something more sensitive than an account identifier (every circle
identity a person has), would be inconsistent. It also can't run on
Lambda — Nitro Enclaves need a standing EC2 host, the first non-serverless
piece of infrastructure this project would take on. Deferred, not rejected
outright: worth it once real user count and stakes justify the same enclave
investment already deferred elsewhere, not before.

**Also rejected: deriving a recovery key from the account's email/full
name.** Sounds like a simplification, isn't one — email and full name
aren't secrets, they're identifying information, often literally public
(a person's name is the exact "Seller" field Apple puts on an App Store
listing for an Individual account). Anyone targeting a specific person's
account typically already has both. This is the same failure mode "security
questions" (mother's maiden name, etc.) were deprecated industry-wide for —
weak is "guessable in bounded tries," this is "not a secret at all."

**Chosen: make the seed do the crypto work, make the relay remember the
index.** Two separate problems were tangled together in earlier drafts of
this section — regenerating your *keys* from the seed, and knowing *which
circles* to regenerate keys for — and they have very different answers.

**Regenerating keys needs nothing from the relay.** Circle **identity**
(the Ed25519 keypair) becomes deterministic: `HKDF(masterSeed,
"circle-identity" || circleId)` instead of `generateIdentity()`'s pure
randomness. Recovering the seed regenerates the exact same public key you
had before — same identity, not a new device asking to be let in. Circle
**secrets** stay random and rotatable (determinism and rotation are
incompatible, and rotation-on-kick from section 1 above has to keep
working) — a recovered device gets its secret back the same way any
returning device would: replay the circle's log from epoch 0, find the
"secret rotated to me" event already encrypted to your now-recoverable
public key, decrypt it. This is a pure client-side change; the relay is
neither involved nor aware.

**Knowing which circles to even look for is the part that needs somewhere
durable to live**, and the relay already is that somewhere: it's the one
party both your old and new device always talk to, present or not. A
plain per-account table — `accountId → {circleId, ...}` — updated on every
join/create/leave, kept forever until the account itself is deleted, no
TTL. New tiny endpoint, `GET/POST/DELETE /v1/account/circles`, behind the
same `auth.RequireSession` middleware the circle-log routes already use.

This is deliberately *not* encrypted, unlike the log content itself, and
that's a real departure from the relay's stated "infer as little as
possible about circle membership" property at the top of this doc — worth
being honest about rather than dressing it up. The mitigating fact: the
relay already sees the same membership in real time, unencrypted, every
time an authenticated device calls `fetchentries`/`appendentry` for a
circleId — a durable table doesn't hand it new information, just persists
what request logs already reveal moment-to-moment. Encrypting the list
(the earlier drafts' `HKDF(masterSeed, "recovery-manifest")` idea) would
protect a data-at-rest snapshot without protecting the exact same fact
already visible in transit, for meaningfully more code — not worth it
unless the access-pattern leak itself gets closed first.

**What this drops from earlier drafts, on purpose**: no Drive/CloudKit
integration, no per-platform backup blob, no "iCloud/Drive unavailable"
detection-and-fallback flow. Those solved a problem — automatically
backing up the *seed itself* — that's still real but is now decoupled and
optional: the seed remains something only the user's device holds, via the
manual recovery-phrase screen already built (`account/recovery.tsx`). If
that phrase is never written down and the device is lost, the seed is
genuinely gone — same as today — and the plain circleId table can't help
without it. Automatic seed backup to Drive/CloudKit is still a legitimate
future enhancement, but it's additive to this design, not required to make
the seed useful.

**Recovery, end to end**: sign in (Apple/Google) → same account, so
`GET /v1/account/circles` returns the circleId list → enter the recovery
phrase (manual, for now) → derive each circle's identity from the seed →
replay each circle's log from epoch 0 → recover each circle's current
secret from its rotation history → restored. No other circle member's
help needed.

**Caveat this does *not* solve: content older than the relay's retention
window.** Recovery restores keys and access, not history. The relay is a
transient sync cache (`LOG_RETENTION_DAYS`, 14 by default — see the TTL
eviction design in section 1), not the source of truth for old photos;
each device's local SQLite is. A lost device's content that's aged out of
the relay's window is gone unless another member's device still has it
locally and peer-to-peer backfill exists to pull it from them — which it
doesn't yet (`pullCircle`, the local `circleLog` mirror table, is listed
as not built at the top of this doc). Recovering an account today means
continuity of identity and everything still in the relay's live window,
not a guaranteed full photo history back.

**If plain email sign-in is ever added** (see "Explicitly rejected" below
for why it isn't today): the account-circles table works identically —
it's keyed off whatever the session already resolves to, Apple/Google
account or otherwise. The seed itself is the only piece that would need a
different backstop, since there's no platform account to eventually hang
an automatic backup off of; emailing the phrase to that same address at
generation time (reusing whatever OTP infra email auth needs anyway) is
the fallback, weaker than a real backup and should be presented as such.

## Explicitly rejected

- **Contact discovery / search.** Would require a real server-side
  directory matching uploaded contact lists against registered users — a
  categorically bigger, more sensitive piece of infrastructure than
  phone-verified auth alone (that's self-registration; this is uploading
  *other people's* phone numbers who never consented to anything). The
  privacy-preserving version of this specifically needs Signal's
  SGX/Nitro-enclave-based Contact Discovery Service, not a bolt-on. Stays
  rejected independent of the phone-auth decision above — simply picking
  someone from local contacts to send them an invite link via the native
  share sheet needs none of this (no server involvement at all) and
  isn't part of this rejection.
- **Any-admin invite approval.** See Invites section above — real plumbing
  cost for a speculative benefit that already has a free workaround.
- **Circle-level (shared) mailbox for content delivery.** Superseded by the
  per-circle log design above, which solves replay/history correctly
  instead of trying to force it through N ephemeral per-member copies.
- **Plain email/OTP as a user-facing sign-in method.** Distinct from the
  `emailHmac` *mechanism* "Email auth" above already builds for spam
  resistance under phone auth — this is about letting someone sign in with
  only an email address, no Apple/Google account behind it. The
  account-circles table in "Account recovery" above works the same either
  way, but the recovery *phrase* itself loses its only real backstop: with
  Apple/Google there's at least a path to eventually back the seed up to
  Drive/CloudKit automatically; an email-only account has no platform
  account to ever hang that on, just the strictly weaker "email the phrase
  at generation time" fallback. Not worth the permanent ceiling on
  recovery strength for the convenience of one fewer tap.
