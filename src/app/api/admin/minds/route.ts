import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { overview, setHalted, stopMind, resumeMind } from "@/lib/mindsAdmin";
import { normalizeAddress } from "@/lib/address";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// /api/admin/minds: the admin's switches for minds. Gated on the same secret the crons use, like the other admin
// routes. GET: what every mind has cost Axon's keys and paid back, and what is stopped. POST { action, token?, reason? }:
//   halt / resume   every mind at once
//   stop / start    one mind
// Neither switch can move anything: a treasury's ETH stays in its contract whatever is switched here.
function allowed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(overview(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { action?: string; token?: string; reason?: string } | null;
  const action = body?.action;
  if (action === "halt" || action === "resume") {
    setHalted(action === "halt");
    logger.warn("minds.admin", action === "halt" ? "Every mind was stopped by the admin" : "Minds were let go on by the admin", {});
    return NextResponse.json({ ok: true, halted: action === "halt" });
  }
  if (action === "stop" || action === "start") {
    const token = normalizeAddress(body?.token ?? "");
    if (!token) return NextResponse.json({ error: "That is not a token address" }, { status: 400 });
    const done = action === "stop" ? stopMind(token, body?.reason ?? null) : resumeMind(token);
    if (!done) return NextResponse.json({ error: "No token with a mind at that address" }, { status: 404 });
    logger.warn("minds.admin", action === "stop" ? "A mind was stopped by the admin" : "A mind was let go on by the admin", { token });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
