# Sync & key management design

Status: **design only, not built.** Supersedes `DESIGN.md` section 1's
TTL-based framing wherever they conflict (`DESIGN.md` not yet updated).

Read order: **invariants** (the rules that must never be negotiated away),
then **operations** (the spine), then **extending this design** (how to add
things without re-architecting). Rationale is at the end.

---

## Invariants

These are load-bearing. A feature that requires breaking one is a signal
the architecture is wrong for it — not a signal to bend the rule.

1. **The log is append-only. Entries are immutable, forever.** Never
   mutate, never rewrite, never strip a payload. Signatures cover the
   payload (mutation makes an entry permanently unverifiable), replay must
   be deterministic (a device that synced yesterday must hold the same
   entry as one syncing today), and immutability is what makes "once you
   have entry E you have it correctly forever" true — no invalidation, no
   re-fetch, no staleness.
2. **Mutability is exactly three-tiered**, and it follows the plane split:

   | | mutability |
   |---|---|
   | data plane (log entries) | **append-only, immutable** |
   | control plane (`#control`) | mutable current state |
   | blob store | mutable in place (overwrite avatars/cover); never deleted |

3. **The relay enforces possession, never identity.** It is blind; it can
   check "you hold the current capability," never "you are an admin."
4. **Clients enforce identity and role**, verified cryptographically
   against their own replayed state.
5. **Default-deny.** Unknown entry type, bad signature, failed predicate,
   type-in-wrong-namespace → discard. Never accept because unrecognized.
6. **Everything is derivable from (seed + log).** No state that exists only
   on one device. If a feature needs device-only state, it's unrecoverable
   and violates the architecture.
7. **Projections are disposable.** Every local table must be rebuildable by
   replay. The log is the only truth.
8. **Applying an entry twice is a no-op.** Sync redelivers; that must be
   harmless.
9. **Content and meta epochs are never compared.** No cross-namespace
   ordering. (Post validation is *set membership*, not timeline position —
   see below.)

---

## Primitives

**Identifiers**
- **`syncId`** — random, relay-facing circle address. Not derived from any
  key. Stable forever.
- **`circleId`** — local SQLite id. Never sent to the relay. Roots identity
  derivation.

**The two namespaces** — plain sort-key prefixes, `meta#` and `content#`:
- **meta** — *everything content depends on in order to be interpreted*:
  identities, keys, roles, circle metadata. Rare. **Always synced eagerly,
  in full.**
- **content** — posts, comments, reactions, tombstones. Voluminous.
  **Lazily paged, newest → oldest.**

An earlier draft used opaque random tags so the relay couldn't tell which
namespace was which. Dropped: it bought nothing durable — the `rotate`
operation pairs a meta append with a token swap, so the first removal
reveals it regardless, and access patterns (one stream small and always
read in full, one large and paged) leak it before that. Meanwhile it cost
two more values per circle to generate, store, hand to joiners, and carry
in discovery rows, plus unreadable prefixes in logs. Nothing in the
security model rested on it. What *does* stay hidden is the part that
matters: the relay sees "a meta entry" but never `member_added` vs
`key_rotation` vs `profile_update` — types live inside the ciphertext.

"Meta" is defined by *content depends on it*, not by *admins write it* —
which is why a member's own `profile_update` belongs there.

**Keys** (Keychain; all rooted in the master seed)
- **master seed** — the recovery phrase's entropy.
- **circle identity** — Ed25519 (signing) + X25519 (sealing), derived from
  `(seed, circleId)` via different HKDF domains.
- **content-key map `{v → K_v}`** — every version this member holds. `K_v`
  is *shared* by all members of that version.
- **authority key** (admins) — Ed25519, derived from the admin's *own*
  `(seed, "token-authority"‖circleId)`. Private half never leaves them.
- **`writeToken_v = HKDF(K_v, "relay-write-token")`** — shared append
  credential; everyone with `K_v` computes the same one. The relay stores
  only its hash.

**Relay storage**
```
Log table, one partition per syncId:
  sk = "#control"        → { authoritySet, writeTokenHash,
                             counters: { meta: n, content: m } }
  sk = "meta#" + <e>     → member_added | key_rotation | role_change |
                           profile_update | circle_renamed
  sk = "content#" + <e>  → post | comment | reaction | delete

Blobs (S3, permanent, Glacier-IR tiered):
  {syncId}/content/{postId}        post photos (postId client-generated)
  {syncId}/avatar/{memberPubkey}   avatars
  {syncId}/cover                   circle cover

Discovery (was the `accounts` table — rename it):
  pk = discoveryId, sk = circleId → { syncId }   (client-encrypted)
     discoveryId = HKDF(seed, "account-discovery")
```
Each namespace is its own contiguous sequence with its own counter, both
held in the single `#control` item. Only the two known prefixes are
accepted; an append naming anything else is rejected.

**Entry shape**
- Plaintext (relay sees): `{ epoch, keyVersion, receivedAt }`
- Inside the ciphertext: `{ type, payload, authorPubkey, signature }`

---

## Authorization

**Two planes.** The relay never sees entry types, so it cannot key off
them. It keys off **which operation the client invokes**:

| relay operation | relay checks |
|---|---|
| **append** (any entry, either namespace) | write token *(counter bump rides along)* |
| **rotate** (append + token swap, atomic) | write token **+ authority signature** |
| **authority change** (add/remove key) | authority signature |

- **Write token** = *"may I append?"*
- **Authority signature** = *"may I change the rules?"* — and the rules are
  exactly two discretionary fields: **`writeTokenHash`** (key change) and
  **`authoritySet`** (set change). Nothing else requires it. Counter bumps
  mutate `#control` too, but they're mechanical consequences of an
  authorized append, not discretionary changes, so they ride on the write
  token.

**The relay has no destructive operations.** It appends, and it mutates
those two control fields. It never deletes an entry or a blob. This keeps
the append-only premise whole rather than carving an exception into it, and
removes a class of risk entirely: no admin can destroy shared content
server-side, so there's no orphaned-blob cleanup, no "which namespaces are
deletable" flag, and no way to brick a circle by removing key material.

**Lying about the operation gains nothing.** Append a rotation-shaped entry
via plain `append` to dodge the authority check → the entry lands but **no
token swap happens**, and clients discard it as not-admin-signed. Inert.
Call `rotate` without an authority signature → rejected.

**Namespace ≠ permission.** The namespace determines *sync behavior*; the
entry type determines *who may write it*. Every finer rule is a
client-side per-type predicate:

| entry | may be written by |
|---|---|
| `post`, `comment`, `reaction` | author ∈ ever-member set |
| `delete` | signer == target's author, **or** an admin |
| `member_added` | an admin at that point in meta's order |
| `key_rotation` | an admin at that point |
| `role_change` | an admin at that point |
| `circle_renamed` | an admin |
| `profile_update` | **signer == subject** (you may only change yourself) |

Note `member_added` is an admin-only action the **relay does not gate at
all** — it's a plain append, enforced solely by clients at replay. A forged
one is simply discarded.

---

## Operations

### 1. Create a circle
1. Generate `syncId`, `circleId`, `K_1`. Derive circle identity and
   authority key from the founder's seed.
2. → **Relay** (bootstrap, self-signed by the authority key): register
   `syncId`, `#control = { authoritySet:[founder], writeTokenHash:
   hash(writeToken_1), counters:{meta:0, content:0} }`.
3. → **meta**: `member_added(founder)` with sign + seal public keys, `K_1`
   sealed to the founder's own X25519 key. Signed, encrypted under `K_1`.
4. → discovery row `(discoveryId, circleId → {syncId})`, client-encrypted.
- **Relay learns**: an address, one authority key, a token hash.

### 2. Post
1. **Upload the blob first** to `{syncId}/content/{postId}` — `postId` is a
   client-generated UUID, deliberately *not* the relay-assigned epoch,
   which isn't known until the append lands and can't be guessed without
   racing other writers. Encrypted under `K_v`.
2. Then append the entry `{payload, authorPubkey, signature}`, encrypted
   under `K_v`, plaintext `keyVersion`. No author name is carried — it
   resolves live from `circleMembers` at render time.
- **Ordering matters, and the asymmetry is severe because the log is
  immutable**: blob-then-entry fails into an *unreferenced blob* — nothing
  points at it, it renders nowhere, invisible garbage. Entry-then-blob
  fails into a *dangling reference*: a permanent entry pointing at a photo
  that doesn't exist, which can't be mutated or deleted (invariant 1), so
  the post is broken forever, for everyone, on every device that syncs.
- **[relay checks]** write token → `ADD` the content counter → put entry.
- **Relay learns**: an entry in the content namespace, plus a blob.

### 3. Read / sync
**Meta — eager, always complete:**
1. Query `meta#` since `metaCursor` → apply in order: update
   `circleMembers`, roles, circle metadata; for each `key_rotation`, verify
   the admin signature and open *your own* wrap → add `K_{v+1}`.
2. Loop until `maxReceived == counters.meta`.

**Content — lazy, paged backward:**
3. Query `content#` `before=X, limit=N` (descending).
4. **[client]** decrypt with `K_[keyVersion]` (you hold every key from step
   1); verify signature; check the per-type predicate; render.
- **Why meta must be complete first**: every content entry needs its
  decryption key *and* its author's identity, both of which live in meta.
  That's what makes backward paging safe — you can never land on a post
  whose key or author you're missing.
- **Completeness is epoch-walking against a counter**, not page
  exhaustion: advance the cursor to `maxReceived`, never blindly to the
  counter (guards against a truncated relay response).
- **Post validation is set-membership, not timeline position**: check the
  author against the **ever-member set**. A removed member's past posts
  stay valid — removal doesn't erase history — and it means content and
  meta epochs never need to be comparable.

### 4. Add a member (no key rotation)
1. Requester submits a join request with a one-time keypair.
2. Approver (an admin — the invite's creator) **syncs first**, then seals
   the **underivable minimum** to that key: `{ K-map, syncId, circleName }`.
3. → **meta**: `member_added` with the new member's sign + seal public
   keys, signed by the approver.
4. Joiner derives their identity from *their own* seed, writes their own
   discovery row, then **walks meta from epoch 0** to build the roster, identities, and roles themselves.
- **Handoff carries only what cannot be derived.** The K-map is
  structurally underivable (pre-join rotations contain no wrap for the
  joiner); everything else is derived. This keeps the payload from scaling
  with member count and lets the joiner *verify* history rather than trust
  a summary.
- **No rotation** — adding grants access, revokes no one.

### 5. Remove a member (rotates the key)
1. Admin **syncs meta first**, generates `K_{v+1}`, seals it to each
   remaining member's X25519 key from the **current roster** (the in-order
   fold) — never the ever-member set, which would hand the key to people
   already removed.
2. → **rotate** (one atomic transaction): **[relay checks]** write token
   **and** authority signature → append `key_rotation { v+1,
   removedPubkey, wraps[] }` (signed, encrypted under `K_v`) → swap
   `writeTokenHash`.
3. Removed member: no wrap → can't read forward; can't compute the new
   token → can't write. Honest lagging members get a bounced write, treat
   it as "sync, retry."

### 6. Promote an admin
1. Promotee publishes their authority **public** key via a signed meta
   entry.
2. → **one atomic transaction**: add the key to `#control.authoritySet`
   (**[relay checks]** signer ∈ set) **and** append `role_change`. Never
   one without the other — divergence between `#control` and meta can brick
   writes (relay accepts a swap whose rotation entry every client
   discards).
- **No key material moves and no roster handoff** — the promotee
  self-derived their authority key and already holds the roster and K-map
  from ordinary eager meta sync. Promotion grants *authority*, not data.

### 7. Demote an admin
1. → **one atomic transaction**: remove the key from `authoritySet`
   (**[relay checks]** signer ∈ set) **and** append `role_change`.
- **Guard: never remove the last authority key.** Otherwise no one can ever
  rotate, promote, or remove again — governance is permanently bricked.
- **Demote ≠ remove**: they stay a member, no content-key rotation.
- **Irreducible race**: A-removes-B vs B-removes-A are both validly signed;
  first to land wins. No protocol adjudicates equals.

### 8. Account recovery (new device)
1. Sign in with **any** provider account → a session. Which account is
   irrelevant; it's only a bearer credential.
2. Phrase → seed → `discoveryId = HKDF(seed, "account-discovery")` → query
   that partition → one row per membership: `circleId` (the sort key) and
   an encrypted `{syncId}`.
3. Per circle: derive identity from `(seed, circleId)`; decrypt `syncId`.
4. **Walk meta from 0** → roster + full K-map (open your own wraps).
5. Page content lazily as browsed.
- **The discovery address is derived from the seed, not the account**, so
  the phrase alone is sufficient — you can recover onto a brand-new
  provider account. Keyed by `accountId` instead, losing your Google/Apple
  account would lock you out *even holding the phrase*, since `syncId`s are
  random and can't be re-derived.
- **This is a fix, not a refactor.** Recovery cannot complete in the
  current code: the manifest stores `circleId`s, but reaching a log needs
  `deriveCircleLogId(secret)`, and the circle secret lives only in the
  Keychain and dies with the device. Storing `syncId` directly — decoupled
  from key material — is what makes recovery work at all.
- **Why this row is irreducible**: `syncId` is random *and* shared across
  members who each hold different seeds, so it is the one piece of state in
  the design that cannot be derived. Permanence solves *durability*;
  discovery solves *bootstrapping*. Without it a sole founder who loses
  their device loses the circle permanently, while the relay holds every
  photo intact and unreachable.
- **`accountId` has zero user-data associations.** No `provider` field, no
  account-keyed storage — nothing at rest links your identity provider to
  your circles. Only live request patterns do, which is already named and
  accepted.

### 9. Change your name or avatar
- One entry type: `profile_update { pubkey, name?, avatarChanged? }`,
  signed, in meta. Predicate: **signer == subject**.
- **Avatar**: overwrite `{syncId}/avatar/{yourPubkey}` with a new
  self-signed encrypted blob, **and** append the `profile_update`. The
  entry carries no pointer and no image — location stays a pure function of
  the pubkey; the entry is purely an *invalidation signal*.
- **Why the signal is free**: everyone already syncs meta eagerly, so it
  rides along — no polling, no ETag bookkeeping, exact attribution, correct
  ordering. Refetch is **lazy**: mark stale, fetch when that member next
  renders.

### 10. Delete content
- **Append a tombstone. That is the only log operation.** The original
  entry is never mutated (invariant 1).
- **Predicate**: honor only if `tombstone.authorPubkey ==
  target.authorPubkey`, or the signer is an admin.
- **Author delete** → tombstone; all clients purge their local copy and
  render "deleted." The relay is not involved.
- **Admin delete** → tombstone **+** relay deletes the blob (authority
  signature). The entry and its caption ciphertext remain — unreadable to
  the relay, and already held by everyone who could decrypt it.
- **Cascade**: a deleted post hides its comments and reactions.
- **Nice property**: tombstones have a *higher* epoch than their target,
  and content pages backward — so a device that hasn't seen the post yet
  encounters the tombstone **first** and never downloads the photo at all.
  (This is also why "jump to an arbitrary old post" must never be added —
  it's the one access pattern that could reach content without passing its
  tombstone.)

---

## Extending this design

**The checklist for any new feature:**
1. **Which namespace?** If clients need it *before* they can interpret
   content → meta. Otherwise content.
2. **What's its authorization predicate?** State it as a client-checkable
   rule on the signer.
3. **Does the relay need to enforce anything?** It must be expressible as
   **possession of a capability**. *If it can't be, stop* — that's the
   tripwire.
4. **Idempotent?**
5. **Rebuildable by replay?**
6. **Derived rather than stored?** Prefer `f(seed, stable-id)` over stored
   randomness.
7. **Do old clients discard it safely?** (default-deny)

Adding a type should mean **adding a row to the predicate table** — not
adding a mechanism.

**Tripwires — if you need these, the architecture is wrong for the
feature:**
- **The relay knowing identity** (per-member rate limits, read ACLs,
  "only Alice may X" enforced server-side). Blindness supports possession
  only.
- **Global ordering across namespaces** — anything needing "was X true at
  the instant of this post."
- **Mutable shared server state with multiple writers** — lost updates,
  divergence, and an authorization problem the relay can't solve.
- **Mutating the log** — see invariant 1.
- **Server-side content queries or search** — the relay can't read
  anything.
- **True erasure of data others already hold** — impossible in E2E; the
  honest answer is always "honest clients purge."

---

## How it holds together

**The same plane split is also the visibility boundary.** The constraint
isn't "the relay learns nothing" — it's "nothing *about people or
content*." Structural facts are fine, and some are required:

| | authorization | visibility | mutability |
|---|---|---|---|
| control plane | relay enforces | relay **sees** | mutable |
| data plane | clients enforce | relay **never** sees | append-only |

- **Deliberately visible, load-bearing**: token swaps (revocation *works*
  because the relay sees the credential change), `authoritySet`,
  `writeTokenHash`, `syncId`, registered tags, counters, `keyVersion`.
- **Side-effect visible, accepted**: per-namespace counts and timing,
  approximate member count, blob sizes, and which namespace an entry is in
  (meta vs content — see the note under Primitives).
- **Never visible**: content, entry types, who authored what, who was
  removed, key material.

**Two projections from meta — never conflate:**

| | built by | behavior | used for |
|---|---|---|---|
| **current roster** | in-order fold | **shrinks** on removal | sealing rotations, member list, roles |
| **ever-member set** | union of adds | **never shrinks** | validating post authorship |

Both live in `circleMembers`, maintained **incrementally** (a full fold
only on first sync or recovery). **Removal marks the row rather than
deleting it**, so one table serves the current roster, the ever-member set,
*and* the retained name/avatar that attributes departed members' old posts.

**One identifier, four jobs.** A member's circle pubkey is what signatures
verify against, the `circleMembers` row key, the avatar path segment, and
the cache slot. It's on every post — so everything about an author resolves
from the post itself.

**Avatar resolution — one rule.** `{syncId}/avatar/{authorPubkey}`, a pure
function of what you already have.
```
post → authorPubkey
  → circleMembers[authorPubkey].picture         (cache hit → render)
  → miss/stale: GET {syncId}/avatar/{authorPubkey}
      verify in-blob signature against authorPubkey
      decrypt (blob self-declares keyVersion), cache, render
  → placeholder while fetching, on verify failure, or if never set
```

**Text → the log. Images → deterministic self-signed blob keys.**

| | text (log entry) | image (deterministic blob) |
|---|---|---|
| member | `profile_update{name}` | `{syncId}/avatar/{pubkey}` |
| circle | `circle_renamed` | `{syncId}/cover` |

**Both resolve live**, and consistently: a post carries only
`authorPubkey`, so the name comes from `circleMembers` and the image from
its deterministic key — change either and every post of yours updates. An
earlier draft denormalized `authorName` onto each post, which was needed
back when a backward-paged post might reach a member whose `member_added`
hadn't loaded. Eager meta sync removed that need, and dropping it also
removed an odd asymmetry (names frozen, avatars live). The image's
*location* is always a pure function; the log entry is only a *change
signal*.

**One profile, many keys.** A person has a single local profile but a
distinct pubkey per circle, so their picture is uploaded once per circle.
That duplication is required: a single global avatar location would let the
relay link memberships. Each circle encrypts its copy under its own `K_v`,
so even the ciphertexts differ — byte-identical blobs would otherwise be a
correlation vector.

**Current snapshot without replaying.** For an existing member this already
holds — `circleMembers` and `circles` are maintained incrementally, so
opening a circle is instant. Cold starts are joining (walks meta once,
cheap) and recovery (walks meta once, deliberate). Deliberately *not* a
relay-side mutable snapshot: that reintroduces write-authorization and
divergence problems for little gain.

**Discovery: partition per person, row per membership.**

```
pk = discoveryId          ← HKDF(seed, "account-discovery")
  sk = circleId-A → enc{ syncId-A }
  sk = circleId-B → enc{ syncId-B }
```

- **Join** inserts one row; **leave** deletes one. No read-modify-write, so
  two of your devices changing membership at once can't clobber each other
  — the same lost-update reasoning that killed the roster blob.
- **"Get all my circles" is one `Query` on `pk`** (no sort-key condition),
  which is the cheapest access pattern DynamoDB has. Rows cost nothing
  extra over a single blob: reads bill per 4KB, not per item, so a dozen
  tiny rows land in the same read unit — and writes get *cheaper*, since a
  row needs no preceding read.
- **What's plaintext is chosen deliberately.** A sort key must be readable
  to be queryable, so something is exposed — and `circleId` is the right
  thing, because it's a random local value used in no other relay-visible
  request. The relay can't join it against anything, and knowing it doesn't
  weaken `deriveCircleIdentity(seed, circleId)` since the seed is the
  secret. `syncId` is the meaningful value, so it's the encrypted one.
  Putting `syncId` in the sort key would link your partition straight to
  specific circles.
- **`accountId` now has zero user-data associations.** No `provider` field,
  no account-keyed storage — it's purely a bearer credential. Drop
  `recordSignInProviderBestEffort`; with a seed-derived address, any
  provider account works, so the hint gates nothing.

**Privacy posture.** Per-circle identities **silo** metadata — each leak is
scoped to one unlinkable circle. The remaining cross-circle signal is
discovery, and it's now much narrower than it was.

Be precise about what its encryption buys: values are encrypted under
`deriveManifestKey`, so a **static dump or subpoena** does not reveal the
membership graph — it yields a partition of opaque ids and ciphertext. It
does **not** hide membership from an *actively logging* relay: an
authenticated device requesting entries for a `syncId` reveals the
association in real time regardless. Keep it (a passive dump is a real and
distinct threat), but don't over-claim it. The relay does learn **how many
circles you're in** (row count). The same encryption is why it can never
select those rows by circle, which is what leaves orphaned rows as
unreachable dust.

**Recovery floor.** Any top-of-hierarchy compromise can *freeze* writes but
cannot *destroy* — every device holds the full archive and all keys
locally. Worst case: re-found, re-invite, re-upload. The relay was never
the source of truth.

---

## Rationale (condensed)

**Nothing expires.** A 14-day log makes a family-archive product's central
promise false. S3 + Glacier IR makes "keep everything" single-digit
dollars/month at thousands of circles. Removing eviction deleted a lot of
machinery: gap detection, content-gap banners, a durable manifest, the
picture/post prefix split.

**Per-member key wrapping, not one shared secret.** A shared secret had no
clean removal story. Versioned keys sealed per-member, rotated only on
removal: removal is one entry, omission is revocation, history untouched.
This is why `syncId` is decoupled from key material — rotation must never
change the circle's address.

**No roster table.** An earlier draft had one; it was a cache of what meta
replay already gives you, and it brought write-authorization and divergence
problems. The meta namespace *is* the source; `circleMembers` is a local
projection.

**Two namespaces + per-namespace counters.** The eager/lazy split needs
cheap meta-only queries, which needs the relay to separate the ranges —
worth it because a Query bills for what it *reads*, so filtering meta out
of a mixed stream would cost as much as reading every post. Per-namespace
counters keep each range a clean contiguous epoch-walk against its own
counter. The prefixes are plaintext (`meta#`/`content#`) — see Primitives
for why opaque tags weren't worth their cost.

**Per-admin authority keys.** Each admin derives their own from their own
seed; the relay holds the set of public halves. Promotion adds a key,
demotion removes one — no key material moves, each admin recovers their own
from their own phrase. Today the set holds just the founder's.

**Discovery replaces the account manifest.** The old `accounts` table held
one document per account, `{circleIds, provider}`. Two problems: the array
needed read-modify-write (lost-update race across your own devices), and
the stored `circleId`s were useless for recovery anyway — reaching a log
also needed `deriveCircleLogId(secret)`, and that secret lived only in the
Keychain and died with the device. So recovery could rebuild *who you are*
and then find nothing. Storing `syncId` directly, in rows, under a
seed-derived partition key, is what makes recovery work at all — and drops
the last account-keyed storage in the system.

**Table changes**: rename `accounts` → `discovery`; `pk` becomes
`discoveryId`; **add a sort key** (`circleId`) — it's hash-key-only today,
so this is a schema change, not just a new derivation. Client-side
encryption and KMS SSE both stay exactly as they are.

**DynamoDB.** Every access pattern is a point read or bounded range query —
no scans, no GSIs, no filters (which is exactly why the namespace split
matters: a Query bills for what it *reads*). Photos live on S3; the log is
tiny metadata, cheap to keep forever.

---

## Open issues

1. **Content-side sync bookkeeping.** Lazy paging can leave two disjoint
   synced ranges with an unwalked middle; needs a segment model. (Meta is a
   single always-caught-up cursor, so it's not part of this.)
2. **`logstore.Read` doesn't paginate** — one `Query`, no
   `LastEvaluatedKey`, silent 1MB truncation. Fix that, and advance client
   cursors to last-processed rather than to the counter.
3. **Concurrent rotations need a convergence rule.** Two admins removing
   different members near-simultaneously produce two entries claiming the
   next version. Likely: derive version from epoch order, later one void
   and redone — not settled.
4. **Phrase lost, account intact** → you can find nothing decryptable;
   that's inherent to E2E. Not total loss, though: a member can re-invite
   you and the handoff returns the full K-map, so history comes back — you
   lose only identity continuity (old posts stay attributed to your old
   pubkey). Worth surfacing in the UI as the real fallback.
   **Also verify the app actually shows users their recovery phrase** — if
   the seed is generated but never surfaced, recovery is theoretical no
   matter how well the protocol works.
5. **Voluntary leaving isn't designed.** Only admin-initiated removal
   exists; a member wanting out can't revoke their own access.
6. **Undefined behavior on a missing key version** (the stale-approver
   residual): skip, placeholder, or request from a peer?
7. **No quota or rate limiting.** Unbounded appends and uploads, permanently
   retained, with no way to rate-limit a specific member without identity.
8. **`#control` is the single write bottleneck** — every append is a
   conditional transaction on one item. Fine at family scale; concurrent
   posts cause transaction conflicts and retries.
9. **Nullable `posts.photo`** — lazy photos need the column nullable and a
   placeholder state audited across every renderer.
10. **Leave/rejoin = fresh identity** (`completeJoin` mints a new
    `circleId`). Fine by default; documented as deliberate vs. reusing the
    old id to make rejoining continuous.
11. **Circle deletion is a product question**, not just a mechanism: should
    one admin be able to tear down shared history? "Dormant forever" may be
    the more honest default.
12. **Metadata leaks, accepted and named** — see the visibility table.
