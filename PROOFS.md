# Mnemosyne — proofs

Every claim this project makes, and where to check it. **This file is generated** by
`npm run prove -- --live --write` from the cycle records in `data/runtime/public/`, so it cannot say
something the records do not. Re-run it and it will tell you if a claim stopped holding.

Built 2026-11-02T12:52:20.328Z · 6 recorded cycles · 38 checks pass, 0 fail, 13 not applicable here · NEAR checks **included**

## The sentence the proofs have to carry

> No capital path without an on-chain memory commit. Strategy stays private.
> Subs only report under limited keys. Other agents pay to read the memory.

## Newest cycle: `2026-11-01T13:45:36.225Z-d95f8`

| Claim | Holds | What settles it |
|-------|-------|-----------------|
| The published record hashes to the commitment on NEAR | **yes** | sha256 of this file without decision_hash = 2aebc163d50d2f48…, which is the committed hash |
| Each record names the one before it | **yes** | follows 3f8a5e107da79a77…, the previous recorded cycle |
| No capital moves and no sub acts unless the memory commit landed | **yes** | the commit landed first (BRKrneuo59Xjk6tGDR5Pjfopxqj4pJ2ErYXw2a9RLUXy), then 2 sub report(s) followed |
| Every sub report names the decision it answers | **yes** | each on-chain reason is prefixed "cycle 2aebc163d50d", so the report cannot be moved to another decision |
| A cross-chain quote is bound to the decision that allowed it | not here | no cross-chain quote in this cycle |
| A cross-chain quote is a price, never a transfer | not here | no cross-chain quote in this cycle |
| The public record carries a commitment to the reasoning, never the reasoning | **yes** | only a hash of it: aee1ae73c9461ffb…, with the blob and its salt left on the operator's machine |
| A decision is only called sealed when the enclave evidence checks out | **yes** | signed by 0x835ab53d20294ef795906dff21ae4c045336aa26, bound to a fresh challenge, hashes match |
| The commit transaction on NEAR carries this exact hash | **yes** | BRKrneuo59Xjk6tGDR5Pjfopxqj4pJ2ErYXw2a9RLUXy finished successfully and logged MNEMOSYNE_COMMIT:sha256:2aebc163d50d2f48199b6cdffbac890f7072a2de42b18d773d7d24b2438f72f2:sha… |
| Each sub report is on NEAR, sent by the sub's own account | **yes** | sub B: ACT logged by mnemosyne-sub-b.testnet, naming this decision; sub C: REFUSE logged by mnemosyne-sub-c2.testnet, naming this decision |
| The hash NEAR holds is the newest record published here | **yes** | get_latest() on mnemosyne-gov.testnet returns 2aebc163d50d2f48… after 14 commits |

### The transactions

| Step | On NEAR | Proves |
|------|---------|--------|
| Memory commit | [BRKrneuo59…](https://testnet.nearblocks.io/txns/BRKrneuo59Xjk6tGDR5Pjfopxqj4pJ2ErYXw2a9RLUXy) | the decision was written before anything else ran |
| Sub B · ACT | [BDDpNEcrnP…](https://testnet.nearblocks.io/txns/BDDpNEcrnPsTerun8Rk3ompg6ybrvb4BweyNYpRpMAD) | a sub reporting under a key that cannot spend |
| Sub C · REFUSE | [9jruZAB8Fc…](https://testnet.nearblocks.io/txns/9jruZAB8FcxkdmXrj6WM25nKsqEkLAKwEt8gWyrkqCf3) | a sub refusing a directive past its own ceiling, on-chain |

## Check the main claim yourself, in 30 seconds

The published record is the thing that was committed. Take the newest file in
`data/runtime/public/`, drop its `decision_hash`, hash the rest, and you get the hash NEAR holds:

```bash
node -e "const r=require('./data/runtime/public/2026-11-01T13_45_36.225Z-d95f8.json'); const h=r.decision_hash; delete r.decision_hash; console.log(h === 'sha256:'+require('crypto').createHash('sha256').update(JSON.stringify(r)).digest('hex'))"
```

It prints `true`. Change one byte of that file and it prints `false`.

Then ask the contract what it is holding. No key, no account, nothing signed:

```bash
near view mnemosyne-gov.testnet get_latest '{}' --networkId testnet
```

It returns `["sha256:2aebc163d50d2f48199b6cdffbac890f7072a2de42b18d773d7d24b2438f72f2", "sha256:3f8a5e107da79a774ba9e873715a317a22de3d78fe67eeaaf9091a7c59441f32", <count>]`.
Change one byte of the record and the first value stops matching.

## Every recorded cycle

| Cycle | Decided | Record | Follows | Commit | Checks |
|-------|---------|--------|---------|--------|--------|
| `2026-11-01T13:45:36.225Z-d95f8` | sealed in a TEE | `2aebc163d50d2f48…` | `3f8a5e107da79a77…` | [tx](https://testnet.nearblocks.io/txns/BRKrneuo59Xjk6tGDR5Pjfopxqj4pJ2ErYXw2a9RLUXy) | 9 pass |
| `2026-11-01T10:54:48.874Z-6fee1` | sealed in a TEE | `3f8a5e107da79a77…` | `9bc88d03d09cda8f…` | [tx](https://testnet.nearblocks.io/txns/4ZFT4xBhzunfhVfuNtjiLEt4VFVuucabaj7ckR4oHoiN) | 8 pass |
| `2026-11-01T09:18:40.968Z-a4262` | sealed in a TEE | `9bc88d03d09cda8f…` | `669cc468d314bf6f…` | [tx](https://testnet.nearblocks.io/txns/B7Npf7hhmH8E6Q72tRMp5rGUAbtYLe5kGbihD9FvuuoP) | 6 pass |
| `2026-11-01T08:59:38.518Z-47dbe` | sealed in a TEE | `669cc468d314bf6f…` | `d063222698993c75…` | [tx](https://testnet.nearblocks.io/txns/9m8E4Ma4B9qUMVcCNvQzTbVjw5LzUnYoxy3zfZ6DUtvt) | 6 pass |
| `2026-11-01T08:15:48.559Z-fddf6` | sealed in a TEE | `d063222698993c75…` | `836c62897ac6d9ca…` | [tx](https://testnet.nearblocks.io/txns/HNbuxFbeDCnSz5Mjo4USaA8yXTWCwUCtjy7xYywnkbwx) | 6 pass |
| `2026-10-31T17:12:35.005Z-ae8e8` | sealed in a TEE | `836c62897ac6d9ca…` | `301228bab6f26de9…` | — | 3 pass |

## What must not be possible

These are enforced in code and covered by the automated suite (`npm test`):

| It must not be possible to | Where it is refused |
|----------------------------|---------------------|
| Allocate or quote before the memory commit lands | `src/cycle.ts` fails closed; `src/allocate/cross_chain.ts` refuses a quote with no commit |
| Write global memory with a sub-agent key | the contract panics: only the governor account may commit |
| Give a sub a directive above its own ceiling | the sub answers `REFUSE` on-chain (`src/refuse.ts`) |
| Reuse a settled x402 payment | the nonce is spent and the retry is refused (`src/x402/`) |
| Get the private detail out of a paid answer | the answer carries a citation and one line only |
| Reach an operator route with a wallet session | admin routes answer 401 to a session cookie (`src/auth/`) |
| Run a cycle from the browser without the admin token | the desk hides the control and the route needs a bearer token |

## What is deliberately not claimed

- **Quotes are not fills.** The cross-chain step prices a route after the commit and sends nothing. A quote with a deposit address is refused.
- **Sealed means sealed.** A cycle is only called a TEE decision when the enclave evidence checks out; otherwise the record says the built-in rule decided, and says so on-chain too.
- **Testnet.** Every transaction linked here is NEAR testnet. No mainnet funds are involved.
- **Mnemosyne does not trade.** Balances can be real; the losses in the swarm scenario are a labelled simulation.
- **Users are buyers, not governors.** A wallet login sets that person's own spending limits. It never reaches a governor key, and it cannot write memory.
