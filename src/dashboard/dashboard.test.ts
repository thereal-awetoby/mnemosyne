/** Dashboard: read-only routes, strict headers, and the public-record reader. */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { createMnemosyneServer } from "../x402/server.js";
import { MockFacilitator } from "../x402/facilitator.js";
import { readCycles } from "./data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let dataDir = "";
let base = "";
let close = () => {};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mnemo-dash-"));
  const pub = join(dataDir, "public");
  mkdirSync(pub, { recursive: true });
  writeFileSync(join(pub, "2026-10-30T10_00_00.000Z-aaaaa.json"), JSON.stringify({ cycle_id: "2026-10-30T10:00:00.000Z-aaaaa", decision_hash: "sha256:old" }));
  writeFileSync(join(pub, "2026-10-31T10_00_00.000Z-bbbbb.json"), JSON.stringify({ cycle_id: "2026-10-31T10:00:00.000Z-bbbbb", decision_hash: "sha256:new" }));
  writeFileSync(join(pub, "2026-10-31T10_00_00.000Z-bbbbb.run.json"), JSON.stringify({ committed: true, commit_tx: "x" }));
  mkdirSync(join(dataDir, "private"));
  writeFileSync(join(dataDir, "private", "secret.json"), JSON.stringify({ reasoning: "TOP SECRET" }));

  const created = createMnemosyneServer({
    dataDir,
    seedPath: join(ROOT, "data/seed-memory.json"),
    payTo: "mnemosyne-gov.testnet",
    network: "near:testnet",
    asset: "NEAR",
    priceAmount: "1000000000000000000000",
    maxTimeoutSeconds: 300,
    facilitator: new MockFacilitator(dataDir),
    mockSettlement: true,
    dashboardHtml: readFileSync(join(ROOT, "web/dashboard.html"), "utf8"),
    dashboardFonts: { "a.woff2": Buffer.from("font") },
    dashboardData: async () => ({ chain: { ok: true, commit_count: 2 }, cycles: readCycles(dataDir), subs: [] }),
  });
  await new Promise<void>((r) => created.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(created.server.address() as AddressInfo).port}`;
  close = () => created.server.close();
});
after(() => { close(); rmSync(dataDir, { recursive: true, force: true }); });

test("dashboard page is served with a strict content security policy", async () => {
  const r = await fetch(`${base}/dashboard`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /https?:/, "no third-party origins");
  assert.match(await r.text(), /<title>Mnemosyne/);
});

test("browsers hitting / go to the dashboard; API clients still get JSON", async () => {
  const html = await fetch(`${base}/`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(html.status, 302);
  assert.equal(html.headers.get("location"), "/dashboard");
  const api = await fetch(`${base}/`);
  assert.equal(api.status, 200);
  assert.ok((await api.json()).routes["GET /dashboard"]);
});

test("dashboard.json: newest cycle first, run log attached, private files never read", async () => {
  const d: any = await (await fetch(`${base}/dashboard.json`)).json();
  assert.deepEqual(d.cycles.map((c: any) => c.record.decision_hash), ["sha256:new", "sha256:old"]);
  assert.equal(d.cycles[0].run.commit_tx, "x");
  assert.equal(d.cycles[1].run, null);
  assert.equal(d.x402.mock_settlement, true);
  assert.equal(d.x402.paid_checks_total, 0);
  assert.ok(!JSON.stringify(d).includes("TOP SECRET"));
});

test("only listed font files are served; nothing else under /dashboard/", async () => {
  const f = await fetch(`${base}/dashboard/fonts/a.woff2`);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get("content-type"), "font/woff2");
  for (const p of ["/dashboard/fonts/../../.env", "/dashboard/fonts/b.woff2", "/dashboard/x"]) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, p);
  }
});

test("the page script parses and carries the chain key and the stepped log", async () => {
  const html = await (await fetch(`${base}/dashboard`)).text();
  const js = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  assert.doesNotThrow(() => new vm.Script(js), "dashboard script must be valid JavaScript");
  assert.match(html, /id="chainLegend"/);
  assert.match(js, /function logSteps/);
  // Node.replaceChildren(null) writes the word "null" into the page: slots that can be empty go through fill()
  assert.match(js, /const fill = /);
  assert.doesNotMatch(js, /\.replaceChildren\([^;]*:\s*null/, "a possibly-empty slot passed straight to replaceChildren");
  assert.doesNotMatch(js, /\.innerHTML|insertAdjacentHTML|document\.write/, "all DOM is built with createElement/textContent");
});

test("with no admin token the page is offered no operator controls at all", async () => {
  const html = await (await fetch(`${base}/dashboard`)).text();
  // the button ships hidden; only an unlocked operator is shown it
  assert.match(html, /id="btnCycle"[^>]*\shidden/, "Run cycle starts hidden");
  const data: any = await (await fetch(`${base}/dashboard.json`)).json();
  assert.equal(data.operator.enabled, false, "this server has no ADMIN_TOKEN");
  assert.equal((await fetch(`${base}/admin/check`)).status, 503, "nothing to unlock");
});

test("dashboard routes are read-only", async () => {
  for (const p of ["/dashboard", "/dashboard.json"]) {
    assert.equal((await fetch(`${base}${p}`, { method: "POST" })).status, 404, p);
  }
});

test("dashboard uses the supplied shell while retaining live controls and local fonts", async () => {
  const html = await (await fetch(`${base}/dashboard`)).text();
  for (const marker of ['id="themeToggle"', 'id="refresh"', 'id="btnPay"', 'id="railGuard"', 'id="limitsBox"', 'id="scheduleBox"', 'id="acctPanel"', 'id="lastCommitBox"']) assert.ok(html.includes(marker), marker);
  for (const route of ['/me/guardrails', '/limits', '/schedule', '/cycle/run', '/memory/check', '/pay']) assert.ok(html.includes(route), route);
  assert.match(html, /ibm-plex-sans-latin-400-normal\.woff2/);
  assert.match(html, /ibm-plex-mono-latin-400-normal\.woff2/);
  assert.match(html, /mn_paid_result/);
});

test("all-clear requires a committed, fully reported cycle without failures", async () => {
  const html = await (await fetch(`${base}/dashboard`)).text();
  const script = html.match(/function cycleSummary\(c\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(script);
  const context = vm.createContext({ isTee: (r: any) => r.decision_path === 'near-ai-tee', teeVerified: () => true });
  const summary = vm.runInContext(`${script}; cycleSummary`, context) as (c: any) => string;
  const record = { decisions: [{ sub: 'A', action: 'KEEP' }] };
  const run = { committed: true, verdicts: [{ sub: 'A', action: 'ACT' }], reports: [{ sub: 'A', status: 'reported' }], allocations: [] };
  assert.equal(summary({ record, run }), 'All clear');
  assert.equal(summary({ record, run: null }), 'Waiting');
  assert.equal(summary({ record, run: { ...run, reports: [] } }), 'Waiting');
  assert.equal(summary({ record, run: { ...run, verdicts: [{ sub: 'A', action: 'REFUSE' }] } }), 'Refused');
  assert.equal(summary({ record, run: { ...run, allocations: [{ kind: 'failed' }] } }), 'Failed');
  assert.equal(summary({ record, run: { ...run, committed: false } }), 'Failed');
  assert.equal(summary({ record: { ...record, decision_path: 'near-ai-tee', tee: { checks: { tdx: 'not_checked', gpu: 'not_checked' } } }, run }), 'Waiting');
});

test("dashboard keeps the reference logo and theme icons and exposes operator unlock from settings", async () => {
  const html = await (await fetch(`${base}/dashboard`)).text();
  assert.match(html, /class="mark" aria-hidden="true"/);
  assert.equal((html.match(/<i class="b"><\/i>/g) || []).length, 4);
  assert.match(html, /class="sun"/);
  assert.match(html, /class="moon"/);
  assert.match(html, /id="scheduleToggle"[^>]*role="switch"/);
  assert.match(html, /function requireOperator\(\)/);
  assert.match(html, /if \(!requireOperator\(\)\) return/);
  assert.match(html, /drawSchedule\(lastSchedule \|\| DATA\.schedule, null\)/);
});
