# Handoff log

Running record of what was actually built, patch by patch. Newest entry
on top.

---

## 2026-10-28 — Phase 2 (in progress): NEAR testnet accounts + memory contract

**What was done:**

- Created 4 NEAR testnet accounts via `near-cli-rs` (sponsor-by-faucet,
  ed25519 keys saved to the Windows OS keychain, all currently
  FullAccess — sub-agent keys get restricted to function-call keys
  once the contract is live, per Phase 3):
  - `mnemosyne-gov.testnet` — governor
  - `mnemosyne-sub-a.testnet` — Sub-A (mean-reversion)
  - `mnemosyne-sub-b.testnet` — Sub-B (inventory/liquidity)
  - `mnemosyne-sub-c.testnet` — Sub-C (defensive reduce-only)
- Wrote the on-chain memory contract: `contract/src/lib.rs`, one
  `commit(hash, prev_hash)` call method (governor-only, chained against
  the on-chain `latest_hash`, fails if `prev_hash` doesn't match) and
  one `get_latest()` view method. Stores only the hash + prev hash +
  count — no private reasoning ever touches the chain, per the plan's
  confidential-execution rule.
- **Toolchain note:** first attempt used `near-sdk-js` (TypeScript,
  matching the rest of the repo), but its build step requires
  compiling a QuickJS→Wasm binary that has no native Windows target —
  `npm install` fails with "Platform win32 is not supported." Rather
  than route the whole dev environment through WSL, switched the
  contract (only the contract — `src/*.ts` cycle runner stays
  TypeScript/Node as-is) to Rust via `near-sdk-rs` + `cargo-near`,
  which ships a native Windows installer and builds without WSL.

**What's intentionally fake / not done yet:**

- Contract not yet deployed to `mnemosyne-gov.testnet` — `cargo-near`
  install was still in progress as of this entry.
- `src/memory.ts` still writes to the local `memory-log.json` file; it
  has not yet been pointed at the real on-chain `commit` call. That's
  the rest of Phase 2.
- Sub-agent keys are still FullAccess, not function-call-restricted
  (Phase 3, blocked on the contract being deployed first).
- No sub-agent REFUSE logic yet (Phase 4) and no x402 API yet
  (Phase 5).

**Next step (not started):** finish the `cargo-near` deploy, then
update `src/memory.ts` to call `commit` on `mnemosyne-gov.testnet` via
`near-api-js`, keeping the same function signature so `cycle.ts`
doesn't change. Cycle must still fail-closed if the on-chain commit
transaction fails.

---

## 2026-10-28 — Phase 1: skeleton cycle runner

**What was done:**

- Set up a TypeScript project (`package.json`, `tsconfig.json`, `tsx`
  for running without a separate compile step).
- Added `docs/BUILD_PLAN.md` — the full Mnemosyne build plan, as the
  single source of truth for every phase after this one.
- Built one working "governor cycle" end to end, per section 7 of the
  build plan:
  - `src/subAgents.ts` — defines the 3 sub-agent mandates (A:
    mean-reversion only, B: inventory/liquidity only, C: defensive
    reduce-only) and a fake swarm state reader (hardcoded capital
    numbers — not real yet).
  - `src/cycle.ts` — runs one cycle: READ fake state -> DECIDE (stub
    logic: KEEP everyone unless last-cycle loss > 100, then PAUSE) ->
    hash the decision -> MEMORY COMMIT -> ALLOCATE (print-only) ->
    log. If the memory commit fails, the cycle stops right there
    (fail-closed) and no allocation step runs — that rule from the
    plan is real in the code now, not just a comment.
  - `src/memory.ts` — hashes each decision (sha256) and appends it to
    a local `memory-log.json` file, standing in for an on-chain NEAR
    commit. Each record stores `prev_memory_hash`, so the log is
    already chained the way the real on-chain version will be.
  - `src/types.ts` — the `MemoryRecord` / `SubDecision` shapes, matching
    the memory schema in the build plan (section 8) field-for-field.
  - `src/index.ts` — entry point, runs one cycle.
- Updated `README.md` with current status and how to run it.

**What's intentionally fake / not done yet:**

- No NEAR testnet accounts exist yet, and nothing here calls NEAR.
  `governor` in the memory record is a placeholder string
  (`"mnemosyne.testnet"`).
- `decide()` in `cycle.ts` is a stub — deterministic rule, not a real
  or private decision path. That's Phase 6.
- No function-call keys, no real capital movement — the ALLOCATE step
  only prints what it would do.
- No sub-agent REFUSE logic yet (Phase 4) and no x402 API yet
  (Phase 5).

**How to check it works:**

```
npm install
npm run cycle
```

You should see six numbered steps print, ending in a decision hash and
"end cycle". Run it a second time and the new cycle's
`prev_memory_hash` will match the first cycle's `decision_hash` — that
chaining is the part that matters for later NEAR-backed memory.

**Next step (not started):** Phase 2 — replace the local
`memory-log.json` write in `src/memory.ts` with a real NEAR testnet
transaction, keeping the same function signature so nothing else in
`cycle.ts` has to change. Needs testnet accounts created first (NEAR
CLI, `near create-account`), which hasn't been done yet.
