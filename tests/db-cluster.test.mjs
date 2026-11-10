import test, { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  inspectConnectionPooling,
  getShardForTeam,
  resolveQueryRoute,
  markUserWrite,
  shouldRouteToPrimaryForRyow,
  clearRyowRegistry,
  createClusterRouter,
  DEFAULT_POOL_CONFIG,
} from "../lib/db-cluster.ts";

describe("PostgreSQL Connection Pooling & Cluster Architecture", () => {
  it("detects Neon PgBouncer connection pooler host configuration correctly", () => {
    const pooledUrl = "postgresql://user:pass@ep-cool-fog-12345-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
    const directUrl = "postgresql://user:pass@ep-cool-fog-12345.us-east-2.aws.neon.tech/neondb?sslmode=require";

    const pooledInfo = inspectConnectionPooling(pooledUrl);
    assert.equal(pooledInfo.isPooled, true);
    assert.equal(pooledInfo.poolerMode, "pgbouncer");
    assert.match(pooledInfo.host, /-pooler/);

    const directInfo = inspectConnectionPooling(directUrl);
    assert.equal(directInfo.isPooled, false);
    assert.equal(directInfo.poolerMode, "direct");

    assert.equal(DEFAULT_POOL_CONFIG.maxConnections, 20);
    assert.equal(DEFAULT_POOL_CONFIG.idleTimeoutMillis, 30000);
    assert.equal(DEFAULT_POOL_CONFIG.statementTimeoutMillis, 10000);
  });
});

describe("Two-Database PostgreSQL Sharding (Deterministic team_id Hash)", () => {
  it("routes identical team_id to the exact same shard deterministically", () => {
    const teamA = 101;
    const shardA1 = getShardForTeam(teamA);
    const shardA2 = getShardForTeam(teamA);

    assert.equal(shardA1.shardId, shardA2.shardId);
    assert.equal(shardA1.shardIndex, shardA2.shardIndex);
    assert.ok(["shard_0", "shard_1"].includes(shardA1.shardId));
  });

  it("distributes multiple teams across both Shard 0 and Shard 1", () => {
    const teams = Array.from({ length: 50 }, (_, i) => i + 1);
    const shardCounts = { shard_0: 0, shard_1: 0 };

    for (const tid of teams) {
      const res = getShardForTeam(tid);
      shardCounts[res.shardId]++;
    }

    assert.ok(shardCounts.shard_0 > 10, "Shard 0 should receive a balanced distribution");
    assert.ok(shardCounts.shard_1 > 10, "Shard 1 should receive a balanced distribution");
  });
});

describe("Read/Write Splitting & Read-Your-Own-Writes (RYOW) Consistency", () => {
  beforeEach(() => {
    clearRyowRegistry();
  });

  it("routes write operations directly to Primary node and records user write", () => {
    const res = resolveQueryRoute({
      isWrite: true,
      teamId: 5,
      userId: 99,
    });

    assert.equal(res.targetNode, "primary");
    assert.equal(res.reason, "mutation_write");
    assert.equal(shouldRouteToPrimaryForRyow(99), true);
  });

  it("routes reads to Primary during the active consistency window after a write", () => {
    const now = 1000000;
    markUserWrite(88, now);

    // Read within 5-second window -> Primary
    const ryowDecision = resolveQueryRoute({
      isWrite: false,
      teamId: 5,
      userId: 88,
      now: now + 2000, // 2s later
    });

    assert.equal(ryowDecision.targetNode, "primary");
    assert.equal(ryowDecision.reason, "ryow_read_consistency");
  });

  it("routes reads to Replica once the RYOW consistency window expires", () => {
    const now = 1000000;
    markUserWrite(88, now);

    // Read after 6 seconds (> 5s window) -> Replica
    const expiredDecision = resolveQueryRoute({
      isWrite: false,
      teamId: 5,
      userId: 88,
      now: now + 6000,
    });

    assert.equal(expiredDecision.targetNode, "replica");
    assert.equal(expiredDecision.reason, "read_replica_optimized");
  });

  it("dispatches requests to the exact client shard and role using createClusterRouter", () => {
    const mockClients = {
      primaryShard0: { id: "p0" },
      replicaShard0: { id: "r0" },
      primaryShard1: { id: "p1" },
      replicaShard1: { id: "r1" },
    };

    const router = createClusterRouter(mockClients);

    const team1Shard = getShardForTeam(1).shardId;
    const writeRes = router.getClient({ isWrite: true, teamId: 1, userId: 12 });
    assert.equal(writeRes.client.id, team1Shard === "shard_0" ? "p0" : "p1");
    assert.equal(writeRes.decision.targetNode, "primary");

    const readRes = router.getClient({ isWrite: false, teamId: 1, userId: null });
    assert.equal(readRes.client.id, team1Shard === "shard_0" ? "r0" : "r1");
    assert.equal(readRes.decision.targetNode, "replica");
  });
});
