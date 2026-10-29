const fs = require("node:fs");

const content = fs.readFileSync(".env.local", "utf8");
const lines = content.split(/\r?\n/);
const matches = lines.filter(line =>
  /^\s*(?:export\s+)?DATABASE_URL\s*=/.test(line)
);

if (matches.length !== 1) {
  console.log(`Expected exactly one DATABASE_URL entry; found ${matches.length}.`);
  process.exit(1);
}

let value = matches[0].replace(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*/, "").trim();

if (
  (value.startsWith('"') && value.endsWith('"')) ||
  (value.startsWith("'") && value.endsWith("'"))
) {
  value = value.slice(1, -1);
}

try {
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

  console.log("URL format: valid");
  console.log("Hostname:", url.hostname);
  console.log("Database:", database || "(not specified)");
  console.log("Password present:", Boolean(url.password));
  console.log("No database connection attempted.");
} catch {
  console.log("URL format invalid or unsupported. No connection attempted.");
  process.exit(1);
}