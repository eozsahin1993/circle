# Design docs

Architecture and design decisions for Circle, kept separate from the
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

Each doc's own status line says what's actually built versus still
design-only — check that before trusting a claim about current behavior;
these can lag the code.
