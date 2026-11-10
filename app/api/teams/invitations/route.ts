import type { SessionPayload } from "../../../../lib/auth.ts";
import { getAuthSecret } from "../../../../lib/session.ts";
import {
  createInvitationToken,
  verifyInvitationToken,
  canInviteToWorkspace,
} from "../../../../lib/invitations.ts";
import { APP_ROLES, type AppRole } from "../../../../lib/permissions.ts";
import { evaluateSeatCapacity, type SubscriptionTier } from "../../../../lib/seat-limit.ts";
import { getPaystackPlan } from "../../../../lib/paystack.ts";
import { enforceRateLimit } from "../../../../lib/rate-limit.ts";

export type InvitationsDependencies = {
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
      import("../../../../lib/db.ts"),
      import("../../../../lib/session.ts"),
    ]).then(([{ sql }, { getSessionUser }]) => ({ sql, getSessionUser }));
  }
  return prodDepsPromise;
}

export async function handleCreateInvitation(
  request: Request,
  deps: InvitationsDependencies = {}
): Promise<Response> {
  try {
    const shouldEnforceRateLimit = deps.skipRateLimit === false || (!deps.skipRateLimit && !deps.sql);
    if (shouldEnforceRateLimit) {
      const { response: rateLimitResp } = await enforceRateLimit(request, {
        action: "create-invitation",
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
        { error: "Authentication required to generate workspace invitations." },
        { status: 401 }
      );
    }

    // 2. Parse request body
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // Body can be empty for default invitation
    }

    const requestedRole = (
      typeof body.role === "string" && body.role.trim() ? body.role.trim() : "Front Desk"
    ) as AppRole;

    if (!(APP_ROLES as readonly string[]).includes(requestedRole)) {
      return Response.json(
        { error: `Invalid role "${requestedRole}". Valid roles are: ${APP_ROLES.join(", ")}.` },
        { status: 400 }
      );
    }

    if (requestedRole === "Owner") {
      return Response.json(
        { error: "Owner role cannot be granted via team invitation." },
        { status: 400 }
      );
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;

    // 3. Resolve target workspace
    let targetTeamId: number | null = null;
    if (typeof body.teamId === "number" && Number.isInteger(body.teamId) && body.teamId > 0) {
      targetTeamId = body.teamId;
    } else if (typeof sessionUser.teamId === "number" && sessionUser.teamId > 0) {
      targetTeamId = sessionUser.teamId;
    }

    // Look up caller's membership in target workspace (or default workspace)
    const membershipRows = targetTeamId
      ? await executeSql`
          SELECT tm.team_id, tm.role, t.name as team_name
          FROM team_memberships tm
          JOIN teams t ON t.id = tm.team_id
          WHERE tm.user_id = ${sessionUser.userId} AND tm.team_id = ${targetTeamId}
          LIMIT 1;
        `
      : await executeSql`
          SELECT tm.team_id, tm.role, t.name as team_name
          FROM team_memberships tm
          JOIN teams t ON t.id = tm.team_id
          WHERE tm.user_id = ${sessionUser.userId}
          ORDER BY tm.is_default DESC, tm.id ASC
          LIMIT 1;
        `;

    if (!membershipRows || membershipRows.length === 0) {
      return Response.json(
        { error: "You are not a member of any workspace to create invitations." },
        { status: 403 }
      );
    }

    const membership = membershipRows[0];
    const resolvedTeamId = Number(membership.team_id);
    const resolvedTeamName = String(membership.team_name);

    // 4. Verify inviting authority (Owner, Admin, Supervisor)
    if (!canInviteToWorkspace(membership.role)) {
      return Response.json(
        {
          error: `Forbidden: Members with role "${membership.role}" do not have authority to invite new team members.`,
        },
        { status: 403 }
      );
    }

    // 5. Check workspace seat capacity using authoritative Paystack billing and seat-limit logic
    const memberCountRows = await executeSql`
      SELECT COUNT(*)::int as count
      FROM team_memberships
      WHERE team_id = ${resolvedTeamId};
    `;
    const activeMemberCount = Number(memberCountRows?.[0]?.count ?? 1);

    let tier: SubscriptionTier = "free";
    let customSeats: number | undefined = undefined;

    try {
      const subRows = await executeSql`
        SELECT plan_id, seats, status
        FROM workspace_subscriptions
        WHERE team_id = ${resolvedTeamId}
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
      // workspace_subscriptions might be absent or empty; default to Free tier (5 seats)
    }

    const capacity = evaluateSeatCapacity(resolvedTeamId, activeMemberCount, tier, customSeats);
    if (!capacity.canAddMember) {
      return Response.json(
        {
          error:
            capacity.reason ||
            `Workspace has reached maximum seat capacity (${capacity.seatLimit} seats). Upgrade plan to invite more members.`,
          seatStatus: capacity,
        },
        { status: 409 }
      );
    }

    // 6. Generate signed token
    const token = createInvitationToken(
      {
        teamId: resolvedTeamId,
        teamName: resolvedTeamName,
        role: requestedRole,
        email,
        invitedBy: sessionUser.userId,
        invitedByName: sessionUser.name || "A team manager",
      },
      secret
    );

    const relativeUrl = `/invite?token=${encodeURIComponent(token)}`;

    return Response.json({
      success: true,
      token,
      inviteUrl: relativeUrl,
      role: requestedRole,
      teamId: resolvedTeamId,
      teamName: resolvedTeamName,
      invitedByName: sessionUser.name,
      seatStatus: capacity,
    });
  } catch (error) {
    console.error("Failed to generate team invitation:", error);
    return Response.json(
      { error: "Unable to generate team invitation. Please try again." },
      { status: 500 }
    );
  }
}

export async function handleVerifyInvitation(
  request: Request,
  deps: InvitationsDependencies = {}
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return Response.json(
        { error: "Invitation token parameter 'token' is required." },
        { status: 400 }
      );
    }

    const secret = deps.getSecret ? deps.getSecret() : getAuthSecret();
    const payload = verifyInvitationToken(token, secret);

    if (!payload) {
      return Response.json(
        { error: "This invitation link is invalid or has expired." },
        { status: 400 }
      );
    }

    return Response.json({
      valid: true,
      teamId: payload.teamId,
      teamName: payload.teamName,
      role: payload.role,
      email: payload.email ?? null,
      invitedByName: payload.invitedByName,
      expiresAt: payload.exp,
    });
  } catch (error) {
    console.error("Failed to verify invitation token:", error);
    return Response.json(
      { error: "Failed to verify invitation." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return handleCreateInvitation(request);
}

export async function GET(request: Request) {
  return handleVerifyInvitation(request);
}
