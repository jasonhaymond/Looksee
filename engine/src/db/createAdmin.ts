import "dotenv/config";
import readline from "node:readline/promises";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, pool } from "./index.js";
import { users } from "./schema.js";

// One-time/occasional bootstrap for Looksee's single admin account. Safe to
// re-run: prompts before overwriting an existing user's password rather than
// silently resetting it, per the global setup-script standard.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const email = (await rl.question("Admin email: ")).trim().toLowerCase();
const password = await rl.question("Admin password (min 8 chars): ");
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  await rl.close();
  await pool.end();
  process.exit(1);
}

const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
if (existing) {
  const overwrite = (await rl.question(`${email} already exists. Reset their password? (y/N) `))
    .trim()
    .toLowerCase();
  if (overwrite !== "y") {
    console.log("Left unchanged.");
    await rl.close();
    await pool.end();
    process.exit(0);
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await db.update(users).set({ passwordHash }).where(eq(users.id, existing.id));
  console.log(`Password updated for ${email}.`);
} else {
  const passwordHash = await bcrypt.hash(password, 12);
  await db.insert(users).values({ email, passwordHash });
  console.log(`Admin account created for ${email}.`);
}

await rl.close();
await pool.end();
