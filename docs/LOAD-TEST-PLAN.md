# Rota — 200 Virtual User (VU) Capacity & Stress Testing Plan

## 1. Overview & Safety Policies

This document specifies the execution procedure, safety guardrails, scenario breakdown, and acceptance thresholds for the **200 Virtual User (VU)** load testing requirement for Rota.

> ### MANDATORY SAFETY RESTRICTION
> **NEVER execute load tests against the live production deployment (`rota-lovat-gamma.vercel.app`) or any shared cloud database.**
> The load test script (`scripts/load-test-200vu.mjs`) contains an automated, fail-closed guard that actively rejects any target matching `*.vercel.app` or `rota-lovat-gamma.vercel.app`.

### Permitted Test Environments
Load testing is authorized only against:
1. **Isolated Local Dev Server**: `http://localhost:3000` or `http://127.0.0.1:3000` (backed by a local PostgreSQL container or an isolated disposable Neon staging branch).
2. **Dedicated Staging Instance**: An isolated staging deployment explicitly confirmed via the `--confirm-isolated-target <hostname>` two-factor CLI parameter.

---

## 2. Load Profile & Test Parameters

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| **Virtual Users (VUs)** | 200 concurrent users | Meets graduation requirement under peak shift-change workload. |
| **Ramp-Up Duration** | 5 seconds | Gradually spins up worker threads from 0 to 200 VUs. |
| **Sustained Duration** | 30 seconds | Sustained stress window to capture steady-state throughput and latency percentiles. |
| **Cool-Down Duration** | 5 seconds | Gracefully winds down active connections. |
| **Simulated Scenarios** | 4 multi-endpoint flows | 30% `GET /`, 30% `GET /api/shifts`, 20% `GET /api/auth/me`, 20% `POST /api/auth/login`. |

---

## 3. Grounded Acceptance Thresholds

Based on the Next.js App Router serverless architecture and Neon connection pool behavior, the following service level objectives (SLOs) define a successful 200-VU test:

1. **Availability / Error Rate**: Non-2xx response rate must be **< 1.0%** under steady-state load.
2. **Median Latency (p50)**: **< 150 ms** for cached/static endpoints; **< 350 ms** for authenticated database queries.
3. **95th Percentile Latency (p95)**: **< 600 ms** across all endpoints.
4. **99th Percentile Latency (p99)**: **< 1,200 ms** (bounding tail latency spikes).
5. **Throughput**: Sustained throughput of **>= 150 requests per second** without connection drops or worker unhandled rejections.

---

## 4. Reproducible Execution Command

### Dry-Run / Preview Mode (Offline Safe — Zero Traffic)
```bash
node scripts/load-test-200vu.mjs
```
*Outputs current configuration and exits with status 0 without generating any HTTP requests.*

### Local Isolated Execution (Requires Running Local Server)
In Terminal 1 (start local server on port 3000):
```bash
npm run dev
```

In Terminal 2 (execute load test against local server):
```bash
node scripts/load-test-200vu.mjs \
  --run-load \
  --target http://localhost:3000 \
  --vus 200 \
  --duration 30 \
  --ramp-up 5
```

---

## 5. Load Test Results Reporting Template

When an operator executes the test in an authorized isolated environment, record the results using this template:

```markdown
### 200-VU Load Test Execution Report

* **Date of Execution:** YYYY-MM-DD
* **Environment:** Isolated Local / Dedicated Staging (<target_host>)
* **Concurrent VUs:** 200
* **Test Duration:** 30 seconds (5s ramp-up)
* **Total Requests Issued:** [e.g. 5,420]
* **Sustained Throughput:** [e.g. 180.6 req/sec]
* **Successful Responses (2xx):** [e.g. 5,418 (99.96%)]
* **Failed / Error Responses:** [e.g. 2 (0.04%)]

#### Latency Percentiles
* **Min Latency:** XX ms
* **Average Latency:** XX ms
* **Median (p50):** XX ms
* **90th Percentile (p90):** XX ms
* **95th Percentile (p95):** XX ms
* **99th Percentile (p99):** XX ms
* **Max Latency:** XX ms

#### Endpoint Breakdown
| Endpoint | Requests | p50 (ms) | p95 (ms) | Error Rate |
| :--- | :--- | :--- | :--- | :--- |
| `GET /` | - | - | - | 0.0% |
| `GET /api/shifts` | - | - | - | 0.0% |
| `GET /api/auth/me` | - | - | - | 0.0% |
| `POST /api/auth/login` | - | - | - | 0.0% |

#### Conclusion & SLO Compliance
* [Pass / Fail] p95 latency under 600 ms threshold.
* [Pass / Fail] Error rate below 1.0%.
* Zero connection pooling exhaustion or database socket leaks observed.
```
