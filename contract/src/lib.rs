use near_sdk::{env, log, near};

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

    pub fn get_latest(&self) -> (String, String, u64) {
        (self.latest_hash.clone(), self.prev_hash.clone(), self.commit_count)
    }
}
