/**
 * Advanced PostgreSQL Cluster & Sharding Engine.
 *
 * Implements:
 * - Connection pooling configuration & metrics
 * - Read/Write splitting (Primary vs Replica)
 * - Read-Your-Own-Writes (RYOW) session-level consistency tracking
 * - Two-database PostgreSQL sharding simulation (Shard 0 & Shard 1)
 * - team_id deterministic hash-based shard routing
 */

import crypto from "node:crypto";
import type { NeonClient } from "./db.ts";

export interface PoolConfig {
  maxConnections: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
  isPoolerHost: boolean;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxConnections: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statementTimeoutMillis: 10000,
  isPoolerHost: true,
};

/**
 * Parses connection string to verify whether Neon connection pooler is in use.
 * Neon poolers append `-pooler` to the host name (e.g. ep-xyz-pooler.region.neon.tech).
 */
export function inspectConnectionPooling(databaseUrl: string): {
  isPooled: boolean;
  poolerMode: "pgbouncer" | "direct" | "unknown";
  host: string;
} {
  if (!databaseUrl || typeof databaseUrl !== "string") {
    return { isPooled: false, poolerMode: "direct", host: "unconfigured" };
  }

  try {
    const parsed = new URL(databaseUrl.trim());
    const host = parsed.hostname;
    const isPooled = host.includes("-pooler") || parsed.searchParams.get("pool") === "true";
    const poolerMode = isPooled ? "pgbouncer" : "direct";

    return {
      isPooled,
      poolerMode,
      host,
    };
  } catch {
    return { isPooled: false, poolerMode: "direct", host: "invalid_url" };
  }
}

/**
 * Session-level tracking for Read-Your-Own-Writes (RYOW) consistency.
 * Prevents replica lag anomalies by routing queries to Primary for a consistency window
 * after a write mutation has been performed by a user/session.
 */
export const RYOW_CONSISTENCY_WINDOW_MS = 5000;

const recentWritesRegistry = new Map<string, number>();

export function markUserWrite(userId: number | string, timestamp = Date.now()): void {
  recentWritesRegistry.set(String(userId), timestamp);
}

export function shouldRouteToPrimaryForRyow(
  userId: number | string | null | undefined,
  now = Date.now(),
  windowMs = RYOW_CONSISTENCY_WINDOW_MS
): boolean {
  if (!userId) return false;
  const lastWriteTime = recentWritesRegistry.get(String(userId));
  if (!lastWriteTime) return false;

  if (now - lastWriteTime < windowMs) {
    return true;
  }

  // Cleanup expired entry
  recentWritesRegistry.delete(String(userId));
  return false;
}

export function clearRyowRegistry(): void {
  recentWritesRegistry.clear();
}

/**
 * Computes deterministic shard allocation for a team using consistent SHA-256 integer hash.
 * Two-database sharding simulation: Shard 0 vs Shard 1.
 */
export type ShardId = "shard_0" | "shard_1";

export function getShardForTeam(teamId: number | string, totalShards = 2): {
  shardId: ShardId;
  shardIndex: number;
  hash: number;
} {
  const normTeamId = String(teamId).trim();
  const digest = crypto.createHash("sha256").update(`team_shard_salt:${normTeamId}`).digest("hex");
  const hashInt = parseInt(digest.slice(0, 8), 16);
  const shardIndex = hashInt % totalShards;
  const shardId: ShardId = shardIndex === 0 ? "shard_0" : "shard_1";

  return {
    shardId,
    shardIndex,
    hash: hashInt,
  };
}

export type DbRole = "primary" | "replica";

export interface ClusterRouteDecision {
  targetNode: DbRole;
  targetShard: ShardId;
  reason: "mutation_write" | "ryow_read_consistency" | "read_replica_optimized";
}

/**
 * Evaluates routing decision across Primary/Replica and Team Shards.
 */
export function resolveQueryRoute(params: {
  isWrite: boolean;
  teamId?: number | string | null;
  userId?: number | string | null;
  now?: number;
}): ClusterRouteDecision {
  const { isWrite, teamId = 1, userId = null, now = Date.now() } = params;
  const shard = getShardForTeam(teamId || 1);

  if (isWrite) {
    if (userId) {
      markUserWrite(userId);
    }
    return {
      targetNode: "primary",
      targetShard: shard.shardId,
      reason: "mutation_write",
    };
  }

  if (userId && shouldRouteToPrimaryForRyow(userId, now)) {
    return {
      targetNode: "primary",
      targetShard: shard.shardId,
      reason: "ryow_read_consistency",
    };
  }

  return {
    targetNode: "replica",
    targetShard: shard.shardId,
    reason: "read_replica_optimized",
  };
}

export interface ShardedClusterClients {
  primaryShard0: NeonClient;
  primaryShard1: NeonClient;
  replicaShard0: NeonClient;
  replicaShard1: NeonClient;
}

/**
 * Creates a sharded cluster router that directs operations to the appropriate node.
 */
export function createClusterRouter(clients: ShardedClusterClients) {
  return {
    getClient(params: {
      isWrite: boolean;
      teamId?: number | string | null;
      userId?: number | string | null;
    }): { client: NeonClient; decision: ClusterRouteDecision } {
      const decision = resolveQueryRoute(params);

      if (decision.targetShard === "shard_0") {
        return {
          client: decision.targetNode === "primary" ? clients.primaryShard0 : clients.replicaShard0,
          decision,
        };
      }

      return {
        client: decision.targetNode === "primary" ? clients.primaryShard1 : clients.replicaShard1,
        decision,
      };
    },
  };
}
