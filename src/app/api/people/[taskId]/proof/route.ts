import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { sameAddress } from "@/lib/address";
import { getFile, readBytes } from "@/lib/agentFiles";
import { deliveriesOf, getPeopleTask } from "@/lib/people";
import { callerOf, signInFirst, walletOf } from "@/lib/peopleHttp";

export const runtime = "nodejs";

// GET /api/people/:taskId/proof?delivery=<id>: the file a person handed in. Only for the task's owner, the person who
// handed it in, and a moderator. Always a download, never a page, under a sandbox policy, as every file on Axon is.
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    const c = callerOf(req);
    if ("response" in c) return c.response;
    const rl = checkRateLimit(`people-proof:${getClientIp(req)}`, 120, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const wallet = walletOf(c.caller);
    if (c.caller.kind !== "moderator" && !wallet) return signInFirst();
    const t = getPeopleTask((await params).taskId);
    const id = req.nextUrl.searchParams.get("delivery") ?? "";
    const d = t ? deliveriesOf(t.taskId).find((x) => x.deliveryId === id) : undefined;
    const allowed = Boolean(t && d && (c.caller.kind === "moderator" || sameAddress(wallet, t.ownerWallet) || sameAddress(wallet, d.wallet)));
    if (!t || !d || !allowed || !d.fileId) return apiError("NOT_FOUND", "There is no such proof.", 404);
    const f = getFile(d.fileId);
    const bytes = f ? readBytes(f) : null;
    if (!f || !bytes) return apiError("NOT_FOUND", "This proof is no longer stored.", 404);
    const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    // a picture may be shown inline on the owner's own page; anything else is a download
    const inline = f.kind === "image" && req.nextUrl.searchParams.get("view") === "1";
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": f.mime,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
