import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const urlFilePath = path.join(projectRoot, "tunnel-url.txt");
const logPath = path.join(projectRoot, "cloudflared.log");

let tunnelUrl = process.argv[2];

if (!tunnelUrl && fs.existsSync(urlFilePath)) {
  tunnelUrl = fs.readFileSync(urlFilePath, "utf-8").trim();
}

if (!tunnelUrl && fs.existsSync(logPath)) {
  const content = fs.readFileSync(logPath, "utf-8");
  const match = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match) tunnelUrl = match[0];
}

if (!tunnelUrl) {
  console.error("Error: No tunnel URL found. Provide a URL argument or run 'npm run tunnel' first.");
  process.exit(1);
}

console.log(`Checking tunnel health for: ${tunnelUrl}`);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 8000);

try {
  const t0 = Date.now();
  const res = await fetch(tunnelUrl, { signal: controller.signal });
  clearTimeout(timeout);
  const latency = Date.now() - t0;

  console.log(`Status: ${res.status} ${res.statusText} (${latency}ms)`);

  if (res.status === 200) {
    console.log("✓ Tunnel is healthy and origin server is responding.");
  } else if (res.status === 502 || res.status === 530) {
    console.warn("⚠ Warning: Cloudflare returned 502/530. The tunnel is connected to edge, but origin (http://127.0.0.1:3000) might be unreachable.");
    process.exit(2);
  } else if (res.status === 1033) {
    console.error("✗ Error: Error 1033. The quick tunnel connection has dropped or process terminated. Restart via 'npm run tunnel'.");
    process.exit(3);
  } else {
    console.log(`Tunnel returned status ${res.status}.`);
  }

  // Check auth and shifts endpoints
  const authRes = await fetch(`${tunnelUrl}/api/auth/me`);
  const shiftsRes = await fetch(`${tunnelUrl}/api/shifts`);
  console.log(`API check: /api/auth/me -> HTTP ${authRes.status}, /api/shifts -> HTTP ${shiftsRes.status}`);

  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  console.error(`✗ Error: Tunnel is DOWN or unreachable. (${err.message})`);
  console.error("Run 'npm run tunnel' to restart a fresh tunnel.");
  process.exit(1);
}
