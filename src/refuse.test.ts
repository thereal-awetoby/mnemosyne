/** Each sub's own mandate check (src/refuse.ts), exercised directly rather
 *  than only indirectly through a live cycle. Two kinds of ceiling: A/B/C
 *  are absolute (a fixed number of units), D is a ratio of its own target. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateSubDecision, type GovernorDirective } from "./refuse.js";

const base = (over: Partial<GovernorDirective> = {}): GovernorDirective => ({
  sub: "A",
  status: "KEEP",
  target_capital: 1000,
  max_position: 100,
  max_loss_cycle: 25,
  mandate: "mean_reversion_only",
  ...over,
});

describe("absolute-ceiling mandates (A, B)", () => {
  it("acts within the mandate's fixed ceiling", () => {
    const r = evaluateSubDecision(base({ sub: "A", mandate: "mean_reversion_only", max_position: 200, max_loss_cycle: 50 }));
    assert.equal(r.action, "ACT");
  });

  it("refuses the instant either ceiling is crossed, by one unit", () => {
    const overPosition = evaluateSubDecision(base({ sub: "A", mandate: "mean_reversion_only", max_position: 201, max_loss_cycle: 50 }));
    assert.equal(overPosition.action, "REFUSE");
    assert.match(overPosition.reason, /max_position 201 exceeds mandate ceiling 200/);

    const overLoss = evaluateSubDecision(base({ sub: "B", mandate: "inventory_liquidity_only", max_position: 200, max_loss_cycle: 51 }));
    assert.equal(overLoss.action, "REFUSE");
    assert.match(overLoss.reason, /max_loss_cycle 51 exceeds mandate ceiling 50/);
  });
});

describe("defensive_reduce_only (C): tighter ceiling, and can only shrink", () => {
  it("refuses INCREASE outright, whatever the numbers", () => {
    const r = evaluateSubDecision(base({ sub: "C", mandate: "defensive_reduce_only", status: "INCREASE", current_capital: 1000 }));
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /reduce-only mandate: INCREASE not allowed/);
  });

  it("refuses a target above its current capital, even under KEEP", () => {
    const r = evaluateSubDecision(base({ sub: "C", mandate: "defensive_reduce_only", target_capital: 1100, current_capital: 1000, max_position: 100, max_loss_cycle: 20 }));
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /target_capital 1100 > current 1000/);
  });

  it("fails closed when current_capital is missing: a reduce-only sub cannot prove it is reducing", () => {
    const r = evaluateSubDecision(base({ sub: "C", mandate: "defensive_reduce_only", target_capital: 900 }));
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /current capital unknown, fail-closed/);
  });

  it("acts when genuinely shrinking and inside its own (tighter) ceiling", () => {
    const r = evaluateSubDecision(base({ sub: "C", mandate: "defensive_reduce_only", target_capital: 900, current_capital: 1000, max_position: 150, max_loss_cycle: 30 }));
    assert.equal(r.action, "ACT");
  });

  it("refuses at 150/30, same numbers A and B would accept", () => {
    const r = evaluateSubDecision(base({ sub: "C", mandate: "defensive_reduce_only", target_capital: 900, current_capital: 1000, max_position: 151, max_loss_cycle: 30 }));
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /mandate ceiling 150/);
  });
});

describe("volatility_capped (D): a ratio of its own target, not a fixed number", () => {
  it("refuses a directive built from the DEFAULT global envelope (20% / 5%) -- D's own mandate (12% / 3%) is tighter", () => {
    // this is exactly what policyGuard hands a sub under the owner's default
    // limits: max_position = floor(target * 0.2), max_loss_cycle = floor(target * 0.05)
    const r = evaluateSubDecision(base({ sub: "D", mandate: "volatility_capped", target_capital: 1000, max_position: 200, max_loss_cycle: 50 }));
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /max_position 200 exceeds 12% of target_capital \(120\)/);
  });

  it("acts once the directive respects D's OWN ratio, whatever target_capital is", () => {
    const small = evaluateSubDecision(base({ sub: "D", mandate: "volatility_capped", target_capital: 500, max_position: 60, max_loss_cycle: 15 }));
    assert.equal(small.action, "ACT");
    const large = evaluateSubDecision(base({ sub: "D", mandate: "volatility_capped", target_capital: 5000, max_position: 600, max_loss_cycle: 150 }));
    assert.equal(large.action, "ACT");
  });

  it("the ceiling scales with target_capital -- raising the target alone never buys room", () => {
    // 200 units is fine against a 5000 target (4%) but not against a 1000 one (20%)
    const ok = evaluateSubDecision(base({ sub: "D", mandate: "volatility_capped", target_capital: 5000, max_position: 200, max_loss_cycle: 50 }));
    assert.equal(ok.action, "ACT");
    const refused = evaluateSubDecision(base({ sub: "D", mandate: "volatility_capped", target_capital: 1000, max_position: 200, max_loss_cycle: 50 }));
    assert.equal(refused.action, "REFUSE");
  });

  it("is not reduce-only: INCREASE is allowed when inside its own ratio", () => {
    const r = evaluateSubDecision(base({ sub: "D", mandate: "volatility_capped", status: "INCREASE", target_capital: 1200, max_position: 100, max_loss_cycle: 20 }));
    assert.equal(r.action, "ACT");
  });

  it("refuses on the loss ratio even when the position ratio is fine", () => {
    const r = evaluateSubDecision(base({ sub: "D", mandate: "volatility_capped", target_capital: 1000, max_position: 100, max_loss_cycle: 31 }));
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /max_loss_cycle 31 exceeds 3% of target_capital \(30\)/);
  });
});

describe("fail-closed, for every mandate", () => {
  it("refuses an unrecognized mandate rather than guessing a rule for it", () => {
    const r = evaluateSubDecision(base({ mandate: "not_a_real_mandate" }));
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /unknown mandate/);
  });

  it("refuses malformed numbers instead of letting NaN comparisons pass silently", () => {
    for (const over of [{ target_capital: NaN }, { max_position: -1 }, { max_loss_cycle: Infinity }]) {
      const r = evaluateSubDecision(base(over as Partial<GovernorDirective>));
      assert.equal(r.action, "REFUSE", JSON.stringify(over));
      assert.match(r.reason, /fail-closed/);
    }
  });

  it("refuses a directive that contradicts itself: PAUSE with a nonzero target", () => {
    const r = evaluateSubDecision(base({ status: "PAUSE", target_capital: 500 }));
    assert.equal(r.action, "REFUSE");
    assert.match(r.reason, /contradictory directive/);
  });
});
