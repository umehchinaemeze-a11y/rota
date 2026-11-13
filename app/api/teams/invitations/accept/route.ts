import type { SessionPayload } from "../../../../../lib/auth.ts";
import { createSessionToken } from "../../../../../lib/auth.ts";
import { getAuthSecret, serializeSessionCookie } from "../../../../../lib/session.ts";
import { verifyInvitationToken } from "../../../../../lib/invitations.ts";
import { isSameOriginRequest } from "../../../../../lib/oauth/safe-redirect.ts";
import {
  evaluateSeatCapacity,
  validateMemberAddition,
  type SubscriptionTier,
} from "../../../../../lib/seat-limit.ts";
import { getPaystackPlan } from "../../../../../lib/paystack.ts";
import { enforceRateLimit } from "../../../../../lib/rate-limit.ts";

export type AcceptInvitationDependencies = {
  sql?: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser?: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
  getSecret?: () => string;
  skipRateLimit?: boolean;
};

let prodDepsPromise: Promise<{
  sql: (strings: TemplateStringsArray, ...values: any[]) => Promise<any>;
  getSessionUser: (options?: { revalidateWithDb?: boolean }) => Promise<SessionPayload | null>;
}> | null = null;

async function loadProductionDependencies() {
  if (!prodDepsPromise) {
    prodDepsPromise = Promise.all([
      import("../../../../../lib/db.ts"),
      import("../../../../../lib/session.ts"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleAcceptInvitation(
  request: Request,
  deps: AcceptInvitationDependencies = {}
): Promise<Response> {
  try {
    const shouldEnforceRateLimit = deps.skipRateLimit === false || (!deps.skipRateLimit && !deps.sql);
    if (shouldEnforceRateLimit) {
      const { response: rateLimitResp } = await enforceRateLimit(request, {
        action: "accept-invitation",
        limit: 10,
        windowSeconds: 60,
      });
      if (rateLimitResp) {
        return rateLimitResp;
      }
    }
    const { getSessionUser: prodGetSessionUser, sql: prodSql } =
      !deps.getSessionUser || !deps.sql
        ? await loadProductionDependencies()
        : { getSessionUser: deps.getSessionUser, sql: deps.sql };

    const resolveSessionUser = deps.getSessionUser ?? prodGetSessionUser;
    const executeSql = deps.sql ?? prodSql;
    const secret = deps.getSecret ? deps.getSecret() : getAuthSecret();

    // 1. Authenticate caller
    const sessionUser = await resolveSessionUser({ revalidateWithDb: true });
    if (!sessionUser || !sessionUser.userId) {
      return Response.json(
        { error: "Authentication required. Please sign in or register to accept this workspace invitation." },
        { status: 401 }
      );
    }

    // 2. Parse request body
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid request payload. Expected JSON with invitation token." },
        { status: 400 }
      );
    }

    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) {
      return Response.json(
        { error: "Invitation token is required." },
        { status: 400 }
      );
    }

    // 3. Verify token
    const invitation = verifyInvitationToken(token, secret);
    if (!invitation) {
      return Response.json(
        { error: "This invitation link is invalid or has expired." },
        { status: 400 }
      );
    }

    // Optional email recipient check (if invitation was targeted to a specific email)
    if (
      invitation.email &&
      sessionUser.email &&
      invitation.email.toLowerCase() !== sessionUser.email.toLowerCase()
    ) {
      return Response.json(
        {
          error: `This invitation was issued to ${invitation.email}. You are currently signed in as ${sessionUser.email}.`,
        },
        { status: 403 }
      );
    }

    // 4. Duplicate membership check
    const existingMembership = await executeSql`
      SELECT id, role, is_default
      FROM team_memberships
      WHERE user_id = ${sessionUser.userId} AND team_id = ${invitation.teamId}
      LIMIT 1;
    `;

    if (existingMembership && existingMembership.length > 0) {
      return Response.json(
        {
          error: `You are already a member of "${invitation.teamName}" with the role "${existingMembership[0].role}".`,
        },
        { status: 409 }
      );
    }

    // 5. Authoritative seat limit & member validation
    const memberRows = await executeSql`
      SELECT user_id
      FROM team_memberships
      WHERE team_id = ${invitation.teamId};
    `;
    const existingMemberUserIds = new Set<number>(
      (memberRows || []).map((m: any) => Number(m.user_id))
    );
    const activeMemberCount = existingMemberUserIds.size;

    let tier: SubscriptionTier = "free";
    let customSeats: number | undefined = undefined;

    try {
      const subRows = await executeSql`
        SELECT plan_id, seats, status
        FROM workspace_subscriptions
        WHERE team_id = ${invitation.teamId}
        LIMIT 1;
      `;
      if (subRows && subRows.length > 0) {
        const sub = subRows[0];
        const isActive = sub.status === "active" || sub.status === "trialing";
        if (isActive) {
          const planConfig = getPaystackPlan(sub.plan_id);
          tier = planConfig.tier;
          if (typeof sub.seats === "number" && Number.isInteger(sub.seats) && sub.seats > 0) {
            customSeats = sub.seats;
          } else {
            customSeats = planConfig.maxSeats;
          }
        }
      }
    } catch {
      // workspace_subscriptions might be empty; default to Free tier (5 seats)
    }

    const claimResult = validateMemberAddition(
      {
        workspaceId: invitation.teamId,
        candidateUserId: sessionUser.userId,
        candidateEmail: sessionUser.email,
        role: invitation.role,
        invitationExpiresAt: invitation.exp,
      },
      activeMemberCount,
      existingMemberUserIds,
      tier,
      customSeats
    );

    if (!claimResult.success) {
      const statusCode =
        claimResult.code === "DUPLICATE_MEMBERSHIP"
          ? 409
          : claimResult.code === "SEAT_LIMIT_EXCEEDED"
            ? 409
            : 400;

      return Response.json(
        {
          error: claimResult.message,
          code: claimResult.code,
          seatStatus: claimResult.seatStatus,
        },
        { status: statusCode }
      );
    }

    // 6. Check if user already has a default team
    const existingDefault = await executeSql`
      SELECT id
      FROM team_memberships
      WHERE user_id = ${sessionUser.userId} AND is_default = TRUE
      LIMIT 1;
    `;
    const isDefault = !existingDefault || existingDefault.length === 0;

    // 7. Insert membership atomically
    const insertedRows = await executeSql`
      INSERT INTO team_memberships (team_id, user_id, role, is_default)
      VALUES (${invitation.teamId}, ${sessionUser.userId}, ${invitation.role}, ${isDefault})
      RETURNING id, team_id, user_id, role, is_default;
    `;

    // 8. Re-issue updated session token with new teamId active
    const updatedSession = createSessionToken(
      {
        userId: sessionUser.userId,
        email: sessionUser.email,
        name: sessionUser.name,
        role: sessionUser.role,
        teamId: invitation.teamId,
      },
      secret
    );

    const cookieHeader = serializeSessionCookie(updatedSession, undefined, request);

    // Invalidate cached team roster
    try {
      const { invalidateTeamCache } = await import("../../../../../lib/cache.ts");
      await invalidateTeamCache(invitation.teamId);
    } catch {
      // Invalidation fails open
    }

    const response = Response.json({
      success: true,
      message: `You have successfully joined "${invitation.teamName}" as ${invitation.role}.`,
      membership: {
        teamId: invitation.teamId,
        teamName: invitation.teamName,
        role: invitation.role,
        isDefault,
      },
    });

    response.headers.set("Set-Cookie", cookieHeader);
    return response;
  } catch (error) {
    console.error("Failed to accept workspace invitation:", error);
    return Response.json(
      { error: "Failed to accept workspace invitation. Please try again." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  return handleAcceptInvitation(request);
}
