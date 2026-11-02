# Mnemosyne — proofs

Every claim this project makes, and where to check it. **This file is generated** by
`npm run prove -- --write` from the cycle records in `data/runtime/public/`, so it cannot say
something the records do not. Re-run it and it will tell you if a claim stopped holding.

Built 2026-11-02T12:39:26.243Z · 1 recorded cycle · 3 checks pass, 0 fail, 5 not applicable here · NEAR checks not run (pass `--live`)

## The sentence the proofs have to carry

> No capital path without an on-chain memory commit. Strategy stays private.
> Subs only report under limited keys. Other agents pay to read the memory.

## Newest cycle: `2026-10-31T16:03:07.515Z-51f71`

| Claim | Holds | What settles it |
|-------|-------|-----------------|
| The published record hashes to the commitment on NEAR | **yes** | sha256 of this file without decision_hash = ca787654442cb2b0…, which is the committed hash |
| Each record names the one before it | not here | it follows 301228bab6f26de9…, which is not in this copy of the records |
| No capital moves and no sub acts unless the memory commit landed | not here | no run log was kept for this cycle |
| Every sub report names the decision it answers | not here | no sub reported on-chain in this cycle |
| A cross-chain quote is bound to the decision that allowed it | not here | no cross-chain quote in this cycle |
| A cross-chain quote is a price, never a transfer | not here | no cross-chain quote in this cycle |
| The public record carries a commitment to the reasoning, never the reasoning | **yes** | only a hash of it: 4080797cd4d4dcee…, with the blob and its salt left on the operator's machine |
| A decision is only called sealed when the enclave evidence checks out | **yes** | signed by 0x835ab53d20294ef795906dff21ae4c045336aa26, bound to a fresh challenge, hashes match |

### The transactions

| Step | On NEAR | Proves |
|------|---------|--------|
| Memory commit | — | the decision was written before anything else ran |

## Check the main claim yourself, in 30 seconds

The published record is the thing that was committed. Take the newest file in
`data/runtime/public/`, drop its `decision_hash`, hash the rest, and you get the hash NEAR holds:

```bash
node -e "const r=require('./data/runtime/public/2026-10-31T16_03_07.515Z-51f71.json'); const h=r.decision_hash; delete r.decision_hash; console.log(h === 'sha256:'+require('crypto').createHash('sha256').update(JSON.stringify(r)).digest('hex'))"
```

It prints `true`. Change one byte of that file and it prints `false`.

Then ask the contract what it is holding. No key, no account, nothing signed:

```bash
near view mnemosyne-gov.testnet get_latest '{}' --networkId testnet
```

It returns `["sha256:ca787654442cb2b05219bea5309af5f25067539ebb696cb3ed16030055fc88ad", "sha256:301228bab6f26de932ed76c7ed6d0b9329bf3fba9d3bb7375e49bcef63b2aa0d", <count>]`.
Change one byte of the record and the first value stops matching.

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
