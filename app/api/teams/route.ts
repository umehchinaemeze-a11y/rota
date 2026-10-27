import { handleCreateTeam } from "@/lib/teams";

export async function POST(request: Request) {
  return handleCreateTeam(request);
}
