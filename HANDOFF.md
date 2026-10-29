# Handoff log

Running record of what was actually built, patch by patch. Newest entry on top.

---

## 2026-10-29 — Phase 2 (done): on-chain memory gate live on NEAR testnet

**What was done:**

- Memory contract (`contract/src/lib.rs`) is deployed to `mnemosyne-gov.testnet`. `commit(hash, prev_hash)` only succeeds when the governor account calls its own contract (self-call check), and is chained against the on-chain `latest_hash`.
- `src/memory.ts` now sends a real `commit` transaction (near-api-js v7, governor key from `.env`) instead of writing `memory-log.json`. `writeMemoryRecord()` signature kept, and it now also returns `txHash`.
- `src/cycle.ts` uses the real governor account id (from `GOVERNOR_ACCOUNT_ID`) in the hashed record, and prints a nearblocks explorer link after each commit.
- **Verified:** `npm run cycle` commits on-chain and `prev_memory_hash` is read back from the contract, so the chain links across runs.
- **Verified fail-closed:** running with a bad `GOVERNOR_PRIVATE_KEY` prints `[FAIL-CLOSED]`, the cycle ends, and the ALLOCATE step never runs.
- Design confirmed: the governor alone writes memory. Subs are not co-authors; they only act inside the last committed mandate under limited keys.

**What's intentionally fake / not done yet:**

- `getLatestMemoryRecord()` returns placeholders for everything except the hashes (the contract only stores hashes + count). Fine while `cycle.ts` only reads `.decision_hash`.
- `mnemosyne-sub-a` and `mnemosyne-sub-b` each have a leftover function-call key scoped to `commit` on the governor contract. It can never succeed (the contract rejects non-governor callers) and is test debris. Remove it in Phase 3. Sub-C's keys were not inspected.
- Sub-agent keys are still FullAccess, not properly restricted (Phase 3).
- ALLOCATE is still print-only. No REFUSE logic (Phase 4), no x402 API (Phase 5), decide() is still a stub (Phase 6).

**Next step (not started):** Phase 3. Delete the stray `commit` keys on the subs, then replace each sub's FullAccess key with a real function-call key (limited methods, limited allowance), and make allocation happen only after the memory commit.

* * *

## 2026-10-29 — Phase 2 (complete): contract deployed + on-chain memory commit wired up

**What was done:**

- Finished the `cargo-near` toolchain fight on Windows: `cargo near build non-reproducible-wasm --no-abi` (ABI generation fails to link natively on Windows/MinGW -- `read_register`/`promise_batch_action_*`/`bls12381_*` are host-only externs with no native implementation, so ABI generation is skipped; the wasm itself builds fine either way).
- Installed `near-cli-rs` via the prebuilt Windows binary (`irm .../near-cli-rs-installer.ps1 | iex`) instead of `cargo install` -- building it from source hit the same MinGW/`dlltool` linking issue as the ABI step above.
- Deployed `contract/target/near/mnemosyne_memory_contract.wasm` to `mnemosyne-gov.testnet` (no `#[init]` method in the contract, so `without-init-call`). Confirmed live: `get_latest()` returns `["", "", 0]`.
- Rewired `src/memory.ts`: `writeMemoryRecord()` now signs and sends a real `commit(hash, prev_hash)` transaction via `near-api-js`, self-calling `mnemosyne-gov.testnet` as both signer and contract (matches the contract's `predecessor_account_id() == current_account_id()` governor check). Fail-closed behavior preserved exactly: any failure (network, the contract's hash-chain panic, etc.) returns `{ committed: false, error }` and does not throw.
- `getLatestMemoryRecord()` now reads `get_latest()` on-chain instead of the local log. Fills `decision_hash`/`prev_memory_hash` with real on-chain values; `decisions`, `swarm_risk`, `cycle_id` are placeholders since the contract only stores the hash chain + count, not the full record. Returns `null` when `commit_count === 0` (nothing committed yet), same as the old "empty log" behavior.
- Signing key: exported from the OS keychain via `near account export-account mnemosyne-gov.testnet using-private-key`, stored in a gitignored `.env` as `GOVERNOR_PRIVATE_KEY` / `GOVERNOR_ACCOUNT_ID`, loaded into an `InMemoryKeyStore` at call time (near-api-js can't read the Windows keychain `near-cli-rs` uses directly).
- `memory-log.json` is no longer written to; superseded by the on-chain log. Left in place/gitignored for now rather than deleted.

**What's intentionally fake / not done yet:**

- `getLatestMemoryRecord()`'s placeholder fields (`decisions: []`, `swarm_risk` zeros, empty `cycle_id`) -- if any caller ever reads those off the *latest* record instead of just `.decision_hash`, they're wrong. Nothing currently does, as far as this change touched, but worth a grep before Phase 3.
- Sub-agent keys still FullAccess, not function-call-restricted (Phase 3).
- No sub-agent REFUSE logic yet (Phase 4) and no x402 API yet (Phase 5).

**Next step (not started):** Phase 3 -- restrict `sub-a`/`sub-b`/`sub-c` testnet keys to function-call-only access scoped to their mandates, now that the governor contract they'd be constrained against is actually live.

---

## 2026-10-29 — Phase 3 (in progress): sub-agent audit method + key lockdown runbook

**What was done:**

- Added `report(sub, action, reason)` to the contract (`contract/src/lib.rs`). Only `mnemosyne-sub-a/b/c.testnet` can call it, `sub` must equal the caller, `action` must be `ACT` or `REFUSE`, `reason` is capped at 200 bytes. It writes a `MNEMOSYNE_REPORT:` log line and no state, so the already-deployed state layout stays compatible (redeploy over the existing contract is safe; do not add struct fields without a migration).
- Added `docs/PHASE3_KEYS.md`, a step-by-step runbook for giving each sub a function-call key limited to `report` on `mnemosyne-gov.testnet`, then removing its FullAccess key.

**Not done yet:**

- Contract with `report` is not redeployed.
- No sub key has been restricted; all three subs are still FullAccess.
- Nothing in `src/` calls `report` yet (Phase 4: REFUSE checks will).

**Next step:** redeploy, run the runbook for sub-a first and verify, then sub-b and sub-c.

---

## 2026-10-29 — Phase 2 complete: on-chain memory gate live

**What was done:**

- Deployed the Rust memory contract to `mnemosyne-gov.testnet` with `cargo near build non-reproducible-wasm --no-abi` / `cargo near deploy build-non-reproducible-wasm --no-abi mnemosyne-gov.testnet without-init-call ...`. `--no-abi` is needed on Windows (GNU toolchain): the ABI-generation step fails to link NEAR host functions, and the ABI is not required to deploy. No init call: the governor check is `predecessor == current_account`.
- `src/memory.ts` now calls `commit` on-chain. `npm run cycle` reads `prev_memory_hash` from the chain head, commits, and only then runs ALLOCATE. A failed commit still stops the cycle.
- Verified: a cycle produced a real testnet tx and the new head chains to the previous one.

**Not done yet:** sub keys still FullAccess (Phase 3), no REFUSE logic (Phase 4), no x402 API (Phase 5), `decide()` still a stub (Phase 6).

---

## 2026-10-28 — Phase 2 (in progress): NEAR testnet accounts + memory contract

**What was done:**

- Created 4 NEAR testnet accounts via `near-cli-rs` (sponsor-by-faucet, ed25519 keys saved to the Windows OS keychain, all currently FullAccess -- sub-agent keys get restricted to function-call keys once the contract is live, per Phase 3):

  - `mnemosyne-gov.testnet` -- governor
  - `mnemosyne-sub-a.testnet` -- Sub-A (mean-reversion)
  - `mnemosyne-sub-b.testnet` -- Sub-B (inventory/liquidity)
  - `mnemosyne-sub-c.testnet` -- Sub-C (defensive reduce-only)
- Wrote the on-chain memory contract: `contract/src/lib.rs`, one `commit(hash, prev_hash)` call method (governor-only, chained against the on-chain `latest_hash`, fails if `prev_hash` doesn't match) and one `get_latest()` view method. Stores only the hash + prev hash + count -- no private reasoning ever touches the chain, per the plan's confidential-execution rule.
- **Toolchain note:** first attempt used `near-sdk-js` (TypeScript, matching the rest of the repo), but its build step requires compiling a QuickJS->Wasm binary that has no native Windows target -- `npm install` fails with "Platform win32 is not supported." Rather than route the whole dev environment through WSL, switched the contract (only the contract -- `src/*.ts` cycle runner stays TypeScript/Node as-is) to Rust via `near-sdk-rs` + `cargo-near`, which ships a native Windows installer and builds without WSL.

**What's intentionally fake / not done yet:**

- Contract not yet deployed to `mnemosyne-gov.testnet` -- `cargo-near` install was still in progress as of this entry.
- `src/memory.ts` still writes to the local `memory-log.json` file; it has not yet been pointed at the real on-chain `commit` call. That's the rest of Phase 2.
- Sub-agent keys are still FullAccess, not function-call-restricted (Phase 3, blocked on the contract being deployed first).
- No sub-agent REFUSE logic yet (Phase 4) and no x402 API yet (Phase 5).

**Next step (not started):** finish the `cargo-near` deploy, then update `src/memory.ts` to call `commit` on `mnemosyne-gov.testnet` via `near-api-js`, keeping the same function signature so `cycle.ts` doesn't change. Cycle must still fail-closed if the on-chain commit transaction fails.

---

## 2026-10-28 — Phase 1: skeleton cycle runner

**What was done:**

- Set up a TypeScript project (`package.json`, `tsconfig.json`, `tsx` for running without a separate compile step).
- Added `docs/BUILD_PLAN.md` -- the full Mnemosyne build plan, as the single source of truth for every phase after this one.
- Built one working "governor cycle" end to end, per section 7 of the build plan:

  - `src/subAgents.ts` -- defines the 3 sub-agent mandates (A: mean-reversion only, B: inventory/liquidity only, C: defensive reduce-only) and a fake swarm state reader (hardcoded capital numbers -- not real yet).
  - `src/cycle.ts` -- runs one cycle: READ fake state -> DECIDE (stub logic: KEEP everyone unless last-cycle loss > 100, then PAUSE) -> hash the decision -> MEMORY COMMIT -> ALLOCATE (print-only) -> log. If the memory commit fails, the cycle stops right there (fail-closed) and no allocation step runs -- that rule from the plan is real in the code now, not just a comment.
  - `src/memory.ts` -- hashes each decision (sha256) and appends it to a local `memory-log.json` file, standing in for an on-chain NEAR commit. Each record stores `prev_memory_hash`, so the log is already chained the way the real on-chain version will be.
  - `src/types.ts` -- the `MemoryRecord` / `SubDecision` shapes, matching the memory schema in the build plan (section 8) field-for-field.
  - `src/index.ts` -- entry point, runs one cycle.
- Updated `README.md` with current status and how to run it.

**What's intentionally fake / not done yet:**

- No NEAR testnet accounts exist yet, and nothing here calls NEAR. `governor` in the memory record is a placeholder string (`"mnemosyne.testnet"`).
- `decide()` in `cycle.ts` is a stub -- deterministic rule, not a real or private decision path. That's Phase 6.
- No function-call keys, no real capital movement -- the ALLOCATE step only prints what it would do.
- No sub-agent REFUSE logic yet (Phase 4) and no x402 API yet (Phase 5).

**How to check it works:**