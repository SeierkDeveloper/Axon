// Who may act for the person who hired a job: answer its question, decide on its plan. The hire's claimToken
// (X-Claim-Token) for a hire made without signing in, otherwise the hirer's API key, or the allowance key that paid
// for it. The owner of the agent may read a job, but does not get to speak for the person who hired it.

import { type NextRequest, type NextResponse } from "next/server";
import { type Task } from "./tasks";
import { canAccessIdentity, requireApiKey } from "./apiAuth";
import { claimTokenValid } from "./mcpServer";
import { apiError } from "./apiError";
import { getDb } from "./db";

/** Null when this caller hired the job; otherwise the response that turns them away. */
export function notTheHirer(req: NextRequest, taskId: string, task: Task | null): NextResponse | null {
  const claimToken = req.headers.get("x-claim-token");
  if (claimToken) {
    if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
    return claimTokenValid(taskId, claimToken) ? null : apiError("FORBIDDEN", "Invalid claim token for this task", 403);
  }
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
  const mine = auth.user.scope === "allowance"
    ? Boolean(getDb().prepare("SELECT 1 FROM allowance_reservations WHERE task_id = ? AND api_key_id = ?").get(taskId, auth.user.keyId))
    : canAccessIdentity(auth.user, task.fromAgent);
  return mine ? null : apiError("FORBIDDEN", "Only whoever hired this job can do that", 403);
}
