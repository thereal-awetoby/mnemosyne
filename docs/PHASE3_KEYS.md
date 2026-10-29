# Phase 3 runbook: lock the sub-agent keys

Goal: each sub account can only call `report` on `mnemosyne-gov.testnet`, with a small gas allowance. It cannot transfer funds, deploy code, or add keys.

Run from any folder. Do sub-a fully first, verify, then repeat for sub-b and sub-c.

## 0. Redeploy the contract with `report`

```
cd contract
cargo near deploy build-non-reproducible-wasm --no-abi mnemosyne-gov.testnet without-init-call network-config testnet sign-with-keychain send
cd ..
```

State is preserved (no struct change). Check it still reads:

```
near contract call-function as-read-only mnemosyne-gov.testnet get_latest json-args {} network-config testnet now
```

## 1. Add the restricted key (FullAccess key still in place)

```
near account add-key mnemosyne-sub-a.testnet grant-function-call-access --allowance '0.25 NEAR' --receiver-account-id mnemosyne-gov.testnet --method-names 'report' autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send
```

If the CLI rejects the flag layout, run it without the trailing arguments and answer the prompts; `near account add-key --help` shows the exact order for your version.

## 2. List keys and note the FullAccess public key

```
near account list-keys mnemosyne-sub-a.testnet network-config testnet now
```

You should see two keys: the original FullAccess one and the new function-call one.

## 3. Prove the restricted key works (before deleting anything)

Call `report` as sub-a and check the log shows up on the explorer. Then prove it is actually restricted: the same key must fail to call `commit`, and must fail to transfer.

## 4. Delete the FullAccess key (irreversible)

```
near account delete-keys mnemosyne-sub-a.testnet public-keys <FULLACCESS_PUBLIC_KEY> network-config testnet sign-with-keychain send
```

After this, `list-keys` must show only the function-call key. Repeat for sub-b and sub-c.

## Notes

- Never commit private keys. Anything the CLI saves goes to the OS keychain; keep any exported key in a gitignored `.env`.
- The governor keeps its FullAccess key. Only the subs are locked down.
