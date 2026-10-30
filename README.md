# mnemosyne

Non-trading governor agent on NEAR: private decisions, on-chain memory
commitments, capability-limited sub-agents, and x402-paid memory queries.

Full build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).
Build progress / what's been done in each step: [`HANDOFF.md`](HANDOFF.md).

## Current status: Phases 1–4 complete and proven on NEAR testnet

One cycle runs: read -> decide -> **on-chain memory commit** (mnemosyne-gov.testnet, hash-chained, fail-closed) -> allocate (print-only) -> **sub-agent window**: each sub checks the directive against its own mandate and writes ACT/REFUSE on-chain with its own report-only function-call key. Sub C (defensive, reduce-only) refuses directives above its tighter ceiling.

Proven on testnet 2026-10-30 (see HANDOFF.md): a full cycle committed memory, then sub A and B reported ACT and sub C reported REFUSE on-chain, each signing with its own report-only key. Every sub key passes `npm run sub:check`: it can call `report`, and NEAR itself rejects `commit` and transfers. The sub accounts' FullAccess keys stay in the operator's keychain and are never given to the agent.

Still simulated, and labeled as such: swarm state, `decide()` (Phase 6), and ALLOCATE (no real transfers). No x402 API yet (Phase 5).

Sub-agent key setup: [`docs/PHASE3_KEYS.md`](docs/PHASE3_KEYS.md). Copy `.env.example` to `.env`.

## Run it

```
npm install
npm run cycle                 (one governor cycle)
npm run sub:keygen -- A       (new report-only key for a sub)
npm run sub:check -- A        (prove a sub key is scoped: report ok, commit/transfer rejected)
npm run verify:contract       (deployed wasm == local build, read-only)
```

This runs one cycle and prints each step. Run it again and you'll see
`prev_memory_hash` pick up the previous cycle's hash, chaining the log.
