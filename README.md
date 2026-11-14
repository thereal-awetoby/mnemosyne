# mnemosyne

**Mnemosyne is an AI agent that decides in private, proves every decision on NEAR, and lets other agents pay to avoid mistakes it's already learned from.**

> It is the memory and mandate layer for agent swarms on NEAR: each decision
> is sealed inside a **NEAR AI Cloud TEE**, an **on-chain memory commit** is
> what makes it count before anything moves, sub-agents act only under
> limited keys, and other agents reach that memory through a **paid query**
> over x402.

**One sentence to hold us to:** no capital path without an on-chain memory
commit; strategy stays private; subs only report under limited keys; other
agents pay to read the memory.

Built for **NEAR Hackathon — Build Beyond Boundaries** (1–14 Nov 2026) by
[Makinde Ahmed](https://github.com/thereal-awetoby). Submitted under
**Privacy** (primary track) and **Agents** (secondary track).

## Try it live, right now

**[`mnemosyne-dih2.onrender.com/dashboard`](https://mnemosyne-dih2.onrender.com/dashboard)**
— no install, no keys. Sign in with a NEAR wallet (Intear Wallet is the one
this was demoed with), run a paid memory check, watch the receipt come back
with a citation and a NEAR testnet transaction. The operator controls (*Run
cycle*, *Edit limits*) are locked behind an admin token on the live
instance — everything else a judge needs to see is open to read, including
the full chain of past cycles and every paid check's audit trail.

**[`PROOFS.md`](PROOFS.md) is the short way in** — every claim, its verdict, and
the transaction that settles it. It is generated from the cycle records by
`npm run prove`, so it cannot claim more than the records hold. Run
`npm run prove -- --live` and it re-checks itself against NEAR.

### Try it locally in five minutes

`npm install`, copy `.env.example` to `.env`, `npm run server`, then open http://localhost:8402/dashboard. No keys needed.
[`docs/DEMO_CHECKLIST.md`](docs/DEMO_CHECKLIST.md) lists the exact clicks to see one full cycle (with its proof on NEAR testnet and a sub-agent refusing on-chain) and one paid check, each as "do X, see Y". The dashboard's **How it works** tab explains the whole system in plain English.

## Contents

- [Where to look](#where-to-look)
- [NEAR primitives used](#near-primitives-used)
- [What's private, what's public](#whats-private-whats-public)
- [Honest limits, up front](#honest-limits-up-front)
- [What's built](#whats-built)
- [Run it](#run-it)
- [Try the x402 memory API](#try-the-x402-memory-api-do-x---see-y)

## Where to look

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
| Pay from another chain (price only) | [`src/payments/inbound.ts`](src/payments/inbound.ts) | `npx tsx --test src/payments/inbound.test.ts` |
| Pay from Base Sepolia, for real | [`src/payments/chainsig.ts`](src/payments/chainsig.ts) | `npx tsx --test src/payments/chainsig.test.ts` |
| Sweep deposits to collection | [`src/payments/sweep.ts`](src/payments/sweep.ts) | `npx tsx --test src/payments/sweep.test.ts` |

Full build plan: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md).
Build progress / what's been done in each step: [`HANDOFF.md`](HANDOFF.md).

## NEAR primitives used

| Primitive | How Mnemosyne uses it |
|---|---|
| Named sub-accounts, one per role | `mnemosyne-gov.testnet` (governor) plus one account per sub-agent — a key boundary drawn with accounts, not just application code |
| Function-call (limited) access keys | Each sub-agent's key can only call `report()`. NEAR itself rejects `commit` or a transfer from that key — enforced by the protocol, not by Mnemosyne choosing to behave |
| A deployed contract ([`contract/src/lib.rs`](contract/src/lib.rs)) | `MemoryContract`: hash-chained memory commits (`commit`, `get_latest`) and per-sub `report()` logging |
| NEAR AI Cloud (TEE: Intel TDX + NVIDIA confidential GPU) | The governor's reasoning runs inside the enclave; Mnemosyne checks the enclave's signature, a fresh nonce-bound attestation, and both hardware quotes before it will trust the decision |
| wNEAR (NEP-141) + x402 | Other agents or users pay a small wNEAR fee per memory query over the x402 protocol (HTTP 402 challenge/response) |
| NEP-413 message signing | Wallet sign-in / sign-up (`/login`) — proves control of a key without ever sending a transaction |
| NEP-366 delegate actions | Paying for a check from a browser wallet (`/pay`) — a gas-relayed signed action, not a raw transfer |
| NEAR Chain Signatures (MPC, `v1.signer-prod.testnet`) | Lets `mnemosyne-gov.testnet` control an address on Base Sepolia with no key ever leaving NEAR, for inbound cross-chain payment |
| NEAR Intents (1Click) | An optional, memory-gated cross-chain price quote (wNEAR → USDC on Base) — price only, nothing ever executes |

## What's private, what's public

The governor's actual reasoning — the text behind *why* it decided what it
decided — is generated inside the TEE and never leaves the operator's
machine: not in a log, not in this repository, not in any API response.
What becomes part of the public, on-chain record is only: the decision
itself (ACT / REFUSE / PAUSE per sub, and targets), the risk limits that
produced it, a salted sha256 **commitment** to the private reasoning blob,
and the TEE's attestation evidence (enclave signature, nonce, Intel TDX and
NVIDIA GPU quotes). `npm run prove` and [`PROOFS.md`](PROOFS.md) re-derive
that commitment from the public record and check it against what NEAR
actually holds — so "private" here is a claim you can check, not one you
have to take on trust.

## Honest limits, up front

So this is easy to find rather than something you discover mid-read:

- **Mnemosyne does not trade.** Swarm profit/loss (`SWARM_SCENARIO`) is a
  labelled simulation, always.
- **x402 settlement defaults to a mock rail.** Real wNEAR settlement is
  built and proven on testnet (several transactions linked below), but it
  is off by default and has to be turned on (`X402_RAIL=near-testnet`).
- **Cross-chain is a price quote, never a fill.** Both the outbound quote
  (Rhea / NEAR Intents 1Click) and the inbound quote (paying from Base
  Sepolia) only ever price a route. Nothing is sent, signed, or deposited
  by either path, and both query mainnet pricing APIs from a project that
  only settles on testnet.
- **One real chain hasn't been reached from this build environment:** the
  inbound Base-Sepolia payment and the deposit-sweep step are both fully
  built and tested against the real NEAR MPC contract (`v1.signer-prod.testnet`
  really does derive the addresses this project uses), but no actual
  Base Sepolia transaction has been sent or swept from here — the build
  sandbox cannot reach a Base node. That needs only faucet ETH and a
  live run; it's the one step left in that path.
- **Rhea Finance's own quote API wasn't reachable live** (their portal's
  email verification never completed), so the outbound cross-chain quote
  is proven through NEAR Intents' 1Click instead, which covers the same
  step.

Everything else below is marked as proven, live, and dated — with the
transaction that backs it.

## What's built

One cycle runs: read -> decide -> **on-chain memory commit** (mnemosyne-gov.testnet, hash-chained, fail-closed) -> allocate (print-only by default; optional real wNEAR top-ups) -> **sub-agent window**: each sub checks the directive against its own mandate and writes ACT/REFUSE on-chain with its own report-only function-call key. Sub C (defensive, reduce-only) refuses directives above its tighter ceiling. Sub D (volatility-capped) refuses by a different mechanism entirely: its ceiling isn't a fixed number of units but a percentage of its *own* target capital (12% position / 3% loss), tighter than the governor's default envelope (20% / 5%) -- two independent layers of risk control that can disagree, not one rule wearing two names.

Proven on testnet 2026-10-30 (see HANDOFF.md): a full cycle committed memory, then sub A and B reported ACT and sub C reported REFUSE on-chain, each signing with its own report-only key. Every sub key passes `npm run sub:check`: it can call `report`, and NEAR itself rejects `commit` and transfers. The sub accounts' FullAccess keys stay in the operator's keychain and are never given to the agent.

### A fourth sub-agent, a different refuse rule

`mnemosyne-sub-d.testnet` (`volatility_capped`) is built, tested (`src/refuse.test.ts`) and proven live on testnet 2026-11-02: the redeployed contract (`contract/src/lib.rs`, `SUB_ACCOUNTS` widened to four) left `commit_count` unchanged, and `npm run sub:check -- D` returned ALL PASS with a real on-chain report tx. Setup: [`docs/PHASE3_KEYS.md`](docs/PHASE3_KEYS.md), "Sub D: one extra first step."

### Paid memory API (x402, Phase 5)

Other agents pay per query to ask "does this situation match a failure Mnemosyne has already learned from?" -- no signup, no API key. They get back match / citation id / one-line public advice and a receipt; the private detail of each memory never leaves the server. Payments follow x402 v2 (HTTP 402 + `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`). Each payment is an ed25519-signed authorization from the payer's NEAR key, bound to price, recipient, network, endpoint, a time window and a single-use nonce. **Settlement is mocked:** the facilitator performs every check but records the payment in a local ledger instead of moving NEAR (ids start with `mock_`, responses say `mock: true`). Details: [`docs/X402.md`](docs/X402.md).

**Real settlement (testnet, proven):** with `X402_RAIL=near-testnet` the same API takes real wNEAR on NEAR testnet through the official x402 NEAR scheme, e.g. tx [`AAWMt68Q...`](https://testnet.nearblocks.io/txns/AAWMt68QRu8QEqcdeVf1VdeqnQMbyeDfpzMy6jd9tqzJ): an agent paid 0.001 wNEAR to `mnemosyne-gov.testnet` for a memory check; replaying the same payment was refused by NEAR's nonce. See "Two payment rails" in [`docs/X402.md`](docs/X402.md). Mock remains the default.

**Proven live from a real connected wallet, on the production site (14 Nov 2026):** a real NEAR wallet paid for a check on the live dashboard above and got back a citation, advice and a receipt — `R-47e586704d21897bafba3812`, matched against lesson `M-002 · Fail closed`, 0.001 wNEAR from `tobydavi.testnet`. Open the live dashboard's Paid checks panel to pull up any receipt by id and its NEAR testnet transaction link yourself; this is a running system, not a recording.

### Private decisions in a TEE (Phase 6)

The governor reasons inside a NEAR AI Cloud TEE (Intel TDX + NVIDIA confidential GPU). Before a decision is used, Mnemosyne checks the enclave's signature over the exact request/response bytes, a fresh attestation bound to its own nonce, the Intel TDX quote and NVIDIA's GPU attestation; any failure stops the cycle before the memory commit. A deterministic policy guard clamps whatever the model proposes. The reasoning stays private; the public record carries only the decisions, a salted commitment to the private blob, and the TEE evidence. Without an API key it falls back to a local rule labelled `local-policy`. Details: [`docs/PRIVATE.md`](docs/PRIVATE.md).

Proven 2026-10-31: a cycle decided in the TEE (signature, nonce binding, Intel TDX `UpToDate`, NVIDIA GPU all verified) committed memory in [`BNv6Kg1R...`](https://testnet.nearblocks.io/txns/BNv6Kg1RwT8FuogbJoDXx19tKn5ozr95kjkGKtXm9Cii), then sub A and B reported ACT on-chain and sub C stayed paused. Its public record re-verified independently with `npm run tee:check -- --record`.

### Real balances and the owner's limits

By default the swarm state and ALLOCATE are simulated and labelled as such. With `SWARM_STATE=onchain` READ uses each sub's real wNEAR balance, and with `ALLOCATE_MODE=wnear` the governor tops a sub up with a tiny real transfer, only after the memory commit and never above the committed target (no committed memory, no allocation). Losses stay a labelled simulation, because Mnemosyne doesn't trade. The owner can change the risk limits from the dashboard (admin token); each cycle writes the limits it used into its on-chain record. The per-cycle targets are the governor's decision and are not hand-editable. Details: [`docs/BALANCES_AND_LIMITS.md`](docs/BALANCES_AND_LIMITS.md).

### Cross-chain allocation, outbound (Phase 7, quote only)

With `CROSS_CHAIN_ALLOCATE=1`, after the memory commit ALLOCATE asks Rhea (`@rhea-finance/cross-chain-aggregation-dex`) or NEAR Intents' 1Click API what it would cost to move a small slice of one sub's allocation from wNEAR on NEAR to USDC on Base. It only runs if the memory gate passes, only for a sub the committed record leaves at KEEP or INCREASE, never above that sub's committed target, only to an allowlisted destination, and every quote is logged with the decision hash and the memory tx that allowed it. **It is a price, not a fill: nothing is sent, signed or deposited.** Both networks are mainnet and this project is testnet-only, so executing is deliberately not wired. Off by default. Proven live on 2026-11-01 with NEAR Intents' 1Click (price only): 0.001 wNEAR -> about 0.001989 USDC on Base, allowed by memory commit [`B7Npf7hh...`](https://testnet.nearblocks.io/txns/B7Npf7hhmH8E6Q72tRMp5rGUAbtYLe5kGbihD9FvuuoP), quote id `5390e7af-7921-45a0-bc6d-8601974d99ad`; and again inside a full cycle (decided in the TEE, memory commit [`4ZFT4xBh...`](https://testnet.nearblocks.io/txns/4ZFT4xBhzunfhVfuNtjiLEt4VFVuucabaj7ckR4oHoiN), quote, then the sub reports). Details: [`docs/CROSS_CHAIN.md`](docs/CROSS_CHAIN.md).

### Cross-chain payment, inbound (NEAR Chain Signatures)

Nothing bridges to NEAR testnet — 1Click has no testnet and says it never will, and Omni Bridge's testnet EVM→NEAR path is openly broken (mints ~10⁶× too little, credits the bridge account, no refund path). So this route doesn't bridge. **The payer pays on Base Sepolia and the governor receives on Base Sepolia**, at an address derived from `mnemosyne-gov.testnet` through NEAR Chain Signatures — an address only that NEAR account can ever spend from, with nothing deployed on Base and no signature needed to receive. Each quote derives its own address (`mnemosyne-check-<quote_id>`), which makes settlement a plain balance check and makes one payment satisfying two quotes structurally impossible. The derivation isn't reimplemented: the MPC contract's own `derived_public_key` view method is the source of truth. `POST /memory/quote {chain:"base-sepolia:ETH"}` → send the ETH → `POST /memory/check {quote_id}` → answer plus a receipt carrying `source_chain`, `source_address` and `source_controlled_by`. An unreadable Base node is never read as paid, balances are read at `latest` not `pending`, and six simultaneous redemptions of one payment yield exactly one answer (tested). **Verified live:** the real MPC contract derives distinct valid addresses for distinct quotes on NEAR testnet. Off by default (`CROSS_CHAIN_INBOUND=1` + `CROSS_CHAIN_PAYABLE=1`).

### Fund collection (sweep)

Settled cross-chain deposits accumulate at per-quote addresses the governor controls through Chain Signatures. `POST /admin/sweep` (admin-guarded) finds every settled payable quote, reads its deposit balance, and sweeps it to a single collection address (`mnemosyne-treasury` derivation path) via MPC-signed EIP-1559 transactions on Base Sepolia. Gas is paid from each deposit's own balance. The collection address is derived lazily from the same MPC contract (`v1.signer-prod.testnet`), so only `mnemosyne-gov.testnet` can ever spend what lands there. The dashboard's Settings panel shows settled deposits and a one-click Sweep button (operator only). Requires `CROSS_CHAIN_PAYABLE=1` and `GOVERNOR_PRIVATE_KEY`.

### Paying from another chain, quote only (Multi-chain Phase 1)

`POST /memory/quote` answers "I hold USDC on Base — what would a memory check cost me?", priced by NEAR Intents' 1Click as an `EXACT_OUTPUT` swap (what is fixed is the 0.001 wNEAR that must *arrive*; what varies is what the payer sends). **It stops at the price on purpose:** nothing settles one of these yet, `/memory/check` does not accept a quote id, and a test proves presenting one still returns 402. Each quote is bound to its question by hash (never the text), logged against the memory chain head, and single-use. A provider that returns a deposit address on a dry quote, prices a smaller delivery than the listed price, or goes down is refused — and the refusal says that paying in wNEAR on NEAR still works. Honest limit: 1Click prices **mainnet** assets while this server settles on NEAR **testnet**, so an inbound quote is a real price for a route that cannot yet deliver to `mnemosyne-gov.testnet`. Off by default (`CROSS_CHAIN_INBOUND=1`). Details: [`docs/CROSS_CHAIN.md`](docs/CROSS_CHAIN.md#paying-from-another-chain-inbound-phase-1).

### Sign in / sign up with a NEAR wallet

One button does both (`/login`). The wallet signs a one-time NEP-413 message (not a transaction), the server checks the signature and that the key is a FullAccess key of that account, and sets an `HttpOnly` session cookie. A signed-up person gets personal guardrails for paid memory checks (daily query cap, daily spend cap, a pause switch) and their own receipts. **Login is never root:** it cannot run a cycle, change the governor's limits, write memory or touch a key; the tests prove it. Details: [`docs/LOGIN.md`](docs/LOGIN.md), plan and reasoning: [`docs/MULTIUSER_PLAN.md`](docs/MULTIUSER_PLAN.md).

### Pay with that same wallet, in one press

On the real rail, pressing *Pay & get answer* on the desk opens the wallet in a popup over the page -- no second page to navigate back from, and no "ask for a price, then retry" two-step: the 402 quote is fetched behind the button, because an unpaid quote costs nothing and nobody should have to ask permission to pay. The popup hands the finished check back to the desk and closes itself. It is a popup and not an embedded frame on purpose: `/pay` sets `frame-ancestors 'none'`, and `/dashboard` keeps its strict policy with no wallet code and no outside origins, which is what keeps signing isolated to the one page that needs it. **Not every wallet can sign this:** paying needs a NEP-366 delegate action, which only Intear Wallet and Meteor Wallet currently support -- Nightly, MyNearWallet, OKX, Hana and WalletConnect can all sign in (`/login` only needs a NEP-413 message) but cannot pay. `/pay` filters its wallet picker down to capable wallets and, if the one you're already signed in with isn't one of them, says so plainly instead of leaving you guessing why it disappeared. **This build demos with Intear Wallet** (tested as the smoothest connect-to-pay path on testnet); Meteor also works.

A testnet faucet gives out NEAR, but the price is in wNEAR, a NEP-141 token -- so a wallet holding only faucet NEAR could sign a payment that was then refused at settlement. `/pay` reads what the payer actually holds (`GET /pay/payer-status`) *before* anything is signed, and offers to wrap exactly the shortfall first: one ordinary transaction (`storage_deposit` the first time, then `near_deposit`), then the payment itself. The wrap cannot ride inside the payment -- the official x402 verifier accepts a delegate action only when it carries exactly one action -- so it is deliberately its own signature. The payment itself is server-side-identical to an agent's: a real NEP-366 delegate action signed by the connected wallet, relayed so the payer pays no gas, hand-assembled into the same envelope the official x402 NEAR client builds. Details: [`docs/X402.md`](docs/X402.md#paying-from-a-browser-wallet-instead-of-an-agent).

### The dashboard

One dark page, live from NEAR testnet, with Overview, Memory, Sub-agents, Paid checks, Settings and Activity log, plus an activity rail. Anyone can read all of it and pay for a memory check; nothing on screen is written in field names or raw errors. The operator's controls (Run cycle, Edit limits, Automatic cycles) are hidden until that browser is unlocked with the admin token from the *Operator* link at the foot of the sidebar, and `/dashboard.json` carries only whether an operator exists, never the token.

### Self-scheduling

`GET /schedule` / `PUT /schedule` (and the Settings panel's *Automatic cycles*) turn on an interval (5 to 1440 minutes) so a cycle fires on its own instead of waiting for someone to press Run cycle. A manual run and a scheduled one share one clock and one mutex, so they can never overlap or double-fire. Fail-closed applies to automation too: after three cycles in a row that do not commit, the schedule turns itself off and says why, rather than keep failing unattended. Off by default, and the interval is runtime state (`data/runtime/schedule.json`, gitignored), not an env var, so it survives a restart and anyone watching the dashboard can see when the next run is due.

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
npm run typecheck             (tsc --noEmit)
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
6. `npm test` -> 336 tests, no network needed. Among them: wrong amount, recipient, network, payer key, endpoint, expired or over-long window, tampered signature, replay, concurrent uses of one payment (exactly one settles), restart persistence, admin-only routes, that `private_detail` never appears in any response, that a wallet session cannot reach an operator route, that a record with one byte changed no longer hashes to its commitment, that the schedule turns itself off after repeated failed cycles, that sub D's ceiling scales with its own target capital (raising the target alone never buys room), and that a hand-built `/pay`-style payment envelope settles the same way the official x402 client's does.

For a remote deployment, set `PUBLIC_URL` to its public HTTPS origin and point
`MNEMOSYNE_URL` at the same origin. Without a pinned URL, the demo also works
through a trusted reverse proxy that preserves Host and sets `X-Forwarded-Proto`.
See [`docs/X402.md`](docs/X402.md) for security limits and facilitator configuration.

Governor side (needs `.env` with testnet keys): `npm run cycle` -> step 3 prints a `MEMORY COMMIT` tx link; step 5 prints `on-chain ACT` for subs A and B and `on-chain REFUSE` for sub C, each with a tx link.

---

Full build history, patch by patch: [`HANDOFF.md`](HANDOFF.md). Build plan and
hackathon notes: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md). Demo script and
submission draft: [`docs/SUBMISSION.md`](docs/SUBMISSION.md).
