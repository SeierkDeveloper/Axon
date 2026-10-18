import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { sameAddress } from "@/lib/address";
import { logger } from "@/lib/logger";
import { maxFileBytes, storeFile } from "@/lib/agentFiles";
import { deliverPeopleTask, getPeopleTask, takerView } from "@/lib/people";
import { checkProof, realProofJudge } from "@/lib/peopleCheck";
import { payNow } from "@/lib/peoplePay";
import { callerOf, noStore, signInFirst, walletOf } from "@/lib/peopleHttp";

export const runtime = "nodejs";

const FORM_OVERHEAD = 64 * 1024;

// POST /api/people/:taskId/deliver: the person hands in proof. A form with "file" (a photo, a PDF or a text file) and/or
// "answer", or JSON { answer }. The file is kept private to the person and the task's owner. The agent's check runs at
// once; the answer arrives on the task (GET /api/people/:taskId) within a few seconds.
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    const c = callerOf(req);
    if ("response" in c) return c.response;
    const wallet = walletOf(c.caller);
    if (!wallet) return signInFirst();
    const { taskId } = await params;
    const rl = checkRateLimit(`people-deliver:${wallet}`, 10, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const t = getPeopleTask(taskId);
    if (!t || !sameAddress(t.takerWallet, wallet)) return apiError("NOT_FOUND", "You do not have this task.", 404);

    let answer: string | null = null;
    let file: { id: string; sha256: string; mime: string; kind: string } | null = null;
    const type = (req.headers.get("content-type") ?? "").toLowerCase();
    if (type.startsWith("multipart/form-data")) {
      const max = maxFileBytes();
      const declared = Number(req.headers.get("content-length"));
      if (!Number.isFinite(declared) || declared <= 0) return apiError("VALIDATION_ERROR", "Send the upload with its Content-Length.", 411);
      if (declared > max + FORM_OVERHEAD) return apiError("VALIDATION_ERROR", `A file is at most ${Math.round(max / 1048576)} MB.`, 413);
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return apiError("VALIDATION_ERROR", "The upload could not be read as a form.", 400);
      }
      const a = form.get("answer");
      answer = typeof a === "string" ? a : null;
      const f = form.get("file");
      if (f && typeof f !== "string" && f.size > 0) {
        const stored = storeFile({ bytes: Buffer.from(await f.arrayBuffer()), name: f.name, wallet, direction: "in", taskId });
        if (!stored.ok) return apiError(stored.status === 415 ? "NOT_SUPPORTED" : stored.status === 429 ? "RATE_LIMITED" : "VALIDATION_ERROR", stored.reason, stored.status);
        file = { id: stored.file.id, sha256: stored.file.sha256, mime: stored.file.type, kind: stored.file.kind };
      }
    } else {
      const body = (await req.json().catch(() => null)) as { answer?: unknown } | null;
      if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Send a form with the file, or JSON with your answer.", 400);
      answer = typeof body.answer === "string" ? body.answer : null;
    }

    const r = deliverPeopleTask(taskId, wallet, { answer, file });
    if (!r.ok) return apiError("CONFLICT", r.why, 409);
    // the agent's check, without holding the person up; an accept pays at once
    void checkProof(taskId, realProofJudge())
      .then((v) => (v === "accept" ? payNow(taskId) : undefined))
      .catch((err) => logger.warn("people.check_failed", "Checking a proof right after it was handed in failed; the worker tries again", { taskId, err }));
    return NextResponse.json({ task: takerView(r.task, wallet) }, { status: 201, headers: noStore });
  });
}
