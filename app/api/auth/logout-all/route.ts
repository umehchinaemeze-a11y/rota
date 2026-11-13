import { handleLogout, type LogoutRouteDependencies } from "../logout/route.ts";
import { isSameOriginRequest } from "../../../../lib/oauth/safe-redirect.ts";

export async function handleLogoutAll(
  request: Request,
  deps: LogoutRouteDependencies = {}
): Promise<Response> {
  const url = new URL(request.url);
  url.searchParams.set("all", "true");
  const modRequest = new Request(url.toString(), {
    method: "POST",
    headers: request.headers,
  });
  return handleLogout(modRequest, deps);
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  return handleLogoutAll(request);
}

