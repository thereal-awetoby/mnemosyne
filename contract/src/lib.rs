use near_sdk::{env, log, near};

// Sub-agent accounts allowed to call report(). Hardcoded on purpose: adding a
// state field would break deserialization of the already-deployed contract.
const SUB_ACCOUNTS: [&str; 3] = [
    "mnemosyne-sub-a.testnet",
    "mnemosyne-sub-b.testnet",
    "mnemosyne-sub-c2.testnet",
];

// Minimal on-chain memory gate for Mnemosyne.
// Stores only: latest commitment hash, prev hash, and a running count.
// Full private reasoning never touches this contract -- only the hash does.

#[near(contract_state)]
#[derive(Default)]
pub struct MemoryContract {
    latest_hash: String,
    prev_hash: String,
    commit_count: u64,
}

#[near]
impl MemoryContract {
    // Called by the governor at the end of each private-decide cycle,
    // BEFORE any allocation step runs. If this call reverts, the cycle
    // must fail-closed on the caller side (already true in cycle.ts).
    pub fn commit(&mut self, hash: String, prev_hash: String) {
        if env::predecessor_account_id() != env::current_account_id() {
            env::panic_str("only the governor account may write a memory commit");
        }
        if self.commit_count > 0 && prev_hash != self.latest_hash {
            env::panic_str("prev_hash does not match on-chain latest_hash -- chain broken");
        }
        self.prev_hash = self.latest_hash.clone();
        self.latest_hash = hash.clone();
        self.commit_count += 1;
        log!("MNEMOSYNE_COMMIT:{}:{}:{}", hash, prev_hash, self.commit_count);
    }

    // Sub-agents (function-call keys scoped to this contract + this method only)
    // log what they did or refused to do. Append-only audit trail via logs; no
    // state change, so the deployed state layout stays compatible.
    pub fn report(&self, sub: String, action: String, reason: String) {
        let caller = env::predecessor_account_id();
        if !SUB_ACCOUNTS.contains(&caller.as_str()) {
            env::panic_str("only registered sub-agent accounts may report");
        }
        if caller.as_str() != sub {
            env::panic_str("sub must match the calling account");
        }
        if action != "ACT" && action != "REFUSE" {
            env::panic_str("action must be ACT or REFUSE");
        }
        if reason.len() > 200 {
            env::panic_str("reason too long (max 200 bytes)");
        }
        log!("MNEMOSYNE_REPORT:{}:{}:{}", sub, action, reason);
    }

    pub fn get_latest(&self) -> (String, String, u64) {
        (self.latest_hash.clone(), self.prev_hash.clone(), self.commit_count)
    }
}
