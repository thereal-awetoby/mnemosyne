# Handoff log

Running record of what was actually built, patch by patch. Newest entry on top.

## 2026-10-30 (latest) — Phase 2 redeploy: `--no-abi` path proven end to end

**What was done:**

- First successful `cargo near deploy build-non-reproducible-wasm --no-abi ...` on Windows. No ABI step attempted, no MinGW link error. New `code_hash`: `4MuK2kWdogdYM4L1A3vzcGhFyipLnU1e9L6viZ2xocu9`; `npm run verify:contract` 6/6.
- The **previous** on-chain `code_hash` was `DAPxfwyssXxfAZpSju3u24FAg2KVZNY6J53mTVLocUfC` -- byte-identical to the `.wasm` committed in git at `contract/target/near/`. So the earlier verifier FAIL was not a bad deploy: it was a non-reproducible local rebuild compared against an older committed artifact. Rust->wasm is not bit-reproducible across toolchains; that is what `cargo near build reproducible-wasm` exists for.
- Deleted `contract/target/near/*.wasm` and redeployed. This time `wasm-opt` actually ran (previously "Skipped running wasm-opt as final target exists and is newer than wasm produced by cargo") and produced an **identical** hash -- `4MuK2...`. So the skip was harmless only because the stale artifact was a correct build of unchanged source. `lib.rs` has no content change since Phase 2 (merge commits only).
- **State survives redeploy** (verified, not assumed): `commit_count` stayed 4 and `latest_hash`/`prev_hash` were unchanged across both deploys.
- `npm run cycle` committed on top: read `prev_memory_hash: sha256:b645da0c...` from chain (the pre-redeploy `latest_hash`), committed successfully. `commit_count` now 5, `latest_hash` `sha256:07e59cb5...`.

**Correction to the negative-test command in earlier notes/docs:** it must target the governor contract, with the sub account only as signer --
`near contract call-function as-transaction mnemosyne-gov.testnet commit json-args "{\"hash\":\"sha256:deadbeef\",\"prev_hash\":\"\"}" prepaid-gas "30 TeraGas" attached-deposit "0 NEAR" sign-as mnemosyne-sub-a.testnet network-config testnet sign-with-keychain send`
The variant with `mnemosyne-sub-a.testnet` in the contract slot fails with `CompilationError(CodeDoesNotExist)`: nearcore refuses before executing, so it proves nothing about the governor gate and writes nothing.

**Not done / still open:**

- **Governor gate still unproven** -- no run has yet produced `only the governor account may write a memory commit`. Run the corrected command, then `npm run verify:contract` to confirm `commit_count` stays 5.
- `mnemosyne-sub-a.testnet` has no contract code (expected; only the governor hosts code). This says nothing about whether the leftover `commit`-scoped function-call key is still on sub-a/sub-b -- that was never checked. Phase 3 still inspects and removes it.
- Phase 3 (function-call keys) unchanged.

**Next step:** the corrected negative test, then Phase 3.

---

## 2026-10-30 (later) — `verify:contract` re-added; it was silently missing from `main`

**What happened:** `npm run verify:contract` failed with `Missing script: "verify:contract"` on a clean checkout of `main`. Cause was not the user's environment: the verification work (`scripts/verify-contract.mjs` + the npm script) **never landed in the merge**. `main` at `445cade` contains the earlier `--no-abi` commit's files (`contract/README.md`, `contract/deploy.ps1`, the `.gitignore` additions) but has no `scripts/` directory and no `verify:contract` in `package.json`. A previous session's summary claimed both commits were merged; only the first one was.

**What was done:**

- Re-created `scripts/verify-contract.mjs` and the `verify:contract` npm script.
- **Changed path resolution:** the wasm path is now anchored to the repo root (derived from `import.meta.url`), not `process.cwd()`. Previously, running from `contract/` made the script hunt for `contract/contract/target/...` and report a bogus `FAIL local wasm found at ...`. `CONTRACT_WASM` still overrides; a relative override resolves against the cwd as you'd expect. Verified from both the repo root and `contract/`.
- Re-ran the six mock-RPC scenarios (fresh, count 1, count 3, stale wasm, no code, no account) -- all produce the intended verdict and exit code. Cross-checked the inline base58 encoder against the `bs58` package on the **real** 89,806-byte artifact: identical (`DAPxfwyssXxfAZpSju3u24FAg2KVZNY6J53mTVLocUfC`).
- `contract/README.md`: three-tier verification section (deploy output -> code-hash match -> behavioral checks incl. the negative governor test), plus a **Shell notes (Windows)** section. The earlier docs used PowerShell backticks and `#` comments; the user is in `cmd.exe`, where `#` is not a comment (`npm run  # ...` -> `Missing script: "#"`) and continuation is `^`. Identical commands, no shell assumptions now.
- Rule of thumb documented: `npm run ...` from the repo root, `cargo near ...` from `contract/`.

**Not verified:** the live path against `rpc.testnet.near.org` -- this sandbox has no egress there (only GitHub/npm/PyPI). Mock RPC only.

---


## 2026-10-30 — deploy-build fix: `--no-abi` is required on `cargo near deploy`

**What was done:**

- Diagnosed the deploy failure: `cargo near deploy build-non-reproducible-wasm ...` runs the ABI step *before* the wasm build, which compiles the crate for the **host** (x86_64-pc-windows-gnu). That link fails under MinGW with `undefined reference to read_register / promise_batch_action_* / bls12381_*` -- `near-sys` declares those NEAR-VM externs unconditionally and only wasm32 supplies them. ELF/Mach-O linkers tolerate unresolved symbols in a shared object; the PE linker does not. Nothing wrong with the contract, rustc, or near-sdk here -- and note the failing command was `build`, not `deploy`: it died before reaching the network.
- Fix, same as the Phase 2 `cargo near build` draw: pass `--no-abi` (it was present for `build` in Phase 2, missing from this `deploy` invocation). The flag is accepted on `deploy build-non-reproducible-wasm` because that subcommand flattens the build `BuildOpts`. It must come *before* the account id, since everything after `send` is parsed as part of the `send` subcommand.
- Added `contract/README.md` (build/deploy commands + why ABI generation cannot link on Windows) and `contract/deploy.ps1` (wrapper that sets the flags correctly and verifies `get_latest` after deploy) so the incantation is not re-derived from scratch.
- Added `contract/target/`, `target/` to `.gitignore`. **Note:** `contract/target/` (~2,100 files, ~560 MB of build cache) is already *tracked*, so the ignore rule does not apply to it until it is untracked -- intentionally not done here, because it would wipe the local build cache on the next pull. One-liner when you want it: `git rm -r --cached contract/target`.
- ABI metadata is now not embedded in the deployed wasm. Purely cosmetic for tooling; callable methods are unaffected. Regenerate on WSL/Linux (`cargo near build non-reproducible-wasm --no-embed-abi`) or via Docker (`cargo near build reproducible-wasm`, needs a clean committed tree) if ever needed.

**Not done / still open:** nothing changed in the contract or the TypeScript side. Phase 3 (stray `commit` keys on sub-a/sub-b, FullAccess -> function-call keys) is still the next step, unchanged.

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
