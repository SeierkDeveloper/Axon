// Nightly snapshots of the database onto the same volume, with rotation.
//
// The only copy of the data lived in one file. `npm run backup:db` existed but only ran when somebody
// ran it. This takes a snapshot once a day in the quiet hours, from inside the web process (the cron
// containers do not have the volume), and keeps the last few.
//
//   - SQLite's online backup API copies the database a few hundred pages at a time between other
//     work, so requests keep being served while it runs. VACUUM INTO would hold the process for the
//     whole copy.
//   - Snapshots are named like the manual ones (backups/axon-<time>.db) with ".nightly" before the
//     extension, so `npm run restore:db -- latest` finds them and rotation here only ever deletes its
//     own files, never a copy someone made by hand.
//   - It will not fill the volume: if the free space after the copy would be less than the size of
//     the database again, it skips and says so in the health report.
//
// AXON_BACKUPS=off turns it off. AXON_BACKUP_KEEP (default 3) is how many to keep.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getDb, getDbPath } from "./db";
import { logger } from "./logger";

const NIGHTLY_SUFFIX = ".nightly.db";
// a copy in progress, and the journal files SQLite may have made beside it
const PART_RE = /\.part(-wal|-shm|-journal)?$/;
const HOUR_MS = 3_600_000;

export function backupDir(dbPath = getDbPath()): string {
  return process.env.AXON_BACKUP_DIR?.trim() || path.join(path.dirname(dbPath), "backups");
}

function keep(): number {
  const n = Number.parseInt(process.env.AXON_BACKUP_KEEP ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

export function backupsEnabled(dbPath = getDbPath()): boolean {
  if ((process.env.AXON_BACKUPS ?? "").trim().toLowerCase() === "off") return false;
  return dbPath !== ":memory:" && path.isAbsolute(dbPath);
}

export interface Snapshot {
  file: string;
  at: string;
  sizeMb: number;
}

/** The nightly snapshots on disk, newest first. */
export function listSnapshots(dir = backupDir()): Snapshot[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.startsWith("axon-") && f.endsWith(NIGHTLY_SUFFIX));
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .map((file) => {
      const st = fs.statSync(path.join(dir, file));
      return { file, at: st.mtime.toISOString(), sizeMb: Math.round((st.size / 1048576) * 10) / 10 };
    });
}

interface State {
  running: boolean;
  lastError: string | null;
  lastSkip: string | null;
  lastMs: number | null;
}
const state: State = ((globalThis as typeof globalThis & { __axonBackupState?: State }).__axonBackupState ??= {
  running: false,
  lastError: null,
  lastSkip: null,
  lastMs: null,
});

/** Enough room for one more copy, with the same again to spare. */
function hasRoomFor(dir: string, bytes: number): boolean {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize > bytes * 2;
  } catch {
    return true; // cannot tell: the copy itself will fail cleanly if the disk is full
  }
}

function dbBytes(dbPath: string): number {
  let total = 0;
  for (const f of [dbPath, `${dbPath}-wal`]) {
    try {
      total += fs.statSync(f).size;
    } catch { /* no WAL right now */ }
  }
  return total;
}

/**
 * Take one snapshot now and rotate. Returns the snapshot, or null when it was skipped or failed
 * (the reason is kept for the health report). Never throws.
 */
export async function takeSnapshot(opts: { db?: Database.Database; dbPath?: string; now?: Date } = {}): Promise<Snapshot | null> {
  if (state.running) return null;
  state.running = true;
  const started = Date.now();
  const dbPath = opts.dbPath ?? getDbPath();
  const dir = backupDir(dbPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const size = dbBytes(dbPath);
    if (!hasRoomFor(dir, size)) {
      state.lastSkip = `not enough free space for a ${Math.round(size / 1048576)} MB copy`;
      logger.warn("backup.skipped", "Snapshot skipped: not enough free space on the volume", { sizeMb: Math.round(size / 1048576) });
      return null;
    }
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = `axon-${stamp}${NIGHTLY_SUFFIX}`;
    const target = path.join(dir, file);
    const tmp = `${target}.part`;
    const db = opts.db ?? getDb();
    await db.backup(tmp);
    // A snapshot that will not open is worse than none: it would be the one restored. The copy carries
    // the live database's WAL mode, and opening a WAL file (even read-only) leaves -wal and -shm files
    // beside it, so it is switched to a plain rollback journal: one self-contained file.
    const check = new Database(tmp, { fileMustExist: true });
    try {
      check.pragma("journal_mode = DELETE");
      check.prepare("SELECT COUNT(*) FROM sqlite_master").get();
    } finally {
      check.close();
    }
    fs.renameSync(tmp, target);

    const all = listSnapshots(dir);
    for (const old of all.slice(keep())) {
      for (const f of [old.file, `${old.file}-wal`, `${old.file}-shm`]) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch { /* already gone */ }
      }
    }
    state.lastError = null;
    state.lastSkip = null;
    state.lastMs = Date.now() - started;
    const snap = listSnapshots(dir).find((s) => s.file === file) ?? null;
    logger.info("backup.done", "Database snapshot taken", { file, sizeMb: snap?.sizeMb, ms: state.lastMs, kept: Math.min(all.length, keep()) });
    return snap;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    logger.warn("backup.failed", "Database snapshot failed", { err: state.lastError });
    try {
      for (const f of fs.readdirSync(dir)) if (PART_RE.test(f)) fs.unlinkSync(path.join(dir, f));
    } catch { /* nothing to clean */ }
    return null;
  } finally {
    state.running = false;
  }
}

/**
 * Is a snapshot due? Once a day, in the quiet hours (01:00 to 05:00 UTC), or at any hour once the
 * newest is two days old, so a process that keeps restarting in the daytime still gets one.
 */
export function snapshotDue(newest: Snapshot | undefined, now: Date): boolean {
  if (!newest) return true;
  const age = now.getTime() - Date.parse(newest.at);
  if (age >= 48 * HOUR_MS) return true;
  const hour = now.getUTCHours();
  return age >= 20 * HOUR_MS && hour >= 1 && hour < 5;
}

export interface BackupStatus {
  enabled: boolean;
  dir: string;
  keep: number;
  count: number;
  newest: Snapshot | null;
  ageHours: number | null;
  lastError: string | null;
  lastSkip: string | null;
  lastMs: number | null;
}

export function backupStatus(now = new Date()): BackupStatus {
  const dir = backupDir();
  const snaps = backupsEnabled() ? listSnapshots(dir) : [];
  const newest = snaps[0] ?? null;
  return {
    enabled: backupsEnabled(),
    dir,
    keep: keep(),
    count: snaps.length,
    newest,
    ageHours: newest ? Math.round(((now.getTime() - Date.parse(newest.at)) / HOUR_MS) * 10) / 10 : null,
    lastError: state.lastError,
    lastSkip: state.lastSkip,
    lastMs: state.lastMs,
  };
}

/** Check once an hour, the first time ten minutes after boot. Idempotent. */
export function startBackupLoop(): void {
  const g = globalThis as typeof globalThis & { __axonBackupLoop?: boolean };
  if (g.__axonBackupLoop || !backupsEnabled()) return;
  g.__axonBackupLoop = true;
  // A throw inside a timer would take the whole process down, so the tick never throws.
  const tick = () => {
    try {
      const now = new Date();
      if (snapshotDue(listSnapshots()[0], now)) void takeSnapshot({ now });
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
    }
  };
  setTimeout(tick, 10 * 60_000).unref();
  setInterval(tick, HOUR_MS).unref();
}
