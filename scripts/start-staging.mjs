import fs from "node:fs";
import path from "node:path";
import { parseEnvContent, assertStagingDatabaseTarget, sanitizeTargetHost } from "./db-target-guard.mjs";

const envPath = path.resolve(process.cwd(), ".env.billing-staging.local");
if (!fs.existsSync(envPath)) {
  console.error("FATAL: .env.billing-staging.local not found.");
  process.exit(1);
}

const content = fs.readFileSync(envPath, "utf-8");
const env = parseEnvContent(content);

// Strict safety gate: verify DATABASE_URL targets the approved staging branch
if (!env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not configured in .env.billing-staging.local.");
  process.exit(1);
}

try {
  const verified = assertStagingDatabaseTarget(env.DATABASE_URL);
  console.log(`[STAGING GATE] Target verified: ${sanitizeTargetHost(verified.hostname)} (${verified.database})`);
} catch (err) {
  console.error(`FATAL SAFETY STOP: ${err.message}`);
  process.exit(1);
}

// Populate process.env exclusively from .env.billing-staging.local
for (const [key, value] of Object.entries(env)) {
  process.env[key] = value;
}

// Explicitly prevent NODE_OPTIONS leakage
if (process.env.NODE_OPTIONS) {
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.replace(/--env-file=[^\s]+/g, "").trim();
}

console.log("[STAGING GATE] Loaded environment exclusively from .env.billing-staging.local");
console.log("[STAGING GATE] Binding server to http://127.0.0.1:3000");

// Configure process.argv to run Next.js dev server on 127.0.0.1:3000
process.argv = [
  process.argv[0],
  path.resolve("node_modules/next/dist/bin/next"),
  "dev",
  "-H",
  "127.0.0.1",
  "-p",
  "3000",
];

// Launch Next CLI dynamically
import("next/dist/bin/next");
