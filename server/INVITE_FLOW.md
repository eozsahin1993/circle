# Invite flow

Status: **built**, all 7 steps below — `app/src/domain/usecases/circle/join-circle.ts`
(requester side), `invite-to-circle.ts`'s `discoverPendingRequests`/`approveJoinRequest`
(creator side), `app/src/app/join/[code].tsx`/`join/pending.tsx` (deep-link
handling and UI), and `server/internal/storage/invitestore` +
`server/internal/api/invite` (the server-side table and routes this doc
calls the "mailbox"). One addition beyond what this doc originally
specified: the approval is also signed by the approver's own circle
identity and verified by the requester against `createdByPublicKey` (now
carried in the invite preview) — without it, any existing member who knew
the invite code and the circle secret could forge a valid-looking
approval, not just this invite's actual creator. **Still not built**:
`pullCircle` (see "What this flow depends on" below) — a fresh joiner gets
the secret and joins locally, but sees no history until that exists. This
doc captures the full design worked out for it, refining DESIGN.md's
"Invites" and "Mailbox" sections (3) into a concrete mechanism for this
one specific use of the mailbox concept. Read [README.md](README.md)'s
"Identity model" section first — this flow leans on `circleId`,
`circleLogId`, and the circle secret exactly as described there.

## Goals and constraints

- The relay never learns a circle's name, its membership, or who's
  inviting whom — same blind-relay property as everything else in this
  system.
- An invite code has **uncapped redemptions** (DESIGN.md's "Invites"
  section) — the same code can be shared in a group chat and used by
  several different people, not just once.
- Every join requires **explicit approval by the invite's specific
  creator** — never "any admin," never automatic.
- **No dependency on push notifications working, in either direction.**
  Push, if built, can *accelerate* both directions of discovery here —
  notify the creator sooner that a request arrived, notify the requester
  sooner that they were approved — but manual/opportunistic sync must
  independently work end to end regardless of whether push ever fires,
  whether the platform delivers it, or whether the user has notifications
  disabled entirely. Same principle as the general push design: push is
  an enhancement layered on top, never the delivery mechanism itself.

## The two encryption schemes — don't conflate them

This flow uses two structurally different mechanisms depending on the
step. Mixing them up is the easiest way to get this wrong.

1. **Symmetric, code-derived** — used for the invite preview and the join
   request. The invite code itself has real entropy (60 bits) and can
   double as shared key material: `HKDF(invite_code, "<purpose>")`
   produces a key that **both the creator and the requester can compute
   independently**, just by knowing the code — no exchange needed. HKDF
   itself doesn't encrypt anything; it derives a key, which then feeds
   the same `encrypt()`/`decrypt()` (XChaCha20-Poly1305 AEAD) already used
   for circle content.
   - Anyone who has the invite code can decrypt anything encrypted this
     way — including, notably, *other* people who redeemed the same
     code. That's an accepted, minor leak ("who else is in the invite's
     waiting room"), not a security bypass — see below.
2. **Asymmetric, one-time keypair, sealed-box style** — used only for the
   approval response, the one payload that must be readable by exactly
   one person. The requester generates a fresh keypair just for this
   handshake and includes the public half in their join request. The
   creator, replying, generates *its own* fresh one-time keypair for this
   one message, uses it (via ECDH against the requester's public key) to
   encrypt the secret, and bundles its own ephemeral public key inside the
   response ciphertext itself. The requester needs only its own private
   key (already has it) plus what's inside the response to decrypt — it
   never needs to know any public key belonging to the creator in
   advance. No pre-shared creator identity is required anywhere in this
   flow.

## Storage: one table, two sort-key shapes

Reuses the generic "mailbox" idea from DESIGN.md section 3 (ephemeral,
tag-addressed, not circle content) but with a concrete shape for this use:

```
pk = hash(invite_code)
sk = "invite"              -- one per invite, written once at creation
sk = "request#<requesterId>"  -- one per requester, created by the requester
```

- **`sk = "invite"`**: written by the creator at invite-creation time —
  the one proactive server write in this whole flow. Contents: the
  circle's current name and the creator's own circle-identity public key
  (`createdByPublicKey` — see the approval-signing note above), encrypted
  with `HKDF(invite_code, "invite-preview")`. This is the trade-off
  explicitly made in this design: invite creation is no longer purely
  local, and the relay learns "this tag exists" before anyone's used it —
  accepted in exchange for letting a tapped link show "You're about to
  join: Family Circle" before the person commits to anything, rather than
  a blind join. A cover-photo thumbnail was considered for this row but
  deliberately dropped — deferred until circle-level "current state"
  (name/photo as of now, not as of invite-creation) has a real design,
  rather than bolting a one-off snapshot onto this payload ahead of that.
- **`sk = "request#<requesterId>"`**: created by the requester (their own
  randomly-chosen id, no coordination needed), containing `{ephemeralPub,
  selfReportedName}` encrypted with `HKDF(invite_code, "join-request")`.
  Later **updated in place** by the creator — not replaced with a new
  entry — adding the sealed-box-encrypted `{secret, circleName}` once
  approved. The creator queries `sk begins_with "request#"` to list every
  pending request under one invite at once (naturally handling multiple
  simultaneous redemptions of the same code); each requester only ever
  polls the one row whose id it chose itself, so there's no ambiguity
  about which response is its own even with several requests in flight.

TTL backstop (not yet specified in detail): a request row nobody ever
approves or acks should still eventually clean itself up — same
ack-primary/TTL-fallback pattern as DESIGN.md's mailbox section already
calls for, exact retention period undecided.

## The flow, step by step

1. **Create.** Creator generates the invite code (`generateInviteCode()`,
   already built) and writes the local `circleInvites` row (already
   built — code, circleId, createdByPublicKey, expiry). Additionally
   writes the server-side `sk = "invite"` row: the circle's current name,
   encrypted with the code-derived preview key.
2. **Share.** The bare code goes out via QR, the native share sheet, or
   read aloud — see DESIGN.md's "one secret, multiple presentations"
   note. Nothing else needs to travel with it; the creator's identity
   never needs to be embedded in the link at all (see the encryption
   section above).
3. **Tap.** Opening the link needs a deep-link handler that doesn't exist
   yet (no `expo-linking`/`Linking.*` usage anywhere in the app today).
   Once built: fetch `sk = "invite"` for `pk = hash(code)`, decrypt with
   the preview key, show "You're about to join: <name>."
4. **Request.** Device generates a one-time keypair, writes `sk =
   "request#<ownRandomId>"` containing `{ephemeralPub, selfReportedName}`
   encrypted with the join-request key. Locally, records this as a
   pending request — a new local table, not built yet (something like
   `pendingJoinRequests`: code, own keypair, circle name from the
   preview, submitted-at, status), so a "pending for Family Circle"
   screen survives the app being closed and reopened before approval
   ever lands.
5. **Discover.** Creator's device checks `sk begins_with "request#"`
   under invites it created — on ordinary app-lifecycle triggers
   (foreground, opening that circle), never dependent on push arriving.
   Decrypts each with the join-request key to read the self-reported
   name for the approval screen. Per DESIGN.md: that name is **not
   verified identity**, just "someone used the invite you created."
6. **Approve.** Creator signs `{secret, circleName}` with its own
   circle-identity secret key (the same keypair every post is already
   signed with), then updates that same row with a sealed-box payload —
   the signed envelope, encrypted to the requester's `ephemeralPub`.
   Signing wasn't in the original design here: without it, anyone who
   knew the invite code and the circle secret — any existing member, not
   just this invite's creator — could forge an equally valid-looking
   approval, since the seal alone only proves "sent to the right
   requester," not "sent by the right person."
7. **Complete.** Requester polls its own pending-request row — same
   app-lifecycle-triggered polling as step 5, never dependent on a push
   telling it "you've been approved" — decrypts with its own ephemeral
   private key once the secret field appears, gets the signed envelope,
   and verifies the signature against the `createdByPublicKey` it
   captured from the preview back in step 3. A signature that doesn't
   verify is treated exactly like no approval having arrived yet, not a
   fatal error — the pending row is left in place either way, so a later,
   legitimate approval can still land and succeed. Once verified,
   immediately saves the secret to Keychain under a freshly-generated local `circleId`
   (`saveCircleSecret(circleId, secret)` — before anything else, same as
   `createCircle` already does). From here, everything follows the
   identity model in README.md: derive `circleLogId` from the secret,
   derive its own circle identity from `(masterSeed, circleId)`, and pull
   the circle's history from epoch 0.

## What this flow depends on that isn't built yet

Named explicitly so this doc doesn't imply more is working than actually
is. Everything below except the pull side is now built — kept here as a
record of what used to gate this flow, not a current TODO list:

- **The pull side** (`pullCircle`) — step 7's "pull the circle's history"
  still has nothing to call. **This is the one real gap left.** It blocks
  the join flow from being fully useful: approval gets a new member the
  secret and lets them join locally (circle row, identity, roster entry,
  a pushed `member_added` entry), but they see no history — an empty feed
  — until `pullCircle` exists. The UI is honest about this (a "content
  will sync soon" banner on a freshly-joined empty feed) rather than
  pretending it loaded.
- ~~A `member_added`-equivalent log entry type~~ — built. `outbox.entryType`
  now includes `'member_added'`; `join-circle.ts`'s `completeJoin` enqueues
  one. Existing members won't actually *see* it until `pullCircle` exists
  (same gap as above), but the push side works today.
- ~~Deep-link handling~~ — built. `circle://join/<code>` auto-routes to
  `app/src/app/join/[code].tsx` via Expo Router's file-based routing and
  `app.json`'s existing `"scheme": "circle"` — no manual `Linking` code
  needed. A tap before sign-in/profile-setup is complete is handled too
  (`app/src/services/pending-deep-link.ts` remembers the code and resumes
  the flow once onboarding finishes).
- ~~The local `pendingJoinRequests` table~~ — built (`app/src/data/db/schema.ts`).

## Open questions not resolved in this doc

- What happens to a `request#` row if its invite is revoked or expires
  while the request is still pending? Not decided.
- Exact TTL for abandoned `request#`/`invite` rows.
- Whether a circle rename after someone's already joined needs its own
  log entry type (likely yes, eventually) — orthogonal to this flow,
  since a joiner only ever gets the name as of the moment they joined.
