# mnemosyne-memory-contract

Minimal on-chain memory gate for Mnemosyne. Stores **only** the latest commitment
hash, the previous hash, and a running count -- never any private reasoning.

- `commit(hash, prev_hash)` -- governor-only (self-call check), chained against
  the on-chain `latest_hash`. Panics if the chain is broken.
- `get_latest()` -- view method, returns `(latest_hash, prev_hash, commit_count)`.

## Requirements

```powershell
rustup target add wasm32-unknown-unknown
cargo install cargo-near
```

(`near-cli-rs` is only needed for direct `near contract deploy/call` commands.)

## Build

```powershell
cargo near build non-reproducible-wasm --no-abi
```

Artifact: `contract/target/near/mnemosyne_memory_contract.wasm`

## Deploy

```powershell
cargo near deploy build-non-reproducible-wasm --no-abi `
  mnemosyne-gov.testnet without-init-call `
  network-config testnet sign-with-keychain send
```

Or just use the wrapper, which sets exactly these flags:

```powershell
.\deploy.ps1                       # defaults to mnemosyne-gov.testnet / testnet
.\deploy.ps1 -AccountId mnemosyne-gov.testnet -Network testnet
```

`--no-abi` **must** come before `mnemosyne-gov.testnet`; anything after
`send` is parsed as part of the `send` subcommand and will be rejected.

## Why `--no-abi` is mandatory on Windows

Without the flag, `cargo near` first runs an ABI-generation step: it compiles
this crate **for the host** (not wasm32) with `near-sdk/__abi-generate` to
extract the JSON ABI. That host build fails on Windows/MinGW like this:

```
error: linking with `x86_64-w64-mingw32-gcc` failed: exit code: 1
  = note: ... undefined reference to `read_register`
  ... undefined reference to `promise_batch_action_*`
  ... undefined reference to `bls12381_*`
```

Cause: `near-sys` declares the NEAR runtime host functions as externs that only
exist inside a wasm32 NEAR VM. Off wasm32 they are simply never resolved, and
the ELF/Mach-O linkers *tolerate* unresolved symbols in a shared object, while
the MinGW PE linker does not. So this is a cargo-near/Windows linking limitation,
not a bug in this contract, the Rust version, or the near-sdk version -- the
wasm32 build itself is fine either way.

Skipping the ABI step costs you nothing at runtime: the ABI is only optional
metadata embedded in the `.wasm` for tooling (explorers, interactive
`near contract call-function` prompts). The contract's callable methods are
unaffected.

If you ever need the ABI JSON, generate it on a machine or container where the
host linker is permissive:

```bash
# WSL / Linux / macOS
cargo near build non-reproducible-wasm --no-embed-abi

# or, Docker (also needs a clean committed git tree)
cargo near build reproducible-wasm
```

## Verify after deploy

Three checks, weakest to strongest. Run all of them **from the repo root**
(`C:\Users\YOU\Documents\mnemosyne`), not from `contract/`.

**1. The deploy command's own output.** `cargo near deploy` prints
`Contract deployed successfully` plus a transaction hash on success, and an
error string otherwise. If you did not see the success line, stop here --
everything below only tells you what is (or isn't) on chain.

**2. Is *your* build the code on chain?** Read-only, no keys:

```powershell
npm run verify:contract
```

```cmd
:: cmd.exe, if you prefer calling node directly
node scriptserify-contract.mjs
```

It compares `sha256(local wasm)` against the account's on-chain `code_hash`
(the same hash, base58-encoded), then calls `get_latest()` and sanity-checks the
state. Exit code 0 = all checks passed.

Why the hash and not just "does `get_latest` answer": Phase 2 already deployed a
build with the same methods, so a working `get_latest` proves *some* version is
live, not that *this* deploy ran. The byte-exact hash tells them apart. If the
hashes differ, the deploy did not take effect or the wasm was rebuilt afterwards.

The script finds `contract/target/near/mnemosyne_memory_contract.wasm` relative
to the repo root, so it works from any directory. To point it elsewhere:
`set CONTRACT_WASM=path\to\contract.wasm`, and `set NEAR_RPC_URL=...` for mainnet.

```powershell
near contract call-function as-read-only mnemosyne-gov.testnet get_latest `
  json-args '{}' network-config testnet now
```

Expect `["", "", 0]` on a fresh contract. That is *correct* -- it means the code
is live and nothing has committed yet, not that something failed.

**3. Does it behave correctly?** These need a signer, and are the checks that
actually matter:

```powershell
# The governor can write memory (the real Phase 2 gate):
npm run cycle
```

```powershell
# A non-governor account CANNOT. This MUST fail:
near contract call-function as-transaction mnemosyne-sub-a.testnet commit `
  json-args '{"hash":"sha256:deadbeef","prev_hash":""}' prepaid-gas '30 TeraGas' `
  attached-deposit '0 NEAR' sign-as mnemosyne-sub-a.testnet `
  network-config testnet sign-with-keychain send
```

The second call **must** fail with
`only the governor account may write a memory commit`. If it succeeds, the
governor check is not live on chain -- redeploy before anything else, because
that check is the entire fail-closed design.

A passing `npm run cycle` prints `committed.` and a nearblocks tx link, then
`commit_count` from `get_latest` goes up by one, with `prev_hash` now equal to
the previous `latest_hash`.

## Shell notes (Windows)

You are most likely in **Command Prompt (`cmd.exe`)**, where:

- `#` is **not** a comment. `npm run  # list scripts` tries to run a script
  literally named `#` and fails with `Missing script: "#"`. Use `::` for
  comments, or put the comment on its own line.
- Line continuation is `^`, not a backtick. Backticks are a PowerShell thing.
- `set VAR=value` sets an env var for the session; `%VAR%` reads it.
  PowerShell needs `$env:VAR = "value"`.

Rule of thumb: **`npm run ...` from the repo root, `cargo near ...` from
`contract/`.** `npm` needs `package.json` in the current directory, and `cargo`
needs `Cargo.toml`.
