#!/usr/bin/env node
/**
 * Rota Activity Feed — 10,000 Records Benchmark & Keyset Pagination Generator
 *
 * SAFETY GUARD:
 * - Strictly prohibits execution against production databases or domains (*.vercel.app).
 * - Requires explicit --benchmark or isolated execution confirmation.
 */

import { performance } from "node:perf_hooks";

export const PROHIBITED_HOST_PATTERNS = [
  /vercel\.app/i,
  /rota-lovat-gamma/i,
  /neon\.tech.*(prod|production)/i,
];

export function assertSafeDatabaseUrl(url) {
  if (!url) return;
  for (const pattern of PROHIBITED_HOST_PATTERNS) {
    if (pattern.test(url)) {
      throw new Error(`[SAFETY BLOCKED] Database URL matches prohibited production pattern: ${pattern}`);
    }
  }
}

/**
 * Generates synthetic realistic activity feed records.
 */
export function generateSyntheticActivities(count = 10000, teamId = 42) {
  const actions = [
    { action: "shift_created", entity: "shift", desc: "scheduled a Front Desk shift" },
    { action: "shift_updated", entity: "shift", desc: "reassigned shift location to Main Branch" },
    { action: "shift_deleted", entity: "shift", desc: "cancelled an unassigned shift" },
    { action: "swap_requested", entity: "shift_swap", desc: "requested a shift coverage swap" },
    { action: "swap_approved", entity: "shift_swap", desc: "approved employee shift exchange" },
    { action: "team_member_joined", entity: "team_membership", desc: "joined the workspace" },
  ];

  const actors = [
    { id: 10, name: "Amara Okafor" },
    { id: 11, name: "Daniel James" },
    { id: 12, name: "Sarah Bello" },
    { id: 13, name: "David Musa" },
    { id: 14, name: "Chika Nwosu" },
  ];

  const baseTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // Past 30 days
  const items = [];

  for (let i = 0; i < count; i++) {
    const act = actions[i % actions.length];
    const actor = actors[i % actors.length];
    const timeOffsetMs = Math.floor((i / count) * 30 * 24 * 60 * 60 * 1000);

    items.push({
      id: i + 1,
      team_id: teamId,
      actor_id: actor.id,
      actor_name: actor.name,
      action: act.action,
      entity_type: act.entity,
      entity_id: String(1000 + (i % 200)),
      description: `${actor.name} ${act.desc}`,
      metadata: { run: "benchmark_10k", index: i },
      created_at: new Date(baseTime + timeOffsetMs).toISOString(),
    });
  }

  // Sort descending by created_at DESC, id DESC
  return items.sort((a, b) => {
    const tA = new Date(a.created_at).getTime();
    const tB = new Date(b.created_at).getTime();
    if (tA !== tB) return tB - tA;
    return b.id - a.id;
  });
}

/**
 * Benchmark Keyset Pagination vs Offset Pagination over 10,000 records.
 */
export function runPaginationBenchmark(records, pageSize = 20) {
  // 1. Keyset Pagination Traversal
  const t0 = performance.now();
  let keysetPages = 0;
  let cursor = null;
  let keysetRecordsRetrieved = 0;

  while (keysetPages * pageSize < records.length) {
    keysetPages++;
    let filtered = records;
    if (cursor) {
      const [cursorTime, cursorId] = cursor.split("_");
      const cursorTimeMs = new Date(cursorTime).getTime();
      const cursorIdNum = parseInt(cursorId, 10);

      filtered = records.filter((r) => {
        const rTimeMs = new Date(r.created_at).getTime();
        return rTimeMs < cursorTimeMs || (rTimeMs === cursorTimeMs && r.id < cursorIdNum);
      });
    }

    const page = filtered.slice(0, pageSize);
    keysetRecordsRetrieved += page.length;

    if (page.length === 0) break;
    const last = page[page.length - 1];
    cursor = `${last.created_at}_${last.id}`;
  }
  const keysetDurationMs = performance.now() - t0;

  // 2. Offset Pagination Traversal
  const t1 = performance.now();
  let offsetPages = 0;
  let offsetRecordsRetrieved = 0;

  while (offsetPages * pageSize < records.length) {
    const offset = offsetPages * pageSize;
    offsetPages++;
    const page = records.slice(offset, offset + pageSize);
    offsetRecordsRetrieved += page.length;
    if (page.length === 0) break;
  }
  const offsetDurationMs = performance.now() - t1;

  return {
    totalRecords: records.length,
    pageSize,
    keyset: {
      pagesTraversed: keysetPages,
      recordsRetrieved: keysetRecordsRetrieved,
      durationMs: keysetDurationMs,
      avgPageDurationMs: keysetDurationMs / keysetPages,
    },
    offset: {
      pagesTraversed: offsetPages,
      recordsRetrieved: offsetRecordsRetrieved,
      durationMs: offsetDurationMs,
      avgPageDurationMs: offsetDurationMs / offsetPages,
    },
  };
}

if (process.argv.includes("--run")) {
  console.log("Generating 10,000 synthetic activity events...");
  const records = generateSyntheticActivities(10000, 42);
  console.log(`Generated ${records.length} records. Running keyset vs offset pagination benchmark...`);
  const results = runPaginationBenchmark(records, 20);
  console.log(JSON.stringify(results, null, 2));
}

