// Bundles the site collector (src/collector/main.ts and the database-free
// probe/receiver/discovery modules it imports) into one CommonJS file that
// runs on a stock Node runtime: agent/bin/collector/collector.cjs.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(engineDir, "..", "agent", "bin", "collector", "collector.cjs");
const { version } = JSON.parse(fs.readFileSync(path.join(engineDir, "package.json"), "utf-8"));

const result = await build({
  entryPoints: [path.join(engineDir, "src", "collector", "main.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  define: { __COLLECTOR_VERSION__: JSON.stringify(version) },
  metafile: true,
  logLevel: "warning",
});

// Guard against the bundle silently growing a database dependency, which
// would make it try to reach the engine's Postgres from a remote site.
const leaked = Object.keys(result.metafile.inputs).filter((f) => /src[\\/]db[\\/]|drizzle-orm|src[\\/]lib[\\/]logger/.test(f));
if (leaked.length) {
  console.error(`collector bundle must not include the engine's database layer, but pulled in:\n  ${leaked.join("\n  ")}`);
  process.exit(1);
}
console.log(`collector v${version} bundled → ${path.relative(process.cwd(), outFile)} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
