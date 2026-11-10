import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const logPath = path.join(projectRoot, "cloudflared.log");
const urlFilePath = path.join(projectRoot, "tunnel-url.txt");

const CLOUDFLARED_BIN = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";

console.log("=== ROTA CLOUDFLARE QUICK TUNNEL STARTER ===");

// 1. Terminate any existing cloudflared processes
try {
  execSync("taskkill /F /IM cloudflared.exe 2>nul", { stdio: "ignore" });
  console.log("Stopped existing cloudflared processes.");
} catch {
  // None running
}

// 2. Clear old log file
if (fs.existsSync(logPath)) {
  try {
    fs.unlinkSync(logPath);
  } catch {
    try {
      fs.writeFileSync(logPath, "");
    } catch {}
  }
}

// 3. Start completely detached cloudflared process via CIM (survives shell / task exit on Windows)
console.log("Starting detached cloudflared tunnel (HTTP/2 protocol over TCP)...");
const commandLine = `"${CLOUDFLARED_BIN}" tunnel --protocol http2 --http-host-header 127.0.0.1:3000 --url http://127.0.0.1:3000 --logfile "${logPath}"`;

try {
  const cimCmd = `powershell -NoProfile -Command "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' }"`;
  const cimOutput = execSync(cimCmd, { encoding: "utf-8" });
  console.log("Process successfully created outside caller job object.");
} catch (err) {
  console.error("Failed to start process via CIM:", err.message);
  process.exit(1);
}

// 4. Poll log file for newly assigned trycloudflare.com URL
console.log("Waiting for assigned quick tunnel URL...");
const startTime = Date.now();
const TIMEOUT_MS = 30000;
let tunnelUrl = null;

while (Date.now() - startTime < TIMEOUT_MS) {
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, "utf-8");
    const matches = [...content.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)];
    if (matches.length > 0) {
      // Pick latest assigned URL
      tunnelUrl = matches[matches.length - 1][0];
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 800));
}

if (!tunnelUrl) {
  console.error("Failed to extract tunnel URL within 30 seconds. Check cloudflared.log.");
  process.exit(1);
}

fs.writeFileSync(urlFilePath, tunnelUrl, "utf-8");
console.log("\nAssigned Public Tunnel URL:");
console.log(tunnelUrl);

// 5. Test public connectivity
console.log("\nVerifying public connectivity through Cloudflare Edge...");
let verified = false;
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    const res = await fetch(tunnelUrl, { method: "HEAD" });
    if (res.status === 200 || res.status === 401 || res.status === 404) {
      console.log(`✓ Public connectivity verified! Status: ${res.status}`);
      verified = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

if (!verified) {
  console.warn("Tunnel created, but public edge route is still propagating.");
} else {
  console.log("✓ Tunnel is active, responding, and detached.");
}

console.log(`Saved active URL to ${urlFilePath}`);
