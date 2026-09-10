# Mobile push design

Status: **design only, not built.** Zero implementation exists — no
`expo-notifications` dependency, no native extension, no relay endpoint.
The three toggles in the app's account screen (`notifyNewPhotos`,
`notifyCommentsReactions`, `notifyMemberJoined`) currently write
preferences nothing reads.

Supersedes `DESIGN.md` section 2, which reached the same broad shape
(routing IDs, device-side composition) but left the decisive question —
whether the fanout call is authenticated — unspecified, and assumed a
`routingId → pushToken` table whose stated shape contradicted itself. Read
that section for the original reasoning; this document is what to build.

## The problem

Show "Sarah commented on your photo" without the relay learning the circle
name, who is in it, or what was said. Push is table stakes for adoption,
so "don't do notifications" is not an answer.

Three constraints make it awkward, and every design decision below falls
out of one of them:

1. **The relay cannot read circle content.** So it cannot compose
   notification text, and cannot classify what happened.
2. **iOS cannot suppress a delivered notification.** Once an alert push
   arrives, a card appears. The Notification Service Extension can rewrite
   it but not cancel it. So recipients cannot filter on arrival — filtering
   has to happen before delivery.
3. **Devices cannot reach APNs/FCM themselves.** Only the relay can, which
   is why it has to be told who to deliver to at all.

## Identifiers

All derived client-side, all domain-separated the same way as everything
in `app/src/services/crypto.ts`:

```
routingId   = HKDF(masterSeed,          "push-routing" || circleId)
deviceId    = HKDF(deviceSecret,        "push-device"  || routingId)
fanoutToken = HKDF(contentKey[current], "push-fanout")
```

`deviceSecret` is 32 random bytes generated once per device and kept in
SecureStore.

**`routingId` is per person, per circle.** Derived from the seed, so every
device you own computes the same one — which is what makes notification
preferences account-wide with nothing to sync. Derived rather than random
(what `DESIGN.md` section 2 specified) so a new phone recomputes it
instead of re-registering, and so a device transfer needs to carry
nothing.

Deriving it from `accountId` instead would be fatal: the relay knows your
`accountId` from the session and sees `syncId` on every append, so it could
compute every routing ID itself. The seed is the one input the relay can
never have.

**`deviceId` is per device, per routing ID.** A single device-wide
identifier reused across circles would let the relay group your routing
IDs straight out of the sort key — the same clustering the routing IDs
exist to prevent, reintroduced through a table key. The `deviceSecret`
never leaves the device, so the derived values are unlinkable without it.

**`fanoutToken` is per circle, and rotates.** It is never stored and never
published: every member derives it from the content key they already hold.
Because it derives from the *current* content key, removing a member
rotates it, and their push capability dies with the rotation that already
happens. `routingId` deliberately does not rotate — binding it to
`keyVersion` too would force a roster update on every removal, for no gain.

## Storage

One DynamoDB table, two sort-key shapes, the same pattern `invitestore`
already uses:

```
pk = routingId
sk = "prefs"            -> { categories, fanoutHash, keyVersion }
sk = "token#<deviceId>" -> { pushToken (KMS-encrypted), platform, enabled }

fanoutHash = hash(fanoutToken || routingId)
```

**The hash is salted by `routingId` on purpose.** Storing the bare
`hash(fanoutToken)` would put an identical value on every row in a circle,
and the relay could cluster membership straight out of the table — the one
thing this design is meant to keep out of durable storage. Salting per row
makes each value unique while verification still works, since the relay
knows which routing ID it is checking.

**Deliberately absent: `accountId`, `circleId`, `syncId`, and any list of
which routing IDs belong together.** Registration authenticates (for rate
limiting) but writes no account link. Nothing else needs one: knowing a
`routingId` is itself the authorization to manage that row, since only the
seed produces it.

Push tokens are KMS-encrypted at rest under a purpose-derived key. That
buys protection against a leaked backup or an over-broad read role, not
against a compromised live server — which can call KMS itself. DynamoDB
SSE already covers the disk.

## The flow

**Register** — on join, and again after each key rotation. Authenticated,
`accountId` not persisted:

- `PUT /v1/push/{routingId}` with `{ fanoutHash, keyVersion, categories }`
- `PUT /v1/push/{routingId}/devices/{deviceId}` with `{ pushToken, platform }`

**Publish** — `routingId` rides in the member's roster entry, encrypted,
syncing through the log like every other roster field. The relay never
sees a circle-to-routing-ID map.

**Send** — after `appendEntry` succeeds, unauthenticated:

- `POST /v1/push` with `{ routingIds[], fanoutToken, category, payload }`
- routing IDs come from the sender's own decrypted roster, minus their own
- `payload` is the entry's existing ciphertext plus a fixed placeholder
  string

**Verify** — per routing ID, the relay recomputes
`hash(fanoutToken || routingId)` and compares against that row. A mismatch
is skipped silently. This is a shared-secret comparison, not a signature:
the relay never verifies signatures anywhere, since entries are ciphertext
(authorship is checked client-side on replay, by `authoredByMember`).

The salted hash is what stops a member of circle A targeting circle B's
routing IDs: they cannot produce B's token. A plain `writeToken` + `syncId`
check would *not* have worked here — the relay has no stored mapping to
tell whether a supplied routing ID belongs to the circle being claimed, and
accepting `syncId` would hand it the circle-to-routing-ID binding this
design exists to withhold.

**Deliver** — check the category bit, then dispatch to each `enabled`
token individually rather than as one grouped send.

**Receive** — the device maps `routingId` to a circle locally, decrypts at
`keyVersion`, and composes the text itself. iOS uses a Notification Service
Extension; Android an FCM data message into `onMessageReceived`.

## Why the send call is unauthenticated

Riding fanout on the authenticated append is simpler and reuses the
`writeToken` check already there. It was rejected because every fanout
would then arrive alongside an identified poster, and a few posts from
different members lets the relay solve the membership graph by elimination
— each poster's own routing ID is absent from their own fanout.

Unauthenticated, gated on a recipient-derived secret, the relay sees
anonymous clusters instead: it learns those routing IDs form a group, but
nothing says whose. This is the same shape as Signal's unidentified sender
path, which gates on a key the recipient handed out rather than on the
sender's identity.

The cost is that a former member with an old roster keeps push capability
until the next rotation, and rate limiting cannot key on an account.

## Rate limiting

`ratelimitstore.Allow(ctx, key)` takes a key chosen by the *handler* (not
by the HTTP caller — today the middleware passes the authenticated
accountID), so this reuses the existing store rather than new
infrastructure.

Two different things need protecting, and one limit cannot do both.
Protecting a *recipient* means keying on their `routingId`, which is
attacker-supplied. That is fine for its purpose: a random routing ID
reaches nobody, and to actually spam someone you must use their real one,
which is exactly the key — so it cannot be varied while still reaching
them. But it means an attacker cycling random IDs gets a fresh budget every
request, so it does nothing to protect the *relay*. Hence four layers,
since there is no session to budget against:

- **Per recipient `routingId`.** The one that matters: it bounds how much
  any individual can be pushed regardless of who is sending.
- **Cap the `routingIds[]` length per request.** A circle's membership is
  bounded, so a request targeting thousands is not a real one.
- **Per IP**, for raw flood protection, generously — families share a
  home network and would otherwise collide with each other.
- **Penalize verification failures.** A caller submitting routing IDs
  whose hash does not match is probing, not sending.

## Notification content

The device composes the real text. The payload also carries a fixed,
content-free placeholder ("New activity"), needed in two cases:

- the NSE runs but decryption fails — it substitutes a string **hardcoded
  in the extension**, never one read from the payload, so a forged push
  cannot put chosen text on a lock screen
- the NSE never runs (memory, timeout) — iOS renders the payload's own
  alert body, which is why that must be the placeholder too

Send alert pushes with `mutable-content: 1`, never silent
(`content-available`) pushes: silent pushes are budgeted, deprioritized in
Low Power Mode, and dropped after a force-quit.

An in-app "Hide details in notifications" setting should reuse the same
placeholder path. The notification text is the most sensitive plaintext in
the system and it lands on a lock screen — the relay never sees it, but a
passer-by does.

## Categories

The `category` field on the send call is a plain integer, deliberately.

Encoding it as `HKDF(circleId, type)` was considered and rejected: every
member derives the same tag, so the relay could cluster routing IDs by
matching tags — the durable grouping this design keeps out of storage. A
per-recipient derived tag avoids that but must be published in advance,
which means adding a category later requires every member to republish
their routing IDs into the roster.

The integer's meaning is not secret — anyone with the client can read it —
but the relay can already infer roughly the same thing from traffic shape:
namespace, ciphertext size, and whether a blob upload accompanied the
entry. Opaque names (`option1`) are fine if wanted, but they are cosmetic:
the design must be correct assuming the mapping is public.

Categories live on the `prefs` row, so they are account-wide. The per-device
switch is the `enabled` flag on the token row. "Silence this circle"
unregisters or disables that circle's rows; nothing needs to sync, and no
log entry is written.

## What this leaks, honestly

**At rest, nothing that groups anyone.** A stolen table yields opaque
routing IDs, encrypted tokens, salted hashes, and category bits. No
accounts, no circles, no graph.

**In flight, the grouping.** A send call carries a set of routing IDs, and
that set *is* the relationship. This is structural: the relay cannot fan
out to a group it has not been told about, and devices cannot reach
APNs/FCM themselves.

Splitting the send into one request per recipient removes the explicit set
but not the inference — N requests from one address within a second is a
group. Defeating that needs jitter (which delays notifications), an
unlinkable transport (which needs a proxy run by someone else), and enough
volume to hide in (which a small private relay does not have). Signal ends
up in the same place and answers it with policy rather than cryptography.

**So the claim to make is "nothing durable is written down," not "the relay
cannot tell."** The first is true and defensible. The second is not, and
`DESIGN.md` section 2 reads as though it were.

For the policy half to be real, source IPs must actually not be logged —
API Gateway access logs, CloudFront, and ALB logs all capture them by
default. Retention on whatever remains should be short.

## What building this needs

Substantially more native work than anything else in the app:

- An iOS Notification Service Extension: a separate Swift target, added
  via a config plugin, with the decryption reimplemented natively
- The extension needs the circle key map, which means an App Group and a
  shared Keychain access group. Every `SecureStore` write currently passes
  no options; these would need `accessGroup`, and `keychainAccessible:
  AFTER_FIRST_UNLOCK` — the default `WHEN_UNLOCKED` is unreadable from an
  extension on a locked phone, which is exactly when notifications matter
- Android: an FCM data-message path into `onMessageReceived`
- APNs auth key and FCM service account credentials on the relay,
  KMS-encrypted. These are the most dangerous secret the relay will ever
  hold — anyone with them can put arbitrary text on users' lock screens,
  bypassing the extension entirely by omitting `mutable-content`.
  `provision/kms.tf` already reserves the master key for exactly this.

A cheaper first phase: deliver the placeholder only, with no extension and
no decryption. That gets the wake-up behaviour and the whole relay side
working, and leaves real notification text as phase two.
