/** The automatic cycle runner: the clock, the validation, the fail-closed
 *  shutoff after repeated failures, and the API. */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createMnemosyneServer } from "./x402/server.js";
import { MockFacilitator } from "./x402/facilitator.js";
import {
  MAX_FAILURES,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  isDue,
  recordRun,
  saveSchedule,
  scheduleView,
  tick,
} from "./schedule.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let dir = "";
before(() => { dir = mkdtempSync(join(tmpdir(), "mnemo-schedule-")); });
after(() => rmSync(dir, { recursive: true, force: true }));
const fresh = () => mkdtempSync(join(dir, "d-"));

describe("reading and saving", () => {
  it("is off by default, every 30 minutes, nothing run yet", () => {
    const v = scheduleView(fresh());
    assert.deepEqual(v, {
      enabled: false, interval_minutes: 30, last_run_at: null, last_result: null, last_error: null,
      consecutive_failures: 0, updated_at: null, updated_by: null, next_run_at: null,
    });
  });

  it("rejects an out-of-range or fractional interval, and unknown fields", () => {
    const d = fresh();
    for (const bad of [{ interval_minutes: 1 }, { interval_minutes: 99999 }, { interval_minutes: 10.5 }, { interval_minutes: "30" }, { nope: 1 }]) {
      const r = saveSchedule(d, bad, "owner-token");
      assert.ok(!r.ok, JSON.stringify(bad));
    }
    assert.equal(scheduleView(d).interval_minutes, 30, "nothing invalid was written");
  });

  it("persists a change and records who made it", () => {
    const d = fresh();
    const r = saveSchedule(d, { enabled: true, interval_minutes: 10 }, "owner-token");
    assert.ok(r.ok);
    const v = scheduleView(d);
    assert.equal(v.enabled, true);
    assert.equal(v.interval_minutes, 10);
    assert.equal(v.updated_by, "owner-token");
    assert.ok(v.next_run_at, "turning it on sets a next run time");
  });

  it("turning it on resets a failure streak; turning it off does not erase history", () => {
    const d = fresh();
    saveSchedule(d, { enabled: true }, "owner-token");
    recordRun(d, { committed: false, error: "rpc timeout" });
    recordRun(d, { committed: false, error: "rpc timeout" });
    assert.equal(scheduleView(d).consecutive_failures, 2);
    saveSchedule(d, { enabled: false }, "owner-token");
    assert.equal(scheduleView(d).consecutive_failures, 2, "turning off keeps the count");
    saveSchedule(d, { enabled: true }, "owner-token");
    assert.equal(scheduleView(d).consecutive_failures, 0, "turning back on gets a fresh streak");
  });

  it("a hand-edited file outside the bounds is clamped, not a crash (lower stakes than limits)", () => {
    const d = fresh();
    writeFileSync(join(d, "schedule.json"), JSON.stringify({ interval_minutes: 999999, enabled: "yes", consecutive_failures: -5 }));
    const v = scheduleView(d);
    assert.equal(v.interval_minutes, 30);
    assert.equal(v.enabled, false);
    assert.equal(v.consecutive_failures, 0);
  });

  it("genuinely unreadable JSON still throws rather than silently resetting", () => {
    const d = fresh();
    writeFileSync(join(d, "schedule.json"), "{ not json");
    assert.throws(() => scheduleView(d), /unreadable/);
  });
});

describe("when a run is due", () => {
  it("never, while off", () => {
    assert.equal(isDue({ enabled: false, interval_minutes: 5, last_run_at: null, last_result: null, last_error: null, consecutive_failures: 0, updated_at: null, updated_by: null }), false);
  });

  it("immediately, once on with no prior run", () => {
    assert.equal(isDue({ enabled: true, interval_minutes: 30, last_run_at: null, last_result: null, last_error: null, consecutive_failures: 0, updated_at: null, updated_by: null }), true);
  });

  it("not yet, right after a run; yes, once the interval has passed", () => {
    const justRan = { enabled: true, interval_minutes: 10, last_run_at: new Date().toISOString(), last_result: "committed" as const, last_error: null, consecutive_failures: 0, updated_at: null, updated_by: null };
    assert.equal(isDue(justRan), false);
    const longAgo = { ...justRan, last_run_at: new Date(Date.now() - 11 * 60_000).toISOString() };
    assert.equal(isDue(longAgo), true);
  });
});

describe("fail-closed automation", () => {
  it("a committed run clears the streak", () => {
    const d = fresh();
    saveSchedule(d, { enabled: true }, "owner-token");
    recordRun(d, { committed: false });
    recordRun(d, { committed: true });
    assert.equal(scheduleView(d).consecutive_failures, 0);
    assert.equal(scheduleView(d).last_result, "committed");
  });

  it(`turns itself off after ${MAX_FAILURES} failed cycles in a row, and says why`, () => {
    const d = fresh();
    saveSchedule(d, { enabled: true }, "owner-token");
    for (let i = 0; i < MAX_FAILURES; i++) recordRun(d, { committed: false, error: "rpc timeout" });
    const v = scheduleView(d);
    assert.equal(v.enabled, false);
    assert.equal(v.consecutive_failures, MAX_FAILURES);
    assert.match(v.last_error!, new RegExp(`stopped itself after ${MAX_FAILURES}`));
    assert.equal(v.next_run_at, null, "off means no next run");
  });

  it("does not disable a schedule that was already off", () => {
    const d = fresh();
    recordRun(d, { committed: false });
    assert.equal(scheduleView(d).enabled, false);
    assert.doesNotMatch(scheduleView(d).last_error ?? "", /stopped itself/);
  });
});

describe("the tick that drives it", () => {
  it("does nothing when off, busy, or not yet due -- and never throws", async () => {
    const d = fresh();
    let calls = 0;
    const runCycle = async () => { calls++; return { committed: true }; };

    await tick({ dataDir: d, isBusy: () => false, runCycle }); // off
    assert.equal(calls, 0);

    saveSchedule(d, { enabled: true, interval_minutes: 30 }, "owner-token");
    await tick({ dataDir: d, isBusy: () => true, runCycle }); // busy
    assert.equal(calls, 0);

    await tick({ dataDir: d, isBusy: () => false, runCycle }); // due (just enabled) -> runs
    assert.equal(calls, 1);

    await tick({ dataDir: d, isBusy: () => false, runCycle }); // just ran, not due again
    assert.equal(calls, 1);
  });

  it("records a thrown error as a failed run instead of crashing the tick", async () => {
    const d = fresh();
    saveSchedule(d, { enabled: true }, "owner-token");
    await tick({ dataDir: d, isBusy: () => false, runCycle: async () => { throw new Error("rpc down"); } });
    const v = scheduleView(d);
    assert.equal(v.last_result, "failed");
    assert.match(v.last_error!, /rpc down/);
  });

  it(`a run-of-bad-luck disables the schedule after ${MAX_FAILURES} ticks, so the loop stops calling it`, async () => {
    const d = fresh();
    saveSchedule(d, { enabled: true, interval_minutes: MIN_INTERVAL_MINUTES }, "owner-token");
    const runCycle = async () => ({ committed: false, error: "no commit" });
    for (let i = 0; i < MAX_FAILURES; i++) {
      // force each one to be due: back-date the last run past the interval
      const v = scheduleView(d);
      if (v.last_run_at) {
        const past = new Date(Date.now() - (MIN_INTERVAL_MINUTES + 1) * 60_000).toISOString();
        writeFileSync(join(d, "schedule.json"), JSON.stringify({ ...v, last_run_at: past }));
      }
      await tick({ dataDir: d, isBusy: () => false, runCycle });
    }
    assert.equal(scheduleView(d).enabled, false);
    let calls = 0;
    await tick({ dataDir: d, isBusy: () => false, runCycle: async () => { calls++; return { committed: true }; } });
    assert.equal(calls, 0, "a disabled schedule calls nothing, even when it would otherwise be due");
  });
});

describe("over HTTP", () => {
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
      schedule: { get: () => scheduleView(apiDir), set: (c, by) => saveSchedule(apiDir, c, by) },
      dashboardHtml: "<title>Mnemosyne</title>", dashboardData: async () => ({ cycles: [] }),
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
    close = () => s.server.close();
  });
  after(() => close());

  it("anyone can read it; the dashboard data carries it too", async () => {
    const v: any = await (await call("/schedule")).json();
    assert.equal(v.enabled, false);
    assert.equal(((await (await call("/dashboard.json")).json()) as any).schedule.interval_minutes, 30);
  });

  it("changing it needs the admin token", async () => {
    assert.equal((await call("/schedule", { method: "PUT", body: JSON.stringify({ enabled: true }) })).status, 401);
    assert.equal((await call("/schedule", { method: "PUT", body: "{}", token: "wrong" })).status, 401);
    assert.equal(scheduleView(apiDir).enabled, false);
  });

  it("with the token a valid change is saved and shows up on the next read", async () => {
    const r = await call("/schedule", { method: "PUT", token: TOKEN, body: JSON.stringify({ enabled: true, interval_minutes: 15 }) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).interval_minutes, 15);
    assert.equal(((await (await call("/schedule")).json()) as any).enabled, true);
  });

  it("an invalid change is a 400 with the reasons, and nothing changes", async () => {
    const r = await call("/schedule", { method: "PUT", token: TOKEN, body: JSON.stringify({ interval_minutes: 2 }) });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as any).errors[0], /interval_minutes/);
    assert.equal(scheduleView(apiDir).interval_minutes, 15, "the earlier valid value is untouched");
  });
});

describe("not configured", () => {
  it("answers 404 rather than pretending to run a schedule that doesn't exist", async () => {
    const d = fresh();
    const s = createMnemosyneServer({
      dataDir: d, seedPath: join(ROOT, "data/seed-memory.json"), payTo: "mnemosyne-gov.testnet", network: "near:testnet", asset: "NEAR",
      priceAmount: "1", maxTimeoutSeconds: 300, facilitator: new MockFacilitator(d), mockSettlement: true,
    });
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    try {
      const url = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${url}/schedule`)).status, 404);
    } finally { s.server.close(); }
  });
});
