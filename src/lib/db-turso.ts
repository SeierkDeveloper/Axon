// Turso embedded-replica adapter.
//
// How it works:
//   1. At app startup (instrumentation.ts), initTursoSync() pulls the remote
//      Turso database into a local SQLite replica file at DATABASE_PATH.
//   2. getDb() opens better-sqlite3 on that local file — all existing callers
//      work unchanged (sync reads/writes, zero refactor).
//   3. After the app has written data, call syncToTurso() to push local changes
//      back to the remote. The Turso client also syncs on its own interval.
//
// Environment variables:
//   DATABASE_URL=libsql://your-db.turso.io   ← remote Turso endpoint
//   DATABASE_AUTH_TOKEN=your-token            ← auth token from Turso dashboard
//   DATABASE_PATH=/data/axon.db              ← local replica file path
//
// Without DATABASE_URL the Turso path is skipped; the app uses SQLite directly.

import { createClient, type Client } from "@libsql/client";
import path from "path";

const SYNC_INTERVAL_SECONDS = 60;

let _tursoClient: Client | null = null;

function getReplicaPath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (configured) return configured;
  return path.join(process.cwd(), "axon.db");
}

export function isTursoConfigured(): boolean {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  return url.startsWith("libsql://") || url.startsWith("libsqls://");
}

// Call once at startup. Pulls the remote Turso DB into the local replica file.
export async function initTursoSync(): Promise<void> {
  if (!isTursoConfigured()) return;
  if (_tursoClient) return; // already initialised (guard against hot-reload double-calls)

  const syncUrl = process.env.DATABASE_URL!.trim();
  const authToken = process.env.DATABASE_AUTH_TOKEN?.trim();

  if (!authToken) {
    throw new Error(
      "DATABASE_AUTH_TOKEN is required when DATABASE_URL is a Turso libsql endpoint"
    );
  }

  const replicaPath = getReplicaPath();

  _tursoClient = createClient({
    url: `file:${replicaPath}`,
    syncUrl,
    authToken,
    syncInterval: SYNC_INTERVAL_SECONDS,
  });

  // Pull latest state from Turso into the local replica before the app starts serving
  await _tursoClient.sync();
}

// Last sync outcome, so the status page can surface replica-sync health (a
// failing sync is invisible to a plain local-replica read).
let _lastSyncAt: number | null = null;
let _lastSyncError: string | null = null;

// One sync at a time. Callers fire this after every write burst and the worker every poll, so without a
// guard the calls stacked up against the remote. A call made while a sync is running is folded into a
// single follow-up sync that starts when the current one ends: nothing written is left unsynced, and at
// most two syncs are ever outstanding.
let _inFlight: Promise<void> | null = null;
let _again: Promise<void> | null = null;

// Push local writes to Turso. Safe to call fire-and-forget; errors are logged but not thrown.
export function syncToTurso(): Promise<void> {
  if (!_tursoClient) return Promise.resolve();
  if (!_inFlight) {
    _inFlight = runSync().finally(() => {
      _inFlight = null;
    });
    return _inFlight;
  }
  // a sync is running and may have started before this caller's writes: queue exactly one more
  if (!_again) {
    _again = _inFlight.then(() => {
      _again = null;
      return syncToTurso();
    });
  }
  return _again;
}

async function runSync(): Promise<void> {
  if (!_tursoClient) return;
  try {
    await _tursoClient.sync();
    _lastSyncAt = Date.now();
    _lastSyncError = null;
  } catch (err) {
    // Non-fatal: local replica still has the data; will sync on next interval
    _lastSyncError = err instanceof Error ? err.message : String(err);
    console.warn("[turso] Background sync failed:", _lastSyncError);
  }
}

export interface SyncHealth {
  configured: boolean;
  lastSyncAgeSeconds: number | null;
  lastError: string | null;
}

// Replica-sync health for the status page. `lastError` is the most recent
// syncToTurso() failure (cleared on the next success), so a stalled/failing sync
// is detectable even while the local replica still reads fine.
export function getSyncHealth(): SyncHealth {
  if (!isTursoConfigured()) return { configured: false, lastSyncAgeSeconds: null, lastError: null };
  return {
    configured: true,
    lastSyncAgeSeconds: _lastSyncAt === null ? null : Math.floor((Date.now() - _lastSyncAt) / 1000),
    lastError: _lastSyncError,
  };
}

/** Test hook: stand in a client (only its sync() is used by syncToTurso). */
export function __setTursoClientForTest(client: Pick<Client, "sync"> | null): void {
  _tursoClient = client as Client | null;
}

// Close the Turso client and stop its auto-sync interval.
// Must be called on shutdown AFTER the final syncToTurso() so the interval
// cannot fire against an already-closed better-sqlite3 file, and so the
// event loop can drain and the process can exit cleanly.
export function closeTursoClient(): void {
  if (!_tursoClient) return;
  try { _tursoClient.close(); } catch { /* already closed */ }
  _tursoClient = null;
}

