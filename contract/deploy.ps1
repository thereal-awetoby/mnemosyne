# Deploy the Mnemosyne memory contract.
#
# Wraps `cargo near deploy` with the flags that actually work on Windows.
# In particular --no-abi: ABI generation compiles the crate for the host and
# fails to link under MinGW (undefined `read_register`, `promise_batch_action_*`,
# `bls12381_*`). See contract/README.md for the full explanation.
#
# Usage:
#   .\deploy.ps1
#   .\deploy.ps1 -AccountId mnemosyne-gov.testnet -Network testnet
#   .\deploy.ps1 -BuildOnly

[CmdletBinding()]
param(
    [string]$AccountId = "mnemosyne-gov.testnet",
    [ValidateSet("testnet", "mainnet")]
    [string]$Network = "testnet",
    [switch]$BuildOnly
)

$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    if ($BuildOnly) {
        Write-Host "==> cargo near build non-reproducible-wasm --no-abi" -ForegroundColor Cyan
        cargo near build non-reproducible-wasm --no-abi
        if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
        Write-Host "==> ok: target/near/mnemosyne_memory_contract.wasm" -ForegroundColor Green
        return
    }

    Write-Host "==> cargo near deploy -> $AccountId ($Network)" -ForegroundColor Cyan
    # --no-abi goes immediately after the build subcommand.
    # The contract has no #[init] method, hence `without-init-call`.
    cargo near deploy build-non-reproducible-wasm --no-abi `
        $AccountId without-init-call `
        network-config $Network sign-with-keychain send
    if ($LASTEXITCODE -ne 0) { throw "deploy failed (exit $LASTEXITCODE)" }

    Write-Host "==> deployed. verifying get_latest ..." -ForegroundColor Cyan
    near contract call-function as-read-only $AccountId get_latest `
        json-args '{}' network-config $Network now
}
finally {
    Pop-Location
}
