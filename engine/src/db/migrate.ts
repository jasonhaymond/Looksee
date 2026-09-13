import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index.js";

// Forward-only, non-interactive — safe to run unattended in an update/deploy
// script. Applies whatever's already committed under drizzle/, never
// generates a new migration (that's `npm run db:generate`, a local-authoring
// command only).
await migrate(db, { migrationsFolder: "./drizzle" });
await pool.end();
console.log("Migrations applied.");
