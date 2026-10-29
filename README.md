# mnemosyne

Non-trading governor agent on NEAR: private decisions, on-chain memory
commitments, capability-limited sub-agents, and x402-paid memory queries.

Full build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).
Build progress / what's been done in each step: [`HANDOFF.md`](HANDOFF.md).

## Current status: Phase 2 complete, Phase 3 in progress

One cycle (read -> decide -> memory commit -> allocate -> log) runs, and the memory commit is a real on-chain call to mnemosyne-gov.testnet (hash chained against the on-chain head, fail-closed). ALLOCATE is still print-only and the sub-agent keys are not restricted yet (Phase 3). No real funds move.

## Run it

```
npm install
npm run cycle
```

This runs one cycle and prints each step. Run it again and you'll see
`prev_memory_hash` pick up the previous cycle's hash, chaining the log.
