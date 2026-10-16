// What the app routes share: turning an AppError into an answer, and the address an app sends the owner back to.

import type { NextRequest } from "next/server";
import { apiError } from "./apiError";
import { publicOrigin } from "./publicUrl";
import { AppError } from "./appConnect";

/** The callback an app is registered with: one per app, on this deployment's public address. */
export const redirectUriFor = (req: NextRequest, appId: string): string => `${publicOrigin(req)}/api/apps/${encodeURIComponent(appId)}/callback`;

export function appRefusal(err: unknown) {
  if (err instanceof AppError) {
    const code = err.status === 404 ? "NOT_FOUND" : err.status === 403 ? "FORBIDDEN" : err.status === 409 ? "CONFLICT" : err.status === 429 ? "RATE_LIMITED" : err.status >= 500 ? "UPSTREAM_ERROR" : "VALIDATION_ERROR";
    return apiError(code, err.message, err.status);
  }
  throw err;
}

export const noStore = { "Cache-Control": "no-store" } as const;
