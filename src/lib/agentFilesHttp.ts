// The one question every route under /api/files/{fileId} asks first: which file is this, and may this caller read it.

import { type NextRequest, type NextResponse } from "next/server";
import { apiError } from "./apiError";
import { requireApiKey } from "./apiAuth";
import { getBearerToken } from "./identity";
import { checkRateLimit, getClientIp, tooManyRequests } from "./rateLimit";
import { normalizeAddress } from "./address";
import { filesEnabled, getFile, mayRead, type FileRow } from "./agentFiles";

const READS_PER_MINUTE = 120;

/**
 * The file a request asks for, if the caller may read it. Shared by every route under /api/files/{fileId}. A file the
 * caller may not read answers exactly as one that does not exist, so an id tells a stranger nothing.
 */
export async function fileFor(req: NextRequest, fileId: string): Promise<{ file: FileRow } | { response: NextResponse }> {
  if (!filesEnabled()) return { response: apiError("NOT_FOUND", "Not found", 404) };
  const rl = checkRateLimit(`files-read:${getClientIp(req)}`, READS_PER_MINUTE, 60_000);
  if (!rl.allowed) return { response: tooManyRequests(rl) };
  let wallet: string | null = null;
  if (getBearerToken(req)) {
    const auth = requireApiKey(req);
    if (!auth.ok) return { response: auth.response };
    wallet = normalizeAddress(auth.user.walletAddress);
  }
  const token = req.headers.get("x-file-token") ?? req.nextUrl.searchParams.get("token");
  const file = getFile(fileId);
  if (!file || !mayRead(file, { wallet, token })) return { response: apiError("NOT_FOUND", "No file with that id", 404) };
  return { file };
}
