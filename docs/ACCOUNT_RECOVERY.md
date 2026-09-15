# Account recovery

How someone gets their account back on a new phone, using the 12-word
recovery phrase.

## What the phrase is

Twelve words holding a 128-bit seed. Every key tied to *who you are* is
derived from it — your signing identity in each circle, and the key that
encrypts your account manifest. Derived means reproducible: the phrase
regenerates the exact same keys on any device, so you come back as the same
member and your old posts stay yours.

## Why the phrase alone isn't enough

A circle's photos are encrypted with a **content key**, and that one isn't
derived from anything. It's random, generated when the circle is created and
again whenever someone is removed. You're handed it once, when you join, and
it lives in your Keychain.

That copy dies with the phone. And it can't be read back out of the circle's
log either, because the log's own entries are encrypted with the very keys
you're missing.

So the app keeps a second copy somewhere the phrase can reach: the **account
manifest**, a small document on the relay holding, for each of your circles,
its address and its content keys — plus your name and avatar. The whole
thing is encrypted on your device with a key derived from your seed. The
relay stores it and can never read it.

## What happens when you recover

1. Sign in with the same Google/Apple account.
2. Enter the phrase. The app derives your seed from it.
3. It decrypts your manifest and restores your profile straight away, so
   you're not asked to retype your name.
4. For each circle still listed — tombstones are skipped, there's nothing
   left of those — it saves the content keys, re-derives your identity, and
   creates the circle locally with its sync position at zero.
5. Sync replays each circle's history from the beginning, rebuilding the
   members and posts.

Your feed comes back on its own. Nobody else has to do anything.

## Two devices at once

The manifest is one document, and a lost write here costs a circle's keys,
so two things protect it.

**Versioning.** Each stored manifest carries a version. A write only lands if
the version hasn't moved since it was read; if it has, the app re-reads,
reapplies its change, and writes again.

**Contributing rather than replacing.** Versioning alone isn't enough, because
a device only knows its own circles — nothing tells a running phone about a
circle joined on your other one, so a write that replaced the list would
delete it, and the other phone would then delete this one's.

So there's exactly one operation: state everything this device holds, and let
the merge work out what that changes. Nothing ever subtracts. "In the manifest
but not on this phone" is genuinely ambiguous — it's equally what your other
phone's circle looks like — so it can never be read as a removal.

Leaving is recorded rather than deleted: the entry becomes a tombstone holding
just an id and a timestamp, with the address and keys dropped. That's terminal,
so a phone that hasn't yet synced its own removal can keep contributing the
circle and still lose. Tombstones are kept indefinitely; they're about 60 bytes
and bounded by the circles you've ever left.

How each field combines is declared once, in `manifest-merge.ts`, rather than
decided by each writer:

| | |
|---|---|
| circles, and key versions within one | combine — neither side can subtract |
| a departure | terminal for that circle; keys never come back |
| profile | newer `updatedAt` wins; there's nothing to combine |
| provider | whatever this sign-in says |

That registry is typed over the payload, so adding a field won't compile until
it says how it merges — the mistake it exists to prevent is a writer quietly
dropping something another device held.

Writes are also queued one at a time per device, so this phone's own
operations order rather than collide. Only the *other* phone can cause a
version conflict.

Because every write states the whole local picture, any write also repairs
earlier ones that failed. Being several rotations behind costs no more than
being one: the local key map already holds every version, so one write catches
up completely. That's also why offline needs no queue — the durable record is
SQLite and the Keychain, and what to push is re-derived from them rather than
remembered.

## Limits

- **Same account.** Recovery needs the Google or Apple account you signed up
  with. The manifest is stored against it.
- **Lose the phrase and you can't recover on your own.** Nothing else can
  decrypt the manifest. Someone in a circle can invite you back and you'll
  get its history again, but you'll be a new member — your old posts stay
  under your previous identity.
- **Recovering is safe to retry.** If it fails partway, running it again
  picks up where it stopped rather than duplicating what it already restored.

## Where this lives

| | |
|---|---|
| Manifest contents, read/write, conflict retries | `app/src/domain/usecases/account/account-manifest.ts` |
| The restore itself | `app/src/domain/usecases/account/restore-from-phrase.ts` |
| Key derivation from the seed | `app/src/services/crypto.ts` |
| Storage and versioned writes | `server/internal/account/` |

`SYNC_DESIGN.md` describes a larger future replacement for the manifest — a
per-membership discovery table keyed off the seed rather than the account,
which would drop the same-account requirement. Not built.
