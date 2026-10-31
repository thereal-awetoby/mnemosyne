# Phase 6: private decision path (NEAR AI Cloud TEE)

The governor's reasoning runs inside a **Trusted Execution Environment** on
[NEAR AI Cloud](https://cloud-api.near.ai/v1): an Intel TDX confidential VM with
an NVIDIA confidential-computing GPU. The prompt (swarm state, memory lessons)
and the model's reasoning are processed inside that enclave, and the answer is
**signed by a key that only exists inside it**. Mnemosyne verifies all of that
before it lets the decision anywhere near the chain. Verification fails
closed.

## What happens in one cycle

```
swarm state + memory lessons + random salt
        |
        v
NEAR AI Cloud TEE (Qwen/Qwen3.8-27B, x-no-aliasing)  --->  proposal JSON + private reasoning
        |
        v   verify (src/private/teeVerify.ts), any failure = no decision, nothing committed
  1. sha256(exact request bytes), sha256(exact response bytes) == hashes in the signed text
  2. ECDSA (EIP-191) signature recovers to signing_address, signature_kind = provider_tee, right model
  3. fresh attestation with OUR random nonce: TDX report_data = signing_address || nonce
  4. Intel TDX quote verifies against Intel's collateral (@phala/dcap-qvl)
  5. NVIDIA NRAS says the GPU evidence is valid for our nonce; NRAS token ES384 signature checked
        |
        v
policy guard (public, deterministic): the model proposes, the guard disposes
        |
        +--> private blob (prompt, reasoning, proposal, guard edits) -> data/runtime/private/  (never published)
        +--> private_commitment = sha256(salt : canonical(private blob))
        |
        v
public MemoryRecord (schema 2): decisions + decision_path + private_commitment + TEE evidence
        |
        v
hash committed on NEAR (fail-closed gate, Phases 2-4 unchanged)
```

## The policy guard (`policyGuard` in `src/private/decide.ts`)

A model can be wrong. These limits are code, not prompt, and apply to every proposal:

| Rule | Value |
|---|---|
| Sub with last-cycle loss over the threshold | always PAUSE (threshold 100) |
| Growth per cycle | at most x1.25 of current capital |
| Per-sub ceiling | 1500 |
| Defensive sub C | never above its current capital (reduce-only) |
| Swarm total exposure | at most 3000, active targets scaled down proportionally |
| Missing sub / unknown action | PAUSE |
| Action label | must match the numbers (a "CUT" to more capital becomes INCREASE) |
| max_position / max_loss_cycle | 20% / 5% of target, derived, never taken from the model |

The sub-agents still run their own independent mandate checks (Phase 4) and
can refuse on-chain whatever the governor decided.

## What is public, what is private

| Public (MemoryRecord, hashed on-chain) | Private (local file only) |
|---|---|
| final decisions, risk envelope | full prompt: swarm state, lessons |
| `decision_path`: `near-ai-tee` or `local-policy` | the model's reasoning and raw answer |
| `private_commitment` | the request salt |
| TEE evidence: model, chat id, signer, request/response hashes, signature, check results | guard adjustments, commitment salt |

The request contains a random salt, so the public request hash can't be
brute-forced back to the swarm state. The private blob can be revealed later
(e.g. to an auditor) and checked against `private_commitment` with
`verifyCommitment()`.

## Run it

```
# .env
NEAR_AI_API_KEY=sk-...
# NEAR_AI_MODEL=Qwen/Qwen3.8-27B
# TEE_VERIFY=full          (default; "signature" skips Intel TDX + NVIDIA checks, labelled not_checked)
# SWARM_SCENARIO=stressed  (calm | stressed | recovery; swarm state is SIMULATED)

npm run tee:check                    dry run: one verified private decision, nothing on-chain
npm run cycle                        full cycle, decided in the TEE, committed on testnet
npm run tee:check -- --record data/runtime/public/<cycle>.json
                                     check a public record: hash, enclave signature, fresh attestation
```

Without `NEAR_AI_API_KEY` the cycle uses a deterministic local rule and says so:
`decision_path: "local-policy"`, `tee: null`. It never pretends.

## Honest limits

- Verification trusts Intel's and NVIDIA's attestation roots, and NEAR AI's
  claim that the attested image runs the model it names. We check the
  quote, not the full image measurement (compose hash / event log replay).
- The signing key is attested *now* (fresh nonce); a public record checked
  later proves the same key is still in a TEE, which is what NEAR AI's own
  verifier does.
- `OutOfDate` TDX TCB status is accepted and recorded verbatim: the quote is
  valid but the platform is behind Intel's latest microcode baseline.
- Swarm state is still simulated, and ALLOCATE still only prints.
