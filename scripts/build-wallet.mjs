// Bundles the NEAR wallet connector into web/vendor/near-connect.js, so the login
// page loads it from this server instead of a CDN. The dashboard page itself never
// loads wallet code. Run: npm run build:wallet  (the built file is committed).
import { build } from "esbuild";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "web/vendor/.entry.mjs");
mkdirSync(dirname(entry), { recursive: true });
writeFileSync(entry, 'import { NearConnector } from "@hot-labs/near-connect";\nwindow.NearConnector = NearConnector;\n');
try {
  await build({
    entryPoints: [entry], bundle: true, minify: true, format: "iife", platform: "browser", target: "es2020",
    define: { global: "window" }, outfile: join(root, "web/vendor/near-connect.js"), legalComments: "none", logLevel: "info",
  });
} finally {
  rmSync(entry, { force: true });
}
