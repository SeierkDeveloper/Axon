import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { getBearerToken } from "@/lib/identity";
import { checkRateLimit, getClientIp, refundRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { normalizeAddress } from "@/lib/address";
import { agentReads, DAILY, filesEnabled, guestBytesAllowed, guestBytesRefund, IMAGE_MAX_BYTES, maxFileBytes, readCapped, storeFile, TASK_FILES } from "@/lib/agentFiles";
import { getAgentById } from "@/lib/agents";
import { getMcpServerByAgentId } from "@/lib/mcp";

export const runtime = "nodejs";

const UPLOADS_PER_MINUTE = 10;
const DAY_MS = 86_400_000;
// a multipart body carries a little more than the file itself
const FORM_OVERHEAD = 64 * 1024;

const headerName = (req: NextRequest): string | null => {
  const raw = req.headers.get("x-file-name") ?? req.nextUrl.searchParams.get("name");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

// GET /api/files: what can be handed to an agent here, and how much. With ?agent=<id>, also which kinds of file that
// agent reads. It answers 404 while files are switched off, which is how a page knows not to offer them.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!filesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const agentId = req.nextUrl.searchParams.get("agent");
    const agent = agentId ? getAgentById(agentId) : null;
    if (agentId && !agent) return apiError("NOT_FOUND", `Agent '${agentId.slice(0, 80)}' not found`, 404);
    return NextResponse.json(
      {
        maxBytes: maxFileBytes(),
        imageMaxBytes: IMAGE_MAX_BYTES,
        types: ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "text/markdown", "text/csv", "application/json"],
        perHire: TASK_FILES,
        ...(agent ? { reads: agentReads(agent, { runsThroughMcp: Boolean(getMcpServerByAgentId(agent.agentId)) }) } : {}),
      },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  });
}

// POST /api/files: hand over one file an agent will work on. The body is the file itself (with its name in
// X-File-Name), or a multipart form with one "file" field, which is what a browser sends. Anyone may upload within a
// visitor's daily allowance; send a key and the file belongs to your wallet. The answer carries the file's id and its
// token: the token is the only way a visitor reads the file again, so keep it.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!filesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    let wallet: string | null = null;
    if (getBearerToken(req)) {
      const auth = requireApiKey(req);
      if (!auth.ok) return auth.response;
      wallet = normalizeAddress(auth.user.walletAddress);
    }
    const who = wallet ? `w:${wallet}` : `ip:${getClientIp(req)}`;
    const minute = checkRateLimit(`files-up:${who}`, UPLOADS_PER_MINUTE, 60_000);
    if (!minute.allowed) return tooManyRequests(minute);

    const max = maxFileBytes();
    const form = (req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
    const declared = Number(req.headers.get("content-length"));
    const tooBig = () => apiError("VALIDATION_ERROR", `A file is at most ${Math.round(max / 1048576)} MB.`, 413, { refused: "too_large" });
    if (Number.isFinite(declared) && declared > max + (form ? FORM_OVERHEAD : 0)) return tooBig();

    let bytes: Buffer, name: string | null;
    if (form) {
      // a form is read whole, so it must say how long it is and that must be within the limit
      if (!Number.isFinite(declared) || declared <= 0) return apiError("VALIDATION_ERROR", "Send the upload with its Content-Length.", 411);
      let file: FormDataEntryValue | null;
      try {
        file = (await req.formData()).get("file");
      } catch {
        return apiError("VALIDATION_ERROR", "The upload could not be read as a form.", 400);
      }
      if (!file || typeof file === "string") return apiError("VALIDATION_ERROR", 'Send the file in a form field named "file".', 400);
      if (file.size > max) return tooBig();
      bytes = Buffer.from(await file.arrayBuffer());
      name = file.name || headerName(req);
    } else {
      const read = await readCapped(req.body, max);
      if (!read) return tooBig();
      bytes = read;
      name = headerName(req);
    }

    // a visitor's day: so many files and so many megabytes from one address
    const dayKey = `files-day:${who}`, bytesKey = `files-bytes:${who}`;
    if (!wallet) {
      const day = checkRateLimit(dayKey, DAILY.guest.files, DAY_MS);
      const refuse = () => apiError("RATE_LIMITED", `That is past what a visitor can upload in a day (${DAILY.guest.files} files, ${DAILY.guest.bytes / 1048576} MB). Sign in with a wallet for more.`, 429, { refused: "quota" });
      if (!day.allowed) return refuse();
      if (!guestBytesAllowed(bytesKey, bytes.length)) {
        refundRateLimit(dayKey);
        return refuse();
      }
    }

    const r = storeFile({ bytes, name, wallet });
    if (!r.ok) {
      // what was not stored does not count against anybody's day
      if (!wallet) {
        refundRateLimit(dayKey);
        guestBytesRefund(bytesKey, bytes.length);
      }
      const code = r.status === 429 ? "RATE_LIMITED" : r.status === 415 ? "NOT_SUPPORTED" : r.status === 507 ? "INTERNAL_ERROR" : "VALIDATION_ERROR";
      return apiError(code, r.reason, r.status, { refused: r.refused });
    }
    return NextResponse.json({ file: r.file, fileToken: r.token }, { status: 201, headers: { "Cache-Control": "no-store" } });
  });
}
