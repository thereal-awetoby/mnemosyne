# mnemosyne

Non-trading governor agent on NEAR: private decisions, on-chain memory
commitments, capability-limited sub-agents, and x402-paid memory queries.

> Mnemosyne is the memory and mandate layer for agent swarms on NEAR:
> decisions stay private, commitments go on-chain before any move, sub-agents
> act only under limited keys, and other agents pay to query that memory.

**One sentence to hold us to:** no capital path without an on-chain memory
commit; strategy stays private; subs only report under limited keys; other
agents pay to read the memory.

**[`PROOFS.md`](PROOFS.md) is the short way in** — every claim, its verdict, and
the transaction that settles it. It is generated from the cycle records by
`npm run prove`, so it cannot claim more than the records hold. Run
`npm run prove -- --live` and it re-checks itself against NEAR.

### Where to look

| What we claim | Open this | Or run |
|---------------|-----------|--------|
| A swarm with mandates, not a bot | [`src/subAgents.ts`](src/subAgents.ts), [`src/refuse.ts`](src/refuse.ts) | `npm run sub:check -- C` |
| Two independent ways to refuse | [`src/refuse.ts`](src/refuse.ts) (absolute ceilings for A/B/C vs. D's ratio of its own target) | `npx tsx --test src/refuse.test.ts` |
| The decision is private | [`src/private/`](src/private/) | `npm run tee:check` |
| The keys cannot spend | [`src/report.ts`](src/report.ts), [`contract/src/lib.rs`](contract/src/lib.rs) | `npm run sub:check -- A` |
| Memory is the gate | [`src/cycle.ts`](src/cycle.ts), [`src/memory.ts`](src/memory.ts) | `npm run prove -- --live` |
| Other agents pay for it | [`src/x402/`](src/x402/) | `npm run x402:client -- "your situation"` |
| The limits are the owner's, and public | [`src/limits/`](src/limits/) | `curl localhost:8402/limits` |
| The governor doesn't wait on a button | [`src/schedule.ts`](src/schedule.ts) | `curl localhost:8402/schedule` |
| A quote is a price, never a fill | [`src/allocate/cross_chain.ts`](src/allocate/cross_chain.ts) | `npm run crosschain:check` |

Full build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).
Build progress / what's been done in each step: [`HANDOFF.md`](HANDOFF.md).

## Current status: Phases 1–6 proven on NEAR testnet, including real x402 payments in wNEAR and private decisions verified in a NEAR AI Cloud TEE

One cycle runs: read -> decide -> **on-chain memory commit** (mnemosyne-gov.testnet, hash-chained, fail-closed) -> allocate (print-only by default; optional real wNEAR top-ups) -> **sub-agent window**: each sub checks the directive against its own mandate and writes ACT/REFUSE on-chain with its own report-only function-call key. Sub C (defensive, reduce-only) refuses directives above its tighter ceiling. Sub D (volatility-capped) refuses by a different mechanism entirely: its ceiling isn't a fixed number of units but a percentage of its *own* target capital (12% position / 3% loss), tighter than the governor's default envelope (20% / 5%) -- two independent layers of risk control that can disagree, not one rule wearing two names.

Proven on testnet 2026-10-30 (see HANDOFF.md): a full cycle committed memory, then sub A and B reported ACT and sub C reported REFUSE on-chain, each signing with its own report-only key. Every sub key passes `npm run sub:check`: it can call `report`, and NEAR itself rejects `commit` and transfers. The sub accounts' FullAccess keys stay in the operator's keychain and are never given to the agent.

**A 4th sub-agent, with a different kind of refuse rule.** `mnemosyne-sub-d.testnet` (`volatility_capped`) is built, tested (`src/refuse.test.ts`) and proven live on testnet 2026-11-02: the redeployed contract (`contract/src/lib.rs`, `SUB_ACCOUNTS` widened to four) left `commit_count` unchanged, and `npm run sub:check -- D` returned ALL PASS with a real on-chain report tx. Setup: [`docs/PHASE3_KEYS.md`](docs/PHASE3_KEYS.md), "Sub D: one extra first step."

**x402 memory API (Phase 5):** other agents pay per query to ask "does this situation match a failure Mnemosyne has already learned from?" -- no signup, no API key. They get back match / citation id / one-line public advice and a receipt; the private detail of each memory never leaves the server. Payments follow x402 v2 (HTTP 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`). Each payment is an ed25519-signed authorization from the payer's NEAR key, bound to price, recipient, network, endpoint, a time window and a single-use nonce. **Settlement is mocked:** the facilitator performs every check but records the payment in a local ledger instead of moving NEAR (ids start with `mock_`, responses say `mock: true`). Details: [`docs/X402.md`](docs/X402.md).

**Real settlement (testnet, proven):** with `X402_RAIL=near-testnet` the same API takes real wNEAR on NEAR testnet through the official x402 NEAR scheme, e.g. tx [`AAWMt68Q...`](https://testnet.nearblocks.io/txns/AAWMt68QRu8QEqcdeVf1VdeqnQMbyeDfpzMy6jd9tqzJ): an agent paid 0.001 wNEAR to `mnemosyne-gov.testnet` for a memory check; replaying the same payment was refused by NEAR's nonce. See "Two payment rails" in [`docs/X402.md`](docs/X402.md). Mock remains the default.

**Private decisions (Phase 6):** the governor reasons inside a NEAR AI Cloud TEE (Intel TDX + NVIDIA confidential GPU). Before a decision is used, Mnemosyne checks the enclave's signature over the exact request/response bytes, a fresh attestation bound to its own nonce, the Intel TDX quote and NVIDIA's GPU attestation; any failure stops the cycle before the memory commit. A deterministic policy guard clamps whatever the model proposes. The reasoning stays private; the public record carries only the decisions, a salted commitment to the private blob, and the TEE evidence. Without an API key it falls back to a local rule labelled `local-policy`. Details: [`docs/PRIVATE.md`](docs/PRIVATE.md).

Proven 2026-10-31: a cycle decided in the TEE (signature, nonce binding, Intel TDX `UpToDate`, NVIDIA GPU all verified) committed memory in [`BNv6Kg1R...`](https://testnet.nearblocks.io/txns/BNv6Kg1RwT8FuogbJoDXx19tKn5ozr95kjkGKtXm9Cii), then sub A and B reported ACT on-chain and sub C stayed paused. Its public record re-verified independently with `npm run tee:check -- --record`.

**Real balances and the owner's limits:** by default the swarm state and ALLOCATE are simulated and labelled as such. With `SWARM_STATE=onchain` READ uses each sub's real wNEAR balance, and with `ALLOCATE_MODE=wnear` the governor tops a sub up with a tiny real transfer, only after the memory commit and never above the committed target (no committed memory, no allocation). Losses stay a labelled simulation, because Mnemosyne doesn't trade. The owner can change the risk limits from the dashboard (admin token); each cycle writes the limits it used into its on-chain record. The per-cycle targets are the governor's decision and are not hand-editable. Details: [`docs/BALANCES_AND_LIMITS.md`](docs/BALANCES_AND_LIMITS.md).

**Cross-chain allocation (Phase 7, optional, quote only):** with `CROSS_CHAIN_ALLOCATE=1`, after the memory commit ALLOCATE asks Rhea (`@rhea-finance/cross-chain-aggregation-dex`) or NEAR Intents' 1Click API what it would cost to move a small slice of one sub's allocation from wNEAR on NEAR to USDC on Base. It only runs if the memory gate passes, only for a sub the committed record leaves at KEEP or INCREASE, never above that sub's committed target, only to an allowlisted destination, and every quote is logged with the decision hash and the memory tx that allowed it. **It is a price, not a fill: nothing is sent, signed or deposited.** Both networks are mainnet and this project is testnet-only, so executing is deliberately not wired. Off by default. Proven live on 2026-11-01 with NEAR Intents' 1Click (price only): 0.001 wNEAR -> about 0.001989 USDC on Base, allowed by memory commit [`B7Npf7hh...`](https://testnet.nearblocks.io/txns/B7Npf7hhmH8E6Q72tRMp5rGUAbtYLe5kGbihD9FvuuoP), quote id `5390e7af-7921-45a0-bc6d-8601974d99ad`; and again inside a full cycle (decided in the TEE, memory commit [`4ZFT4xBh...`](https://testnet.nearblocks.io/txns/4ZFT4xBhzunfhVfuNtjiLEt4VFVuucabaj7ckR4oHoiN), quote, then the sub reports). Details: [`docs/CROSS_CHAIN.md`](docs/CROSS_CHAIN.md).

**Sign in or sign up with a NEAR wallet (`/login`):** one button does both. The wallet signs a one-time NEP-413 message (not a transaction), the server checks the signature and that the key is a FullAccess key of that account, and sets an `HttpOnly` session cookie. A signed-up person gets personal guardrails for paid memory checks (daily query cap, daily spend cap, a pause switch) and their own receipts. **Login is never root:** it cannot run a cycle, change the governor's limits, write memory or touch a key; the tests prove it. Details: [`docs/LOGIN.md`](docs/LOGIN.md), plan and reasoning: [`docs/MULTIUSER_PLAN.md`](docs/MULTIUSER_PLAN.md).

**Pay for a check with that same wallet (`/pay`):** on the real rail, a signed-in person can pay for one memory check themselves -- a real NEP-366 delegate action signed by their own connected wallet, relayed by the server so they pay no gas -- instead of running the terminal demo agent. No new npm dependency and no server-side payment-logic change: it calls the wallet's own `signDelegateActions` and hand-assembles the same envelope the official x402 NEAR client would. `src/x402/nearRail.test.ts` proves that hand-built envelope settles against the real facilitator code, offline; an actual browser with a real wallet extension has not been exercised from this sandbox. Details: [`docs/X402.md`](docs/X402.md#paying-from-a-browser-wallet-instead-of-an-agent).

**The desk (`/dashboard`):** one dark page, live from NEAR testnet, with Overview, Memory, Sub-agents, Paid checks, Settings and Activity log, plus an activity rail. Anyone can read all of it and pay for a memory check; nothing on screen is written in field names or raw errors. The operator's controls (Run cycle, Edit limits, Automatic cycles) are hidden until that browser is unlocked with the admin token from the *Operator* link at the foot of the sidebar, and `/dashboard.json` carries only whether an operator exists, never the token.

**The governor runs itself, on a schedule:** `GET /schedule` / `PUT /schedule` (and the Settings panel's *Automatic cycles*) turn on an interval (5 to 1440 minutes) so a cycle fires on its own instead of waiting for someone to press Run cycle. A manual run and a scheduled one share one clock and one mutex, so they can never overlap or double-fire. Fail-closed applies to automation too: after three cycles in a row that do not commit, the schedule turns itself off and says why, rather than keep failing unattended. Off by default, and the interval is runtime state (`data/runtime/schedule.json`, gitignored), not an env var, so it survives a restart and anyone watching the dashboard can see when the next run is due.

Still simulated by default, and labeled as such: swarm losses (`SWARM_SCENARIO`), and x402 settlement in the default mock rail.

Sub-agent key setup: [`docs/PHASE3_KEYS.md`](docs/PHASE3_KEYS.md). Copy `.env.example` to `.env`.

## Run it

```
npm install
npm run cycle                 (one governor cycle)
npm run sub:keygen -- A       (new report-only key for a sub)
npm run sub:check -- A        (prove a sub key is scoped: report ok, commit/transfer rejected)
npm run verify:contract       (deployed wasm == local build, read-only)
npm run server                (x402 memory API + dashboard at http://localhost:8402/dashboard, sign-in at /login)
npm run x402:client -- "..."  (a third party, with no account or API key, pays for a memory check)
npm run prove                 (check every claim against the recorded cycles)
npm run prove:live            (the same, re-checked against NEAR: commit tx, sub reports, chain head)
npm run tee:check             (one verified private decision in the NEAR AI TEE, nothing on-chain)
npm run swarm:setup           (one-time: fund the subs with tiny testnet wNEAR for real balances)
npm run rail:check            (send 1 unit of real testnet wNEAR to a sub, only if the newest memory commit checks out)
npm run crosschain:check      (Phase 7: a cross-chain price for the newest committed record; quote only, nothing is sent)
npm run crosschain:probe      (Phase 7: if 1Click refuses a price request, find out why; prices only)
npm test                      (x402 + private-decision tests, no network needed)
```

This runs one cycle and prints each step. Run it again and you'll see
`prev_memory_hash` pick up the previous cycle's hash, chaining the log.

## Try the x402 memory API (do X -> see Y)

No NEAR keys needed for these steps. Use Node.js 22+ and two terminals at the repo root.

1. `npm run server` -> listens on `0.0.0.0:8402`, `memory entries: 6`, `facilitator: MOCK`.
2. `curl -i -X POST localhost:8402/memory/check -H "content-type: application/json" -d "{\"query\":\"delete the full access key\"}"` -> `HTTP/1.1 402 Payment Required`, a `PAYMENT-REQUIRED` header, and a JSON body quoting price (`amount` in yoctoNEAR), `payTo: mnemosyne-gov.testnet`, `network: near:testnet`. No answer is included.
3. `npm run x402:demo` -> an external agent (a fresh NEAR implicit account) gets the 402, signs the quoted price, retries, and receives `match: true (citation M-001, key-management)` plus one line of advice and a `receipt: R-...`. It then fetches the receipt and checks both hashes (`answer hash matches ... YES`), replays the same payment and gets `HTTP 402: nonce_already_used`. Last line: `DEMO OK`.
4. `npm run x402:demo -- "planning the team lunch menu"` -> still paid, but `match: false`: unrelated situations don't produce false citations.
5. Open `http://localhost:8402/audit` -> every paid check (receipt id, payer, amount, citation, `mock_` settlement id), and never the query text.
6. `npm test` -> 260 tests, no network needed. Among them: wrong amount, recipient, network, payer key, endpoint, expired or over-long window, tampered signature, replay, 8 concurrent uses of one payment (exactly 1 settles), restart persistence, admin-only routes, that `private_detail` never appears in any response, that a wallet session cannot reach an operator route, that a record with one byte changed no longer hashes to its commitment, that the schedule turns itself off after repeated failed cycles, that sub D's ceiling scales with its own target capital (raising the target alone never buys room), and that a hand-built `/pay`-style payment envelope settles the same way the official x402 client's does.

For a remote deployment, set `PUBLIC_URL` to its public HTTPS origin and point
`MNEMOSYNE_URL` at the same origin. Without a pinned URL, the demo also works
through a trusted reverse proxy that preserves Host and sets `X-Forwarded-Proto`.
See [`docs/X402.md`](docs/X402.md) for security limits and facilitator configuration.

Governor side (needs `.env` with testnet keys): `npm run cycle` -> step 3 prints a `MEMORY COMMIT` tx link; step 5 prints `on-chain ACT` for subs A and B and `on-chain REFUSE` for sub C, each with a tx link.
