/** The owner's limits: hard bounds, persistence, fail-closed reads, and the API. */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { DEFAULT_ENVELOPE, policyGuard } from "../private/decide.js";
import { createMnemosyneServer } from "../x402/server.js";
import { MockFacilitator } from "../x402/facilitator.js";
import { envelopeToSwarmRisk, limitsView, loadLimits, LIMIT_SPECS, resetLimits, saveLimits, validateLimits } from "./index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let dir = "";
before(() => { dir = mkdtempSync(join(tmpdir(), "mnemo-limits-")); });
after(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(dir, "d-"));

describe("validation", () => {
  it("accepts a partial change inside the bounds", () => {
    const r = validateLimits({ max_total_exposure: 2000, per_sub_max_capital: 1000 });
    assert.ok(r.ok && r.limits.max_total_exposure === 2000 && r.limits.pause_loss_threshold === DEFAULT_ENVELOPE.pause_loss_threshold);
  });

  it("rejects everything outside the hard bounds, naming the limit", () => {
    for (const [bad, re] of [
      [{ max_total_exposure: 99999 }, /Total exposure: must be between 100 and 5000/],
      [{ max_total_exposure: 5 }, /Total exposure/],
      [{ max_growth: 3 }, /Growth per cycle: must be between 1x and 2x/],
      [{ max_position_pct: 0.9 }, /Max position: must be between 5% and 30%/],
      [{ max_loss_pct: 0 }, /Max loss per cycle/],
      [{ pause_loss_threshold: 0 }, /Pause at loss/],
    ] as const) {
      const r = validateLimits(bad);
      assert.ok(!r.ok, JSON.stringify(bad));
      assert.match((r as any).errors.join("; "), re);
    }
  });

  it("is strict about shape: unknown keys, strings, NaN, fractions of a whole-number limit", () => {
    for (const bad of [{ nope: 1 }, { max_total_exposure: "2000" }, { max_total_exposure: NaN }, { max_total_exposure: 2000.5 }, null, [], "x"]) {
      assert.ok(!validateLimits(bad as any).ok, JSON.stringify(bad));
    }
  });

  it("rejects contradictions", () => {
    const r = validateLimits({ max_total_exposure: 500 });   // the default per-sub ceiling (1500) is now above it
    assert.ok(!r.ok);
    assert.match((r as any).errors.join(";"), /Per-sub ceiling cannot be more than total exposure/);
    assert.ok(validateLimits({ max_total_exposure: 500, per_sub_max_capital: 400, max_daily_loss: 50 }).ok);
  });
});

describe("saving, reading and resetting", () => {
  it("defaults until the owner changes something", () => {
    const d = fresh();
    assert.deepEqual(loadLimits(d), { limits: DEFAULT_ENVELOPE, source: "default" });
  });

  it("persists a change, records who and what changed, and the next read sees it", () => {
    const d = fresh();
    const r = saveLimits(d, { max_total_exposure: 2400, per_sub_max_capital: 1200 }, "owner-token");
    assert.ok(r.ok);
    const v = limitsView(d);
    assert.equal(v.source, "owner");
    assert.equal(v.limits.max_total_exposure, 2400);
    assert.equal(v.updated_by, "owner-token");
    assert.deepEqual(v.history[0].changes.max_total_exposure, { from: 3000, to: 2400 });
    assert.equal(loadLimits(d).limits.per_sub_max_capital, 1200);
  });

  it("writes nothing when any value is invalid", () => {
    const d = fresh();
    assert.ok(!saveLimits(d, { max_total_exposure: 2000, max_growth: 9 }, "owner-token").ok);
    assert.equal(limitsView(d).source, "default");
    assert.equal(limitsView(d).history.length, 0);
  });

  it("reset goes back to the defaults and is kept in the history", () => {
    const d = fresh();
    saveLimits(d, { max_total_exposure: 2400, per_sub_max_capital: 1200 }, "owner-token");
    const r = resetLimits(d, "owner-token");
    assert.ok(r.ok);
    assert.equal(limitsView(d).source, "default");
    assert.equal(limitsView(d).history.length, 2);
  });

  it("keeps only the last 20 changes", () => {
    const d = fresh();
    for (let i = 0; i < 25; i++) saveLimits(d, { max_total_exposure: 2000 + i }, "owner-token");
    assert.equal(limitsView(d).history.length, 20);
  });

  it("fails closed on a corrupt or out-of-bounds file instead of using the defaults", () => {
    const d = fresh();
    writeFileSync(join(d, "limits.json"), "{ not json");
    assert.throws(() => loadLimits(d), /unreadable/);
    writeFileSync(join(d, "limits.json"), JSON.stringify({ limits: { ...DEFAULT_ENVELOPE, max_total_exposure: 999999 } }));
    assert.throws(() => loadLimits(d), /not valid/);
    writeFileSync(join(d, "limits.json"), JSON.stringify({ limits: { max_total_exposure: 2000 } }));
    assert.throws(() => loadLimits(d), /missing/);
  });
});

describe("what the cycle does with them", () => {
  it("the guard works inside the owner's limits, not the defaults", () => {
    const state = [{ sub: "A" as const, capital: 1000, lastCycleLoss: 0 }, { sub: "B" as const, capital: 1000, lastCycleLoss: 0 }, { sub: "C" as const, capital: 1000, lastCycleLoss: 0 }];
    const keepAll = state.map((s) => ({ sub: s.sub, action: "KEEP" as const, target_capital: 1000, reason: "" }));
    const tight = { ...DEFAULT_ENVELOPE, max_total_exposure: 1800, per_sub_max_capital: 900 };
    const { decisions } = policyGuard(keepAll, state, tight);
    assert.ok(decisions.every((d) => Number(d.target_capital) <= 900));
    assert.ok(decisions.reduce((t, d) => t + Number(d.target_capital), 0) <= 1800);
  });

  it("the public record carries the full envelope as strings", () => {
    const r = envelopeToSwarmRisk({ ...DEFAULT_ENVELOPE, max_growth: 1.1 });
    assert.deepEqual(Object.keys(r).sort(), ["max_daily_loss", "max_growth", "max_loss_pct", "max_position_pct", "max_total_exposure", "pause_loss_threshold", "per_sub_max_capital"]);
    assert.equal(r.max_growth, "1.1");
  });

  it("every limit has a spec the UI can draw", () => {
    for (const s of LIMIT_SPECS) assert.ok(s.label && s.help && s.min < s.max, s.key);
    assert.equal(LIMIT_SPECS.length, Object.keys(DEFAULT_ENVELOPE).length);
  });
});

describe("the API", () => {
  let base = "", close = () => {}, apiDir = "";
  const TOKEN = "test-token-123";
  const call = (path: string, init: RequestInit & { token?: string } = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } });

  before(async () => {
    apiDir = fresh();
    const s = createMnemosyneServer({
      dataDir: apiDir, seedPath: join(ROOT, "data/seed-memory.json"), payTo: "mnemosyne-gov.testnet", network: "near:testnet", asset: "NEAR",
      priceAmount: "1000000000000000000000", maxTimeoutSeconds: 300, facilitator: new MockFacilitator(apiDir), mockSettlement: true,
      adminToken: TOKEN,
      limits: { get: () => limitsView(apiDir), set: (c, by) => saveLimits(apiDir, c, by), reset: (by) => resetLimits(apiDir, by) },
      dashboardHtml: "<title>Mnemosyne</title>", dashboardData: async () => ({ cycles: [] }),
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
    close = () => s.server.close();
  });
  after(() => close());

  it("anyone can read the limits and their bounds; the dashboard data carries them too", async () => {
    const v: any = await (await call("/limits")).json();
    assert.equal(v.source, "default");
    assert.equal(v.specs.length, 7);
    assert.equal((await (await call("/dashboard.json")).json() as any).limits.limits.max_total_exposure, 3000);
  });

  it("changing them needs the admin token", async () => {
    const body = JSON.stringify({ max_total_exposure: 2500 });
    assert.equal((await call("/limits", { method: "PUT", body })).status, 401);
    assert.equal((await call("/limits", { method: "PUT", body, token: "wrong" })).status, 401);
    assert.equal((await call("/limits/reset", { method: "POST" })).status, 401);
    assert.equal(limitsView(apiDir).source, "default");
  });

  it("with the token a valid change is saved and shows up on the next read", async () => {
    const r = await call("/limits", { method: "PUT", token: TOKEN, body: JSON.stringify({ max_total_exposure: 2500, per_sub_max_capital: 1250 }) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).limits.max_total_exposure, 2500);
    assert.equal(((await (await call("/limits")).json()) as any).source, "owner");
  });

  it("an invalid change is a 400 with the reasons, and nothing changes", async () => {
    const r = await call("/limits", { method: "PUT", token: TOKEN, body: JSON.stringify({ max_growth: 7 }) });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).errors[0], /Growth per cycle/);
    assert.equal(limitsView(apiDir).limits.max_growth, 1.25);
    assert.equal((await call("/limits", { method: "PUT", token: TOKEN, body: "not json" })).status, 400);
  });

  it("reset restores the defaults", async () => {
    const r = await call("/limits/reset", { method: "POST", token: TOKEN });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).source, "default");
  });

  it("repeated wrong tokens get throttled", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("/limits", { method: "PUT", body: "{}", token: "nope" + i })).status;
    assert.equal(last, 429);
    // and even the right token waits, so guessing can't just continue
    assert.equal((await call("/limits", { method: "PUT", body: "{}", token: TOKEN })).status, 429);
  });
});

describe("editing is off without an admin token", () => {
  it("answers 503, not an open door", async () => {
    const d = fresh();
    const s = createMnemosyneServer({
      dataDir: d, seedPath: join(ROOT, "data/seed-memory.json"), payTo: "mnemosyne-gov.testnet", network: "near:testnet", asset: "NEAR",
      priceAmount: "1", maxTimeoutSeconds: 300, facilitator: new MockFacilitator(d), mockSettlement: true,
      limits: { get: () => limitsView(d), set: (c, by) => saveLimits(d, c, by), reset: (by) => resetLimits(d, by) },
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${url}/limits`, { method: "PUT", body: "{}", headers: { authorization: "Bearer anything" } })).status, 503);
      assert.equal((await fetch(`${url}/limits`)).status, 200);
    } finally { s.server.close(); }
  });
});
