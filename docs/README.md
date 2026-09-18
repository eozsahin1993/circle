# Design docs

Architecture and design decisions for Mimoza, kept separate from the
`server/` and `app/` code they describe so neither directory's README has
to double as both a map of the code and a design history.

- [DESIGN.md](DESIGN.md) — the relay's overall architecture: blindness,
  storage, auth, account recovery.
- [SYNC_DESIGN.md](SYNC_DESIGN.md) — the append-only per-circle log: entry
  shape, invariants, key management.
- [INVITE_FLOW.md](INVITE_FLOW.md) — the invite/join handshake, end to
  end.
- [PUSH_DESIGN.md](PUSH_DESIGN.md) — mobile push notifications: routing,
  fanout, on-device composition.
- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) — accounts, environments, the
  CloudFront front door, blob delivery, deploys, cost.
- [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md) — cutting an internal
  build: what to run, and what a wrong-environment build looks like.
- [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) — what stands between here
  and both stores, and which items cost waiting rather than work.

Each doc's own status line says what's actually built versus still
design-only — check that before trusting a claim about current behavior;
these can lag the code.
