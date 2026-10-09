import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { filesEnabled, maxFileBytes, readCapped, storeFile, getFile, type FileRow } from "@/lib/agentFiles";
import { fireTrigger, getTrigger, secretValid, triggersEnabled, MAX_EVENT_CHARS } from "@/lib/triggers";

export const runtime = "nodejs";

const TEXT_BYTES = 64 * 1024;
const MAX_FILES = 5;

// POST /api/triggers/:id/fire: something happened, start the job.
//
// The caller proves it may with the trigger's secret, in the X-Trigger-Key header (or ?key= for a sender that cannot
// set a header). What it sends is the event: JSON or plain text is handed to the agent as what happened; anything
// else (a PDF, a picture, a spreadsheet) is a file for the agent to work on, as is every "file" part of a form.
//
// It always answers 2xx once the secret is right, saying whether a run started and if not why. A sender that retries
// on an error would otherwise fill the list with the same refusal.
export async function POST(req: NextRequest, { params }: { params: Promise<{ triggerId: string }> }) {
  return withRequestContext(req, async () => {
    if (!triggersEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const { triggerId } = await params;
    const ip = getClientIp(req);
    const secret = req.headers.get("x-trigger-key") ?? req.nextUrl.searchParams.get("key");
    if (!secretValid(triggerId, secret)) {
      // a wrong secret and a trigger that does not exist answer alike, and guessing is slow
      const tries = checkRateLimit(`trigger-miss:${ip}`, 20, 60_000);
      if (!tries.allowed) return tooManyRequests(tries);
      return apiError("NOT_FOUND", "No trigger here for that key", 404);
    }
    const rl = checkRateLimit(`trigger-fire:${triggerId}`, 30, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const trigger = getTrigger(triggerId)!;

    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const files: FileRow[] = [];
    let text = "";
    const keep = (bytes: Buffer, name: string): NextResponse | null => {
      if (!filesEnabled()) return apiError("VALIDATION_ERROR", "Files are not switched on here. Send JSON or text.", 415);
      if (files.length >= MAX_FILES) return apiError("VALIDATION_ERROR", `At most ${MAX_FILES} files in one call.`, 413);
      const kept = storeFile({ bytes, name, wallet: trigger.ownerWallet });
      if (!kept.ok) return apiError(kept.status === 429 ? "RATE_LIMITED" : "VALIDATION_ERROR", kept.reason, kept.status);
      const row = getFile(kept.file.id);
      if (row) files.push(row);
      return null;
    };

    if (type === "multipart/form-data") {
      const declared = Number(req.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxFileBytes() * MAX_FILES + TEXT_BYTES) return apiError("VALIDATION_ERROR", "That is too much to send in one call.", 413);
      const form = await req.formData().catch(() => null);
      if (!form) return apiError("VALIDATION_ERROR", "The form could not be read.", 400);
      for (const [name, value] of form.entries()) {
        if (typeof value === "string") {
          if (name === "text" || name === "note" || name === "event") text += `${text ? "\n" : ""}${value}`;
          continue;
        }
        if (value.size > maxFileBytes()) return apiError("VALIDATION_ERROR", `${value.name || "A file"} is too large.`, 413);
        const refused = keep(Buffer.from(await value.arrayBuffer()), value.name || "file");
        if (refused) return refused;
      }
    } else if (type === "application/json" || type === "text/plain" || type === "" || type === "application/x-www-form-urlencoded") {
      const bytes = await readCapped(req.body, TEXT_BYTES);
      if (!bytes) return apiError("VALIDATION_ERROR", "That is too much text for one call: at most 64 KB. Send a larger thing as a file.", 413);
      text = bytes.toString("utf8");
      if (type === "application/json" && text.trim()) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          return apiError("INVALID_JSON", "The body says it is JSON and is not.", 400);
        }
      }
    } else {
      const bytes = await readCapped(req.body, maxFileBytes());
      if (!bytes) return apiError("VALIDATION_ERROR", "That file is too large.", 413);
      const refused = keep(bytes, req.headers.get("x-file-name") ?? "file");
      if (refused) return refused;
    }

    const idem = (req.headers.get("idempotency-key") ?? "").trim().slice(0, 120);
    const names = files.map((f) => f.name).join(", ");
    const summary = files.length ? `${files.length === 1 ? "A file" : `${files.length} files`} arrived: ${names}` : text.trim() ? `Called: ${text.replace(/\s+/g, " ").trim().slice(0, 120)}` : "Called";
    const result = await fireTrigger(triggerId, {
      key: idem ? `in:${idem}` : `in:${randomUUID()}`,
      summary,
      text: `${files.length ? `${files.length === 1 ? "A file" : "Files"} arrived for you to work on: ${names}.\n` : ""}${text.trim().slice(0, MAX_EVENT_CHARS)}`,
      files,
    });
    if (result.fired) return NextResponse.json({ fired: true, runId: result.runId, taskId: result.taskId, receiptUrl: `/r/${result.taskId}` }, { status: 202 });
    return NextResponse.json({ fired: false, runId: result.runId, reason: result.reason, message: result.message }, { status: 200 });
  });
}
