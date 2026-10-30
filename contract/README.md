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

```powershell
near contract call-function as-read-only mnemosyne-gov.testnet get_latest `
  json-args '{}' network-config testnet now
```

Expect `["", "", 0]` on a fresh deploy, and a growing `commit_count` after each
governor cycle (`npm run cycle` in the repo root).
