import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Same relative-depth resolution as lib/version.ts's package.json read,
// just one level further out — engine/{src,dist}/lib/ -> repo root ->
// agent/VERSION. Null (not thrown) if the file isn't there, since this
// only affects the dashboard's "latest buildable" hint, not anything load-
// bearing.
const agentVersionPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agent", "VERSION");

export function readAgentVersion(): string | null {
  try {
    return readFileSync(agentVersionPath, "utf-8").trim();
  } catch {
    return null;
  }
}
