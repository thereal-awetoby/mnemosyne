# Phase 3 runbook: lock the sub-agent keys (verify before delete)

**Goal:** the cycle runner holds, for each sub, one key that can only call
`report` on `mnemosyne-gov.testnet` with a capped gas allowance. That key
cannot transfer NEAR, deploy code, add keys, or call `commit`.

**The one rule that bricked the original sub-c:** never delete a key until a
replacement has been *proven on-chain* by `npm run sub:check`. Deleting the
last FullAccess key is permanent: nobody can ever add a key to that account
again.

Commands are for **Windows cmd.exe** (no `#` comments, no backticks).
`npm ...` from the repo root; `near ...` from anywhere.

---

## 0. Once: prove the governor gate (still unproven as of 2026-10-30)

A sub signing `commit` on the governor contract must be rejected by the contract:

```
near contract call-function as-transaction mnemosyne-gov.testnet commit json-args "{\"hash\":\"sha256:deadbeef\",\"prev_hash\":\"\"}" prepaid-gas "30 TeraGas" attached-deposit "0 NEAR" sign-as mnemosyne-sub-a.testnet network-config testnet sign-with-keychain send
```

Expected: `only the governor account may write a memory commit`. Then:

```
npm run verify:contract
```

`commit_count` must be unchanged. Paste the result into HANDOFF.md.
(This uses sub-a's FullAccess key from the keychain, so do it **before** step 5 for sub-a.)

---

## Per sub: do A, then B, then C, then D. One at a time.

D's account does not exist yet (A/B/C pre-date this project). Do the
**[Sub D: one extra first step](#sub-d-one-extra-first-step)** section below
before step 1 for D; after that, steps 1–6 are identical for D.

### 1. Look at what's there now

```
near account list-keys mnemosyne-sub-a.testnet network-config testnet now
```

Write down each public key and its type. Expected today for sub-a and sub-b:
one FullAccess key and one dead function-call key scoped to `commit`.

### 2. Generate the report-only key

```
npm run sub:keygen -- A
```

It prints a public key, two lines for `.env`, and the exact `add-key` command.
Paste the two lines into `.env` (gitignored; never commit it).

Why generate it here and not with `autogenerate-new-keypair save-to-keychain`?
The cycle runner uses near-api-js, which can't read the Windows keychain. This
way the secret goes straight into `.env` and only the public key goes on-chain.

### 3. Register it on-chain (signed with the sub's FullAccess key)

Run the `near account add-key ...` command that step 2 printed. It looks like:

```
near account add-key mnemosyne-sub-a.testnet grant-function-call-access --allowance "1 NEAR" --contract-account-id mnemosyne-gov.testnet --function-names report use-manually-provided-public-key ed25519:PASTE_PUBLIC_KEY network-config testnet sign-with-keychain send
```

If your near-cli-rs version rejects a flag, run `near account add-key mnemosyne-sub-a.testnet`
and answer the prompts with the same values.

Allowance is 1 NEAR (not 0.25): each report burns gas from the allowance, and
once it runs out the key stops working. Topping it up needs a FullAccess key.

### 4. Prove it (nothing gets deleted unless this is ALL PASS)

```
npm run sub:check -- A
```

Three checks:

| Check | Expected |
|---|---|
| `report()` with the new key | succeeds, `MNEMOSYNE_REPORT:...:ACT:...` log |
| `commit()` with the new key | rejected **by NEAR** (`MethodNameMismatch`), not just by the contract |
| 0.01 NEAR transfer with the new key | rejected (function-call keys can't transfer) |

The two negative checks are rejected before execution, so they cost nothing.
If a negative check FAILs, the key in `.env` is not the scoped key: stop and
compare its public key (printed at the top) with `list-keys`.

### 5. Remove the dead `commit`-scoped key (safe)

Only after step 4 is ALL PASS:

```
near account delete-keys mnemosyne-sub-a.testnet public-keys ed25519:DEAD_COMMIT_KEY network-config testnet sign-with-keychain send
```

Run `list-keys` again: you should see FullAccess + the new `report` key.

### 6. FullAccess key: keep it cold (recommended)

The security property judges care about is **what the running agent holds**.
After steps 2–4, the cycle runner only ever has the report-only key; the
FullAccess key lives only in your OS keychain and is never exported to `.env`.
That's the honest claim for the README: "sub-agents run with function-call
keys only; FullAccess is a cold recovery key held by the human operator."

Deleting FullAccess is optional and permanent. If you do it, do it **after**
the demo is recorded, and only once `npm run cycle` has reported successfully
for that sub at least twice. Afterwards the allowance can never be topped up.

---

## Sub D: one extra first step

`mnemosyne-sub-d.testnet` does not exist on testnet. A/B/C pre-date this
project; D is new, so it needs an account before anything in "Per sub"
applies to it.

### 0. Create the account (funded from the governor)

```
near account create-account fund-myself mnemosyne-sub-d.testnet autogenerate-new-keypair save-to-keychain sign-as mnemosyne-gov.testnet network-config testnet sign-with-keychain send
```

This gives D a FullAccess key (saved to the keychain, same as A/B/C's cold
key) and a small NEAR balance from the governor to cover its own storage
and future gas. It holds no capital of its own yet -- that's simulated
(`src/subAgents.ts`), not an on-chain balance, unless you also run
`npm run swarm:setup` with `SWARM_STATE=onchain`.

### 1. Redeploy the contract with D in the roster

`contract/src/lib.rs`'s `SUB_ACCOUNTS` now lists four accounts, not three.
`report()` only ever logs -- it never touches `MemoryContract`'s stored
fields (`latest_hash`, `prev_hash`, `commit_count`), so this redeploy
changes no state layout and nothing already committed is at risk. Still,
redeploy deliberately, not as an afterthought:

```
cd contract
.\deploy.ps1 -BuildOnly
```

Read the build output. Then:

```
.\deploy.ps1
```

This deploys and calls `get_latest` to confirm `commit_count` is
unchanged from before the redeploy. If it isn't, stop and look before
doing anything else.

Now go back to "Per sub" and do steps 1–6 for D, exactly as for A/B/C.

## Sub-C note

`mnemosyne-sub-c2.testnet` already has a working `report` key, but it's in the
keychain, which near-api-js can't read. Do steps 2–4 for C anyway (a second
report-only key, this one in `.env`). The old keychain report key can stay or
be deleted later; it does no harm.

`mnemosyne-sub-c.testnet` (the original) is bricked: no FullAccess key exists.
Leave it; it's not referenced anywhere any more.

---

## Done when

```
npm run cycle
```

Step 5 of the cycle shows all four subs `-> on-chain ACT/REFUSE` with tx
links, sub C refusing (reduce-only, tighter absolute ceiling), and sub D
refusing under its own 12%/3% ratio whenever the governor's default
envelope (20%/5%) is what built its directive -- two independent layers
disagreeing on purpose, not a coincidence of today's numbers. Exit 0.
Record that in HANDOFF.md.
