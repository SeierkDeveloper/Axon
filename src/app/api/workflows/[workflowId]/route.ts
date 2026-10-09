import { NextRequest, NextResponse } from "next/server";
import { getWorkflow } from "@/lib/workflows";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { filesEnabled, filesOfTask, outputFileFor, CONTEXT_KEY } from "@/lib/agentFiles";
import { getTaskById } from "@/lib/tasks";

// GET /api/workflows/[workflowId]
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ workflowId: string }> }
) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const { workflowId } = await params;
  const workflow = getWorkflow(workflowId);

  if (!workflow) {
    return apiError("NOT_FOUND", `Workflow '${workflowId}' not found`, 404);
  }
  const identities = [workflow.fromAgent, ...workflow.agents];
  if (!identities.some((identity) => canAccessIdentity(auth.user, identity))) {
    return apiError("FORBIDDEN", "API key does not have access to this workflow", 403);
  }

  // Files between agents: what each step was handed and what it made. Whoever may read a pipeline already reads
  // every step's answer; the files are part of the same work, each with the token that downloads it.
  if (!filesEnabled()) return NextResponse.json(workflow);
  return NextResponse.json({
    ...workflow,
    steps: workflow.steps.map((step) => {
      const listed = getTaskById(step.taskId)?.context?.[CONTEXT_KEY];
      const handed = Array.isArray(listed) ? (listed as { name: string; type: string; size: number }[]).map((f) => ({ name: f.name, type: f.type, size: f.size })) : [];
      const made = filesOfTask(step.taskId, "out").map((f) => outputFileFor(f));
      return { ...step, ...(handed.length ? { handedFiles: handed } : {}), ...(made.length ? { outputFiles: made } : {}) };
    }),
  });
}
