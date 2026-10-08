// Nightly database snapshots: the copy opens, rotation keeps only its own newest few, when one is due,
// the off switch, and a failed copy leaves nothing half-written behind.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  takeSnapshot,
  listSnapshots,
  snapshotDue,
  backupsEnabled,
  backupDir,
  backupStatus,
  startBackupLoop,
  type Snapshot,
} from "@/lib/backup";

const HOUR = 3_600_000;

let tmp: string;
let dbPath: string;
let db: Database.Database;
const savedEnv = { ...process.env };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axon-backup-test-"));
  dbPath = path.join(tmp, "axon.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (a INTEGER, b TEXT)");
  const ins = db.prepare("INSERT INTO t (a, b) VALUES (?, ?)");
  for (let i = 0; i < 500; i++) ins.run(i, `row ${i}`);
  delete process.env.AXON_BACKUPS;
  delete process.env.AXON_BACKUP_KEEP;
  delete process.env.AXON_BACKUP_DIR;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function snapAt(iso: string): Snapshot {
  return { file: "axon-x.nightly.db", at: iso, sizeMb: 1 };
}

describe("takeSnapshot", () => {
  it("writes a snapshot next to the database that opens and holds the data", async () => {
    const snap = await takeSnapshot({ db, dbPath, now: new Date("2026-10-08T03:00:00Z") });
    expect(snap?.file).toBe("axon-2026-10-08T03-00-00.nightly.db");
    const dir = backupDir(dbPath);
    expect(dir).toBe(path.join(tmp, "backups"));
    const copy = new Database(path.join(dir, snap!.file), { readonly: true, fileMustExist: true });
    try {
      expect(copy.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 500 });
    } finally {
      copy.close();
    }
    // nothing but the snapshot itself is left in the folder
    expect(fs.readdirSync(dir)).toEqual([snap!.file]);
  });

  it("is named so that restore:db latest picks it", async () => {
    const dir = backupDir(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "axon-2026-10-07T12-00-00.db"), ""); // an older hand-made backup
    await takeSnapshot({ db, dbPath, now: new Date("2026-10-08T03:00:00Z") });
    // the same filter and order scripts/restore-db.ts uses for `latest`
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("axon-") && f.endsWith(".db")).sort();
    expect(files[files.length - 1]).toBe("axon-2026-10-08T03-00-00.nightly.db");
  });

  it("keeps only AXON_BACKUP_KEEP snapshots and never deletes a hand-made backup", async () => {
    process.env.AXON_BACKUP_KEEP = "2";
    const dir = backupDir(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "axon-2026-01-01T00-00-00.db"), "manual");
    for (let d = 1; d <= 4; d++) {
      expect(await takeSnapshot({ db, dbPath, now: new Date(`2026-10-0${d}T03:00:00Z`) })).not.toBeNull();
    }
    expect(listSnapshots(dir).map((s) => s.file)).toEqual([
      "axon-2026-10-04T03-00-00.nightly.db",
      "axon-2026-10-03T03-00-00.nightly.db",
    ]);
    // the hand-made one stays, and no journal files are left beside any snapshot
    expect(fs.readdirSync(dir).sort()).toEqual([
      "axon-2026-01-01T00-00-00.db",
      "axon-2026-10-03T03-00-00.nightly.db",
      "axon-2026-10-04T03-00-00.nightly.db",
    ]);
  });

  it("a copy that fails leaves no .part file and no snapshot, and records why", async () => {
    // a source whose copy produces a file that is not a database, so the check after the copy fails
    const broken = {
      backup: async (dest: string) => {
        fs.writeFileSync(dest, "this is not a database ".repeat(200));
      },
    } as unknown as Database.Database;
    const snap = await takeSnapshot({ db: broken, dbPath, now: new Date("2026-10-08T03:00:00Z") });
    expect(snap).toBeNull();
    const dir = backupDir(dbPath);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".part"))).toEqual([]);
    expect(listSnapshots(dir)).toEqual([]);
    expect(backupStatus().lastError).toBeTruthy();

    // and the next good one goes through and clears the error
    expect(await takeSnapshot({ db, dbPath, now: new Date("2026-10-08T04:00:00Z") })).not.toBeNull();
    expect(backupStatus().lastError).toBeNull();
  });

  it("a copy that throws midway leaves no .part file", async () => {
    const throwing = {
      backup: async (dest: string) => {
        fs.writeFileSync(dest, "partial");
        throw new Error("disk full");
      },
    } as unknown as Database.Database;
    expect(await takeSnapshot({ db: throwing, dbPath, now: new Date("2026-10-08T03:00:00Z") })).toBeNull();
    expect(fs.readdirSync(backupDir(dbPath))).toEqual([]);
    expect(backupStatus().lastError).toBe("disk full");
  });
});

describe("snapshotDue", () => {
  const at3 = new Date("2026-10-08T03:00:00Z");
  const at12 = new Date("2026-10-08T12:00:00Z");

  it("is due when there is none", () => {
    expect(snapshotDue(undefined, at3)).toBe(true);
    expect(snapshotDue(undefined, at12)).toBe(true);
  });

  it("is not due when the newest is fresh", () => {
    expect(snapshotDue(snapAt(new Date(at3.getTime() - HOUR).toISOString()), at3)).toBe(false);
    expect(snapshotDue(snapAt(new Date(at3.getTime() - 19 * HOUR).toISOString()), at3)).toBe(false);
  });

  it("is due at 20 hours old only in the quiet window", () => {
    expect(snapshotDue(snapAt(new Date(at3.getTime() - 20 * HOUR).toISOString()), at3)).toBe(true);
    expect(snapshotDue(snapAt(new Date(at12.getTime() - 20 * HOUR).toISOString()), at12)).toBe(false);
    const at5 = new Date("2026-10-08T05:00:00Z");
    expect(snapshotDue(snapAt(new Date(at5.getTime() - 30 * HOUR).toISOString()), at5)).toBe(false);
  });

  it("is due at any hour once the newest is 48 hours old", () => {
    expect(snapshotDue(snapAt(new Date(at12.getTime() - 48 * HOUR).toISOString()), at12)).toBe(true);
    expect(snapshotDue(snapAt(new Date(at12.getTime() - 47 * HOUR).toISOString()), at12)).toBe(false);
  });
});

describe("the switch", () => {
  it("is on for an absolute path, off for memory, a relative path, or AXON_BACKUPS=off", () => {
    expect(backupsEnabled(dbPath)).toBe(true);
    expect(backupsEnabled(":memory:")).toBe(false);
    expect(backupsEnabled("axon.db")).toBe(false);
    process.env.AXON_BACKUPS = "off";
    expect(backupsEnabled(dbPath)).toBe(false);
    process.env.AXON_BACKUPS = " OFF ";
    expect(backupsEnabled(dbPath)).toBe(false);
  });

  it("the loop does not start under tests (in-memory database)", () => {
    startBackupLoop();
    expect((globalThis as { __axonBackupLoop?: boolean }).__axonBackupLoop).toBeUndefined();
    expect(backupStatus().enabled).toBe(false);
  });
});
