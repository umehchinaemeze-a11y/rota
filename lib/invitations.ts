import crypto from "node:crypto";
import { isManagerRole, type AppRole, APP_ROLES } from "./permissions.ts";
import {
  evaluateSeatCapacity,
  validateMemberAddition,
  type SubscriptionTier,
  type SeatClaimResult,
} from "./seat-limit.ts";

export interface TeamInvitationPayload {
  teamId: number;
  teamName: string;
  role: AppRole;
  email?: string | null;
  invitedBy: number;
  invitedByName: string;
  createdAt: number; // Unix timestamp in seconds
  exp: number; // Unix timestamp in seconds
}

export const INVITATION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Creates a signed, tamper-proof workspace invitation token using HMAC-SHA256.
 */
export function createInvitationToken(
  payload: Omit<TeamInvitationPayload, "createdAt" | "exp">,
  secret: string,
  ttlSeconds = INVITATION_TTL_SECONDS
): string {
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("AUTH_SECRET is required to sign invitation tokens.");
  }

  if (
    !payload ||
    typeof payload.teamId !== "number" ||
    !Number.isInteger(payload.teamId) ||
    payload.teamId <= 0 ||
    typeof payload.teamName !== "string" ||
    !payload.teamName.trim() ||
    typeof payload.role !== "string" ||
    !(APP_ROLES as readonly string[]).includes(payload.role) ||
    typeof payload.invitedBy !== "number" ||
    !Number.isInteger(payload.invitedBy) ||
    payload.invitedBy <= 0 ||
    typeof payload.invitedByName !== "string" ||
    !payload.invitedByName.trim()
  ) {
    throw new Error("Invalid team invitation payload fields.");
  }

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: TeamInvitationPayload = {
    teamId: payload.teamId,
    teamName: payload.teamName.trim(),
    role: payload.role as AppRole,
    ...(payload.email && typeof payload.email === "string" && payload.email.trim()
      ? { email: payload.email.trim().toLowerCase() }
      : {}),
    invitedBy: payload.invitedBy,
    invitedByName: payload.invitedByName.trim(),
    createdAt: now,
    exp: now + ttlSeconds,
  };

  const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies the HMAC-SHA256 signature and expiration of an invitation token.
 * Returns the payload if valid, or null if tampered, malformed, or expired.
 */
export function verifyInvitationToken(
  token: string,
  secret: string,
  nowSeconds?: number
): TeamInvitationPayload | null {
  if (
    !token ||
    typeof token !== "string" ||
    !secret ||
    typeof secret !== "string" ||
    secret.trim().length === 0
  ) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, providedSignature] = parts;

  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(encodedPayload)
      .digest("base64url");

    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    const providedBuffer = Buffer.from(providedSignature, "utf8");

    if (expectedBuffer.length !== providedBuffer.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
      return null;
    }

    const jsonString = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const payload = JSON.parse(jsonString) as TeamInvitationPayload;

    if (
      !payload ||
      typeof payload.teamId !== "number" ||
      !Number.isInteger(payload.teamId) ||
      payload.teamId <= 0 ||
      typeof payload.teamName !== "string" ||
      !payload.teamName ||
      typeof payload.role !== "string" ||
      !(APP_ROLES as readonly string[]).includes(payload.role) ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }

    const currentTimestamp = nowSeconds ?? Math.floor(Date.now() / 1000);
    if (payload.exp < currentTimestamp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Helper to determine whether a caller role can create workspace invitations.
 * Only Owners, Admins, and Supervisors have inviting authority.
 */
export function canInviteToWorkspace(role: unknown): boolean {
  return isManagerRole(role);
}

