# Relay server design

Status: **not built**. This documents the architecture decided in design
discussion, so it survives past a chat transcript. The `app/` codebase
currently only implements the local, single-device pieces (circles, posts,
members, roles, invite *creation*) — everything below involving cross-device
sync, push, or redemption does not exist yet.

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

## 2. Push notifications: thin, per-member, identity-sensitive

- Push is a wake-up nudge, never a payload channel. It carries no data —
  just "your circle moved past your epoch, go sync." The device pulls the
  actual log delta itself afterward.
- Relay holds one deliberate non-blind table: `routing tag → push token`.
  No names, no PII, no member list — just two opaque values.
- Routing tag = `HMAC(circle_secret, memberId)`, **per member**, not shared
  — unlike the log id. This matters specifically because push tokens are
  durable and tied to one real device; letting the relay link the *same*
  tag across multiple circles would let it correlate one person's presence
  across otherwise-unrelated groups. The log id doesn't carry that risk
  (no token attached to it), which is why it's allowed to be shared while
  the push tag isn't.
- Group "broadcast" is never a single push — it's N individual per-member
  push deliveries, one per derived tag, so the relay can't cluster them
  into "these N belong to one circle."
- True peer-to-peer push isn't achievable on iOS/Android — platform
  constraint, not a design choice. Has to go through APNs/FCM.

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

## Explicitly rejected

- **Contact discovery / search.** Would require collecting phone numbers
  (this app deliberately collects neither) and a real server-side directory
  — a categorically bigger and more sensitive piece of infrastructure than
  a blind relay, and it directly undermines `generateIdentity()`'s own
  purpose (fresh per-circle keys specifically to prevent cross-circle
  identity correlation).
- **Any-admin invite approval.** See Invites section above — real plumbing
  cost for a speculative benefit that already has a free workaround.
- **Circle-level (shared) mailbox for content delivery.** Superseded by the
  per-circle log design above, which solves replay/history correctly
  instead of trying to force it through N ephemeral per-member copies.
