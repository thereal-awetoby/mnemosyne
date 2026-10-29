# mnemosyne

Non-trading governor agent on NEAR: private decisions, on-chain memory
commitments, capability-limited sub-agents, and x402-paid memory queries.

Full build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).
Build progress / what's been done in each step: [`HANDOFF.md`](HANDOFF.md).

## Current status: Phase 2 — on-chain memory gate

One cycle (read -> decide -> memory commit -> allocate -> log) runs locally. The memory commit is a real NEAR testnet transaction to `mnemosyne-gov.testnet`, and the cycle fails closed if it doesn't go through. Allocation is still print-only, and sub-agent keys are not restricted yet (Phase 3). No real funds move.

## Run it

```
npm install
npm run cycle
```

This runs one cycle and prints each step. Run it again and you'll see
`prev_memory_hash` pick up the previous cycle's hash, chaining the log.
