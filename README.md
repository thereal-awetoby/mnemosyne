# mnemosyne

Non-trading governor agent on NEAR: private decisions, on-chain memory
commitments, capability-limited sub-agents, and x402-paid memory queries.

Full build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).
Build progress / what's been done in each step: [`HANDOFF.md`](HANDOFF.md).

## Current status: Phase 1 — skeleton cycle runner

One cycle (read -> decide -> memory commit -> allocate -> log) runs
locally. The memory commit is simulated (written to a local
gitignored `memory-log.json`) instead of going to NEAR — that's next.
No real funds, keys, or chain calls yet.

## Run it

```
npm install
npm run cycle
```

This runs one cycle and prints each step. Run it again and you'll see
`prev_memory_hash` pick up the previous cycle's hash, chaining the log.
