# Demo and submission kit

Drafts only. **Nothing is submitted until you do it: the form cannot be edited after it is sent** (`docs/BUILD_PLAN.md` section 17). Build window 1 to 14 Nov 2026, repository public by 14 Nov 23:59 UTC, judging 16 to 18 Nov.

## 1. The 2-minute demo (record this for the X post)

Run `npm run server` with `ADMIN_TOKEN` set in `.env`, open `http://localhost:8402/dashboard`. Each step says what to say and what is real.

| # | Do | Say | Real? |
| --- | --- | --- | --- |
| 1 | **Desk.** Point at the two pills and the cycle spine. | "A governor agent that never trades. No on-chain memory commit, no money moves." | live data from testnet |
| 2 | **Run cycle** (top right), paste the admin token. Wait for the green banner. | "It decides privately in a NEAR AI Cloud TEE, then commits a hash to NEAR. If the commit fails, the cycle stops." | real cycle, real commit |
| 3 | **Audit.** Open the six steps; click the memory commit transaction on nearblocks. | "Here is the commitment on-chain. The reasoning stays private; only a hash and the TEE evidence are public." | real tx |
| 4 | **Memory.** Show the chain and the gold HEAD tag. | "Each entry points at the one before it." | real |
| 5 | **Sub-agents.** Show ACT / REFUSE and the report links. | "Each sub signs with a key that can only call report(). One refuses a directive over its ceiling, on-chain." | real txs |
| 6 | **x402 checks.** Press Request check (402 and the price), then Pay & retry. | "Another agent pays per query and gets a citation and one line of advice, never the private detail." | the in-page payer is a labelled demo agent on the mock rail. For the real wNEAR payment run `npm run x402:demo:real` in a terminal and show its transaction link |
| 7 | **Connect NEAR**, sign in, create the account, set Max queries to 1 or press Pause, then Request check. | "Login is identity, never root. My own limits stop the request before the server even quotes a price." | sign-in and sign-up proven live with a real wallet; try the pause once yourself before recording |
| 8 | **Guardrails, Governor limits.** Show the owner's rails. | "A human sets the limits; every cycle writes the ones it used into its on-chain record." | real |

Say plainly at the end: it does not trade (losses are a labelled simulation), cross-chain is a price quote only, everything is testnet.

## 2. Post on X (a human must post it)

Must say it was built at NEAR HACKATHON and show the video or screenshots. Draft (224 characters with the link counted as 23, leaving room to add tags and a live-demo link):

```
Mnemosyne: an AI agent that decides in private, proves it on NEAR, and lets other agents pay to avoid mistakes it already learned from.

Built at NEAR HACKATHON. No trading, no hidden strategy.

Repo: <GITHUB URL>
```

## 3. The form at https://nearhackathon.com/#apply

| Field | Value |
| --- | --- |
| projectName | Mnemosyne |
| leadName | Makinde Ahmed (confirm) |
| email | your email (must be unique) |
| size | your team size, in the form's format |
| tracks | `["privacy","agents"]` -- privacy is the primary claim (decisions sealed in a TEE, only a hash goes public); agents is secondary and just as real (other agents actually pay wNEAR per query over x402, no account or API key needed). Deliberately two, not three or four: security, swarms and business were all considered and dropped -- the build touches pieces of each (report-only sub-keys NEAR itself enforces, owner-set limits written into every record, per-account guardrails) but doesn't make any of them the pitch, and padding the track list past the two it's actually about reads as unfocused to a judge skimming fast. |
| nearAddress | a wallet you control that can receive the prize |
| projectUrl | the public GitHub URL |
| demoUrl | the URL of your X post |
| idea | below (1757 characters; the form takes 20 to 2000) |

Use `"agents"` only if you show an x402 paid check in the video (step 6). It works on the mock rail and, proven, on real wNEAR.

```
Problem: Multi-agent systems that move money either hand agents too many keys or hide the process so nobody can check the rules. Agents also can't easily pay each other for useful knowledge without accounts and API keys.

Product: Mnemosyne is a non-trading governor on NEAR. Each cycle it decides privately inside a NEAR AI Cloud TEE (Intel TDX + NVIDIA GPU). Before using the decision it verifies the enclave's signature, a fresh attestation and both hardware quotes, then writes a hash-chained, on-chain memory commit to mnemosyne-gov.testnet. Only after that commit succeeds does it allocate anything; if the commit fails the cycle stops (fail-closed). Three sub-agents hold report-only function-call keys: they can call report() and nothing else (NEAR itself rejects commit and transfers), and one refuses directives above its tighter ceiling, on-chain. Humans set the rails: the owner edits risk limits (each cycle writes the limits it used into its on-chain record), and anyone who signs in with a NEAR wallet gets personal guardrails (pause, daily query and spend caps). Login is identity, never root. Other agents pay per query over x402 (HTTP 402, wNEAR on testnet) to ask whether a situation matches a failure already learned from; they get a citation and one line of advice, never the private detail.

How NEAR fits: named sub-accounts per role, function-call keys for capability limits, NEAR AI Cloud TEE for private reasoning, on-chain memory as the public gate, wNEAR and x402 for agent-to-agent payments, NEAR Intents (1Click) for an optional, memory-gated cross-chain price quote.

Honest limits: Mnemosyne does not trade, so swarm losses are a labelled simulation; cross-chain is a quote only (nothing is sent); everything runs on testnet.
```

## 4. Proof links for the README and the post

All on NEAR testnet, from `HANDOFF.md`:

- Contract: `mnemosyne-gov.testnet`
- Real x402 payment, 0.001 wNEAR: [`AAWMt68Q...`](https://testnet.nearblocks.io/txns/AAWMt68QRu8QEqcdeVf1VdeqnQMbyeDfpzMy6jd9tqzJ)
- Cycle decided in the TEE (signature, nonce, Intel TDX and NVIDIA GPU verified), memory commit: [`BNv6Kg1R...`](https://testnet.nearblocks.io/txns/BNv6Kg1RwT8FuogbJoDXx19tKn5ozr95kjkGKtXm9Cii)
- Full cycle with a memory-gated cross-chain price quote: [`4ZFT4xBh...`](https://testnet.nearblocks.io/txns/4ZFT4xBhzunfhVfuNtjiLEt4VFVuucabaj7ckR4oHoiN)

## 5. Before you press submit

- [ ] `git ls-files` shows no `.env`, no key files and no `data/runtime` (the repo must hold no keys or secrets).
- [ ] `npm test` and `npm run typecheck` pass on the machine you will record on.
- [ ] The README's "Run it" and "Try the x402 memory API" sections work from a fresh clone (do X, see Y).
- [ ] You ran the pause or Max queries part of step 7 once for real (sign-in and sign-up already worked). If it does not behave, cut that part from the video.
- [ ] The repository is public, the X post is up, and the post link is in `demoUrl`.
- [ ] One submission per team. Read the form once more before sending.

## What is and is not live

Proven live on testnet: private decisions in the TEE, the fail-closed memory commit, report-only sub-agents, x402 payments in wNEAR, real balances and tiny top-ups, owner limits, the 1Click price quote, wallet sign-in and sign-up, and running a full cycle from the desk (13:45 UTC, memory commit `BRKrneuo...`). Built and tested offline, not live: the Rhea quote provider (tried live without a key on 2026-11-01 and Rhea refused it, so it needs a key from Rhea's portal, which could not be obtained; 1Click covers the same step) and the wallet sign-in against a real wallet.
