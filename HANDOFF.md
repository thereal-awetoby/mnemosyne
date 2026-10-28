# Handoff log

Running record of what was actually built, patch by patch. Newest entry
on top.

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
