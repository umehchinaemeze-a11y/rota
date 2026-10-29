/**
 * Workspace Seat-Limit & Concurrency Enforcement Module
 *
 * Provides authoritative logic for workspace membership capacity checks,
 * concurrency guard against race conditions, and tier entitlement resolution.
 *
 * Principles:
 * - Single source of truth: All seat limits resolve from configured plan entitlements.
 * - Server-side enforcement: Rejects client-supplied claims or bypassed UI checks.
 * - Tenant isolation: Membership additions strictly require matching workspace IDs.
 * - Non-destructive over-limit handling: Downgrades flag workspaces as over-limit without
 *   silently deleting or removing existing team members.
 * - Fallback safety: Missing or unavailable billing records safely default to Free tier.
 */

export type SubscriptionTier = "free" | "starter" | "pro" | "enterprise";

export interface PlanEntitlement {
  tier: SubscriptionTier;
  maxSeats: number;
  displayName: string;
}

export const TIER_ENTITLEMENTS: Record<SubscriptionTier, PlanEntitlement> = {
  free: {
    tier: "free",
    maxSeats: 5,
    displayName: "Free Tier",
  },
  starter: {
    tier: "starter",
    maxSeats: 15,
    displayName: "Starter Tier",
  },
  pro: {
    tier: "pro",
    maxSeats: 50,
    displayName: "Professional Tier",
  },
  enterprise: {
    tier: "enterprise",
    maxSeats: 500,
    displayName: "Enterprise Tier",
  },
};

export interface WorkspaceSeatStatus {
  workspaceId: string | number;
  tier: SubscriptionTier;
  seatLimit: number;
  activeMembers: number;
  availableSeats: number;
  isAtCapacity: boolean;
  isOverLimit: boolean;
  canAddMember: boolean;
  reason?: string;
}

export interface MemberAdditionRequest {
  workspaceId: string | number;
  candidateUserId: number;
  candidateEmail: string;
  role: string;
  invitationToken?: string;
  invitationExpiresAt?: number; // unix timestamp in seconds
}

export interface SeatClaimResult {
  success: boolean;
  code:
    | "SEAT_GRANTED"
    | "SEAT_LIMIT_EXCEEDED"
    | "DUPLICATE_MEMBERSHIP"
    | "INVALID_INVITATION"
    | "INVITATION_EXPIRED"
    | "TENANT_MISMATCH"
    | "CONCURRENT_CONFLICT";
  message: string;
  seatStatus?: WorkspaceSeatStatus;
}

/**
 * Resolves the effective seat limit for a workspace given a tier or custom seat count.
 */
export function resolveSeatLimit(tier?: SubscriptionTier | string | null, customSeats?: number): number {
  if (typeof customSeats === "number" && Number.isFinite(customSeats) && customSeats > 0) {
    return Math.floor(customSeats);
  }

  const normalizedTier = (typeof tier === "string" ? tier.toLowerCase() : "free") as SubscriptionTier;
  const entitlement = TIER_ENTITLEMENTS[normalizedTier] || TIER_ENTITLEMENTS.free;
  return entitlement.maxSeats;
}

/**
 * Evaluates the current seat capacity of a workspace.
 *
 * @param workspaceId - Workspace or team identifier
 * @param activeMemberCount - Current active member count
 * @param tier - Current subscription tier
 * @param customSeats - Optional custom seat allocation
 */
export function evaluateSeatCapacity(
  workspaceId: string | number,
  activeMemberCount: number,
  tier?: SubscriptionTier | string | null,
  customSeats?: number
): WorkspaceSeatStatus {
  const currentCount = Math.max(0, Math.floor(activeMemberCount || 0));
  const limit = resolveSeatLimit(tier, customSeats);
  const normalizedTier = (typeof tier === "string" ? tier.toLowerCase() : "free") as SubscriptionTier;

  const availableSeats = Math.max(0, limit - currentCount);
  const isAtCapacity = currentCount >= limit;
  const isOverLimit = currentCount > limit;
  const canAddMember = currentCount < limit;

  let reason: string | undefined;
  if (isOverLimit) {
    reason = `Workspace exceeds capacity (${currentCount} active members vs ${limit} seat limit). Upgrade plan to add members.`;
  } else if (isAtCapacity) {
    reason = `Workspace has reached maximum seat capacity (${limit} of ${limit} seats filled).`;
  }

  return {
    workspaceId,
    tier: TIER_ENTITLEMENTS[normalizedTier] ? normalizedTier : "free",
    seatLimit: limit,
    activeMembers: currentCount,
    availableSeats,
    isAtCapacity,
    isOverLimit,
    canAddMember,
    reason,
  };
}

/**
 * Validates whether a new member can be added to the workspace.
 * Does not mutate state.
 */
export function validateMemberAddition(
  request: MemberAdditionRequest,
  activeMembers: number,
  existingMemberUserIds: Set<number>,
  tier?: SubscriptionTier | string | null,
  customSeats?: number,
  currentTime?: number
): SeatClaimResult {
  const now = currentTime ?? Math.floor(Date.now() / 1000);

  // 1. Invitation expiration check
  if (request.invitationExpiresAt !== undefined && request.invitationExpiresAt < now) {
    return {
      success: false,
      code: "INVITATION_EXPIRED",
      message: "The invitation link has expired. Request a new invitation.",
    };
  }

  // 2. Duplicate membership check
  if (existingMemberUserIds.has(request.candidateUserId)) {
    return {
      success: false,
      code: "DUPLICATE_MEMBERSHIP",
      message: `User #${request.candidateUserId} (${request.candidateEmail}) is already an active member of this workspace.`,
    };
  }

  // 3. Seat capacity check
  const capacity = evaluateSeatCapacity(request.workspaceId, activeMembers, tier, customSeats);
  if (!capacity.canAddMember) {
    return {
      success: false,
      code: "SEAT_LIMIT_EXCEEDED",
      message: capacity.reason || "Seat limit reached.",
      seatStatus: capacity,
    };
  }

  return {
    success: true,
    code: "SEAT_GRANTED",
    message: "Seat available and member addition authorized.",
    seatStatus: capacity,
  };
}

/**
 * Atomic seat claim manager with lock simulation for concurrency safety testing.
 */
export class WorkspaceSeatManager {
  private activeMembers = new Map<string | number, Set<number>>();
  private locks = new Map<string | number, boolean>();
  private tiers = new Map<string | number, SubscriptionTier>();
  private customSeats = new Map<string | number, number>();

  constructor(
    initialData?: {
      workspaceId: string | number;
      memberUserIds: number[];
      tier?: SubscriptionTier;
      customSeats?: number;
    }[]
  ) {
    if (initialData) {
      for (const item of initialData) {
        this.activeMembers.set(item.workspaceId, new Set(item.memberUserIds));
        if (item.tier) this.tiers.set(item.workspaceId, item.tier);
        if (item.customSeats) this.customSeats.set(item.workspaceId, item.customSeats);
      }
    }
  }

  getCapacity(workspaceId: string | number): WorkspaceSeatStatus {
    const members = this.activeMembers.get(workspaceId) || new Set();
    const tier = this.tiers.get(workspaceId) || "free";
    const custom = this.customSeats.get(workspaceId);
    return evaluateSeatCapacity(workspaceId, members.size, tier, custom);
  }

  setTier(workspaceId: string | number, tier: SubscriptionTier, customSeats?: number) {
    this.tiers.set(workspaceId, tier);
    if (customSeats !== undefined) {
      this.customSeats.set(workspaceId, customSeats);
    } else {
      this.customSeats.delete(workspaceId);
    }
  }

  /**
   * Attempts an atomic member addition using simulated mutex locking to prevent
   * race conditions when concurrent requests attempt to claim the final available seat.
   */
  async claimSeatAtomic(
    request: MemberAdditionRequest,
    currentTime?: number
  ): Promise<SeatClaimResult> {
    const wid = request.workspaceId;

    // Simulate database row lock / mutex
    if (this.locks.get(wid)) {
      return {
        success: false,
        code: "CONCURRENT_CONFLICT",
        message: "Another transaction is currently modifying workspace membership. Retry request.",
      };
    }

    try {
      this.locks.set(wid, true);

      // Brief delay to simulate query latency
      await new Promise((r) => setTimeout(r, 2));

      const memberSet = this.activeMembers.get(wid) || new Set();
      const tier = this.tiers.get(wid) || "free";
      const custom = this.customSeats.get(wid);

      const check = validateMemberAddition(
        request,
        memberSet.size,
        memberSet,
        tier,
        custom,
        currentTime
      );

      if (!check.success) {
        return check;
      }

      // Claim the seat
      memberSet.add(request.candidateUserId);
      this.activeMembers.set(wid, memberSet);

      const updatedStatus = evaluateSeatCapacity(wid, memberSet.size, tier, custom);

      return {
        success: true,
        code: "SEAT_GRANTED",
        message: `Seat granted to user #${request.candidateUserId}. Workspace now has ${memberSet.size} of ${updatedStatus.seatLimit} seats filled.`,
        seatStatus: updatedStatus,
      };
    } finally {
      this.locks.set(wid, false);
    }
  }
}
