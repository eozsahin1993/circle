# Circle

Expo/React Native client in `app/`, Go relay in `server/`. Each has its own
`AGENTS.md` with rules specific to it — read the one for the directory
you're working in.

# Comments

Don't add comments for the sake of it. Add one only when it captures
something hard to follow or reason about:

- why a non-obvious choice was made, especially one that looks wrong
- a constraint from outside the file (an upstream bug, a relay contract,
  an invariant in `server/SYNC_DESIGN.md`)
- a trap the next person would otherwise reintroduce

Never restate what the code says, narrate a function step by step, or
enumerate reasons in bullets. Match the density of the file you're editing.

Length is the tell: a long inline comment usually means the explanation
belongs in the function's doc comment, or that the code should have been
clearer instead. Keep inline comments to a couple of lines.

# Verify, don't assume

Read the code before saying how it behaves. A name, a doc comment, or a
plausible-sounding design is not evidence — the comment may be stale and
the design may never have been wired up.

This cuts across `app/` and `server/`: a client question is often settled
in Go, and vice versa. If the claim is about what the relay accepts, read
the handler and the store, not just `services/relay.ts`.

When something can't be checked, say so and say why, rather than stating
it as fact. If a claim turns out wrong, correct it plainly and move on.
