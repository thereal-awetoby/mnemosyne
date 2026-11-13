# Demo checklist

The exact clicks to see one full cycle and one paid check. Each step says what to do and what you should see. Needs Node.js 22+.

## Setup (about 2 minutes, no keys needed)

1. `npm install`
2. Copy `.env.example` to `.env`. To see the operator controls, add one line: `ADMIN_TOKEN=any-long-string`.
3. `npm run server` → the terminal prints `dashboard: http://localhost:8402/dashboard`.
4. Open **http://localhost:8402/dashboard**.

## A. One full cycle (already recorded on NEAR testnet)

| # | Do | See |
|---|---|---|
| 1 | Open **Overview** | **How the last cycle ran**: six steps, from *Read the state* to *Publish*, and a tag such as **Completed · 1 refusal** |
| 2 | Under **Proof on NEAR**, click **View on NEAR ↗** | The decision's fingerprint on the public NEAR testnet explorer (nearblocks.io) |
| 3 | Open **Sub-agents** | Four helpers. Sub C is **Refused**, with the reason in one sentence: it was told it could put 200 units into one position, but its own safety limit is 150 |
| 4 | Open **Activity log** | Every step of the newest cycle. Step 5 links to each helper's own report on NEAR, written with a key that can't spend |
| 5 | Open **Memory** | Each decision linked (✓) to the one before it. Click any ID to copy it |

## B. One paid check (no wallet needed)

| # | Do | See |
|---|---|---|
| 1 | Open **Paid checks** | The price (0.001 NEAR) and four example questions under **Try** |
| 2 | Click the example **Delete an old full-access key**, then **Ask & pay** | A confirm box: *You're about to pay 0.001 NEAR … to ask: "…"*. Nothing is paid yet |
| 3 | Click **Confirm & pay 0.001 NEAR** | **Your answer: Yes, this matches a mistake Mnemosyne has learned from**, lesson **M-001 · Key management**, one line of advice, and a receipt ID |
| 4 | Try **Plan the team lunch (no match)** the same way | **No match**: unrelated questions don't produce false matches |
| 5 | Scroll to **Everyone's paid checks** | Your checks listed with receipts; the question text itself is never shown |

On a default local setup these are test payments: every check on the payment runs, but nothing real is charged. The real wNEAR payment on testnet is proven here: [`AAWMt68Q...`](https://testnet.nearblocks.io/txns/AAWMt68QRu8QEqcdeVf1VdeqnQMbyeDfpzMy6jd9tqzJ). Run it yourself with `npm run x402:demo:real` (needs testnet keys).

## C. The safety rule, live (optional, operator)

| # | Do | See |
|---|---|---|
| 1 | Click **Operator** (top right), paste your `ADMIN_TOKEN`, click **Unlock** | **Operator · unlocked**, and a **Run cycle** button on Overview |
| 2 | Click **Run cycle** → **Run now** | Without the governor's testnet key, the cycle **stops at step 3**: *the governor's NEAR key isn't set up on this computer… nothing moved*. That's the memory gate: no proof on NEAR, no action |
| 3 | Click **See what happened** in the red banner | The Activity log opens on that exact run, with steps 4–6 marked **Skipped** |

With the team's testnet keys in `.env`, the same button runs a real cycle: decided in the sealed chip, proof written to NEAR, then the sub-agents report on-chain.

Your test runs write files under `data/runtime/public/`. Don't commit them: `git checkout -- data/runtime && git clean -fd data/runtime/public data/runtime/proofs`.

## Without the dashboard

```
npm test              # 336 tests, no network needed
npm run prove         # every claim in PROOFS.md checked against the recorded cycles
npm run prove:live    # the same, re-checked against NEAR testnet
npm run x402:demo     # an outside agent with no account pays for a check, then a replay is refused
```
