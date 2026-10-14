import { filesEnabled, filesOfTask, outputFileFor } from "@/lib/agentFiles";
import { sitesEnabled, siteViewOf } from "@/lib/agentSites";
import { publicOrigin } from "@/lib/publicUrl";
import { liveLogEnabled, stepsOf } from "@/lib/liveLog";
import { pagesOf } from "@/lib/taskPages";
import { sentOf } from "@/lib/taskSent";
import { followUpView } from "@/lib/followUp";
import { questionsView } from "@/lib/ask";
import { planView } from "@/lib/planFirst";
import { steerView } from "@/lib/steer";
import { memoryEnabled, rememberedBy } from "@/lib/agentMemory";
import type { Task } from "@/lib/tasks";
import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { claimTokenValid } from "@/lib/mcpServer";
import { rescueView } from "@/lib/autonomy3Rescue";
import { apiError } from "@/lib/apiError";
import { getDb } from "@/lib/db";

function paidByKey(taskId: string, keyId: string): boolean {
  return Boolean(
    getDb().prepare("SELECT 1 FROM allowance_reservations WHERE task_id = ? AND api_key_id = ?").get(taskId, keyId),
  );
}

/**
 * The task as its reader gets it. While files are on, it also lists what the agent handed back, each with the token
 * that downloads it: whoever may read a job's output may read the files that are part of it.
 */
function withFiles<T extends Task>(task: T, origin = ""): T | (T & { site?: unknown; outputFiles?: unknown[]; steps?: unknown[]; pages?: unknown[]; sent?: unknown[]; followUp?: unknown; question?: unknown; questions?: unknown[]; plan?: unknown; plans?: unknown[]; steer?: unknown; notes?: unknown[]; remembered?: unknown[] }) {
  // Watch it work: the steps so far, for whoever may read the job. Read on every poll while it runs.
  const steps = liveLogEnabled() ? stepsOf(task.taskId) : [];
  // Where its browser went, for a job that used one: shown with the answer as the pages it came from.
  const pages = pagesOf(task.taskId);
  // And what it sent there, field by field: a form sent in the person's name is theirs to see.
  const sent = sentOf(task.taskId);
  // Work with your agent: which turn of its conversation this is, and whether it can be followed up.
  const follow = followUpView(task);
  // The agent asks: the question the job is waiting on, and every question it has asked with what came back.
  // It remembers you: what the agent noted during this job for the next one.
  const noted = memoryEnabled() ? rememberedBy(task.taskId).map((m) => ({ id: m.id, text: m.text })) : [];
  // Agents that build: what the job built, with the address it opens at.
  const built = sitesEnabled() ? siteViewOf(task.taskId, origin) : null;
  const seen = { ...task, ...rescueView(task), ...(noted.length ? { remembered: noted } : {}), ...(steps.length ? { steps } : {}), ...(pages.length ? { pages } : {}), ...(sent.length ? { sent } : {}), ...(follow ? { followUp: follow } : {}), ...questionsView(task), ...planView(task), ...steerView(task), ...(built ? { site: built } : {}) };
  if (!filesEnabled()) return seen;
  const out = filesOfTask(task.taskId, "out");
  if (!out.length) return seen;
  return { ...seen, outputFiles: out.map((f) => outputFileFor(f)) };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;

  // A claimToken (issued to an anonymous hire) is the read permission for THIS
  // task's output — checked first so a browser hire can poll without an API key.
  // Sent as a header, never the URL query, so it never lands in access logs or
  // browser history. (The legacy query form is still accepted for compatibility.)
  const claimToken = req.headers.get("x-claim-token") ?? req.nextUrl.searchParams.get("claimToken");
  if (claimToken) {
    const task = getTaskById(taskId);
    if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
    if (!claimTokenValid(taskId, claimToken)) {
      return apiError("FORBIDDEN", "Invalid claim token for this task", 403);
    }
    return NextResponse.json(withFiles(task, publicOrigin(req)));
  }

  // Otherwise fall back to API-key auth (owner of the from/to agent).
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  const task = getTaskById(taskId);
  if (!task) {
    return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
  }
  // An allowance key reads what it hired and nothing else of its owner's, so a leaked assistant key
  // exposes that assistant's own work rather than everything the wallet has ever done.
  if (auth.user.scope === "allowance") {
    if (!paidByKey(taskId, auth.user.keyId)) {
      return apiError("FORBIDDEN", "This allowance key did not hire this task", 403);
    }
    return NextResponse.json(withFiles(task, publicOrigin(req)));
  }
  if (!canAccessIdentity(auth.user, task.fromAgent) && !canAccessIdentity(auth.user, task.toAgent)) {
    return apiError("FORBIDDEN", "API key does not have access to this task", 403);
  }
  return NextResponse.json(withFiles(task, publicOrigin(req)));
}
