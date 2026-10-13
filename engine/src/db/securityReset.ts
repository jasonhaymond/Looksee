import "dotenv/config";
import readline from "node:readline/promises";
import { db, pool } from "./index.js";
import { ipBlocks, loginChallenges, securitySettings, users } from "./schema.js";

// Break-glass recovery from a shell on the server, for when the web UI
// can't be reached: locked out by the IP allowlist, a block, new-IP email
// confirmation with broken SMTP, or a lost authenticator. Requires shell
// access, which is the point — nothing here is reachable over HTTP.
//
//   npm run security:reset              access only (allowlist, blocks, new-IP confirmation)
//   npm run security:reset -- --2fa     also clear two-factor; set it up again at next sign-in
const reset2fa = process.argv.includes("--2fa");
const yes = process.argv.includes("--yes");

console.log("This will:");
console.log("  - turn off the IP allowlist");
console.log("  - turn off new-IP email confirmation");
console.log("  - remove every IP block");
if (reset2fa) console.log("  - clear two-factor authentication (you'll enrol a new authenticator at your next sign-in)");

if (!yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Continue? (y/N) ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y") {
    console.log("Nothing changed.");
    await pool.end();
    process.exit(0);
  }
}

await db.update(securitySettings).set({ allowlistEnabled: false, newIpConfirmation: false, updatedAt: new Date() });
await db.delete(ipBlocks);
if (reset2fa) {
  await db.update(users).set({ totpEnabled: false, totpSecret: null, recoveryCodes: [] });
  await db.delete(loginChallenges);
}
console.log("Done. The running engine picks this up within 10 seconds — no restart needed.");
await pool.end();
