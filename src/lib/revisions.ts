// Work with your agent: revisions.
//
// "Make the bars blue." "Shorten the second paragraph." When somebody asks for a change, the agent changes the file
// and hands it back under the name it had. That file is the next version of the one it changed. Nothing is
// overwritten: the earlier version stays a file of the job that made it, with its own hash on that job's receipt.
// A version says which content it replaces and where the first version came from, so the whole line can be walked
// back to the first receipt.
//
// A file is a revision when a job hands back, under the same name, different content from a file the job was given.
// The same name with a tail an agent likes to add ("-v2", "_final", " (1)") still counts. The same content is not a
// revision: nothing changed.

import { getDb } from "./db";
import { fileTokenFor, filesOfTask, lineOf, versionInfo, type FileKind, type FileRow, type VersionInfo } from "./agentFiles";
import { followUpEnabled } from "./followUp";

/** What the agent is told when it holds files it can change. */
export const REVISE_NOTE = "\n\nIf the person asks for a change to a file, change that file and save it in the output directory under the same name. It is kept as a new version, and the earlier one stays.";

const TAIL = /[-_ .]+(?:v\d+|rev\d+|\(\d+\)|final|new|updated|revised|edited|edit|fixed|copy)$/i;

/** A file's name without its extension and without a version-like tail, lowercased: "Chart_v2.PNG" gives "chart". */
export function stemOf(name: string): string {
  let stem = name.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  for (let i = 0; i < 4 && TAIL.test(stem); i++) stem = stem.replace(TAIL, "");
  return stem.toLowerCase();
}

const extOf = (name: string): string => (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toLowerCase();

/** Two names for the same document: the same kind of file, and the same name once any version tail is dropped. */
export const sameDocument = (a: string, b: string): boolean => extOf(a) === extOf(b) && stemOf(a).length > 0 && stemOf(a) === stemOf(b);

/** The file of this job's input that a handed-back file is a new version of, or null when it is a file of its own. */
export function revisedFrom(taskId: string, made: Pick<FileRow, "name" | "sha256" | "kind">): FileRow | null {
  const given = filesOfTask(taskId, "in").filter((g) => g.kind === made.kind && sameDocument(g.name, made.name));
  if (!given.length || given.some((g) => g.sha256 === made.sha256)) return null; // nothing like it, or nothing changed
  return given.reduce((best, g) => ((g.version ?? 1) > (best.version ?? 1) ? g : best));
}

/**
 * A job has just handed back a file: if it is a new version of one the job was given, write that down. Returns what
 * was written, or null for a file that revises nothing. Does nothing while follow-ups are off.
 */
export function markRevision(taskId: string, fileId: string, env: Record<string, string | undefined> = process.env): VersionInfo | null {
  if (!followUpEnabled(env)) return null;
  const db = getDb();
  const made = db.prepare("SELECT * FROM task_files WHERE id = ? AND task_id = ? AND direction = 'out'").get(fileId, taskId) as FileRow | undefined;
  if (!made || made.version) return null;
  const from = revisedFrom(taskId, made);
  if (!from) return null;
  const info: VersionInfo = {
    version: (from.version ?? 1) + 1,
    revises: from.sha256,
    first: {
      sha256: from.first_sha256 ?? from.sha256,
      // the job that made the first version: carried on from version to version, else the job that made the file
      // this one changes. A file a person uploaded was made by no job.
      taskId: from.first_sha256 ? (from.first_task_id ?? null) : (from.source_task_id ?? null),
    },
  };
  db.prepare("UPDATE task_files SET version = ?, revises_sha256 = ?, first_sha256 = ?, first_task_id = ? WHERE id = ?").run(info.version, info.revises, info.first.sha256, info.first.taskId, fileId);
  return info;
}

/** One version of a file, as its reader gets it. */
export interface FileVersion {
  version: number; id: string; name: string; type: string; kind: FileKind; size: number; sha256: string;
  /** the job that made this version; null for a file a person uploaded, which no job made (`uploaded` is then true) */
  taskId: string | null; uploaded?: boolean; createdAt: string; token: string; path: string; current: boolean; revises?: string;
}

/**
 * Every version of a file that is still stored, oldest first: the versions made in the same conversation as the
 * file's own job. Whoever may read one version may read the others, since one person hired every job of it. A file
 * with no conversation or no revisions is the only version of itself.
 */
export function versionsOf(file: FileRow): FileVersion[] {
  const db = getDb();
  const view = (r: FileRow): FileVersion => ({
    version: r.version ?? 1, id: r.id, name: r.name, type: r.mime, kind: r.kind, size: r.size, sha256: r.sha256,
    taskId: r.direction === "out" ? r.task_id : (r.source_task_id ?? null),
    ...(r.direction === "in" && !r.source_task_id ? { uploaded: true } : {}),
    createdAt: r.created_at, token: fileTokenFor(r.id), path: `/api/files/${r.id}/content`, current: r.id === file.id,
    ...(versionInfo(r).revises ? { revises: r.revises_sha256! } : {}),
  });
  if (!file.task_id) return [view(file)];
  const job = db.prepare("SELECT task_id, thread_id FROM tasks WHERE task_id = ?").get(file.task_id) as { task_id: string; thread_id: string | null } | undefined;
  if (!job) return [view(file)];
  const thread = job.thread_id ?? job.task_id, line = lineOf(file);
  const rows = db.prepare(
    `SELECT f.* FROM task_files f JOIN tasks t ON t.task_id = f.task_id
     WHERE (t.task_id = ? OR t.thread_id = ?) AND f.deleted_at IS NULL AND (f.first_sha256 = ? OR f.sha256 = ?)
     ORDER BY COALESCE(f.version, 1) ASC, (f.direction = 'out') DESC, f.created_at ASC, f.id ASC`,
  ).all(thread, thread, line, line) as FileRow[];
  // one row a version: the file as its own job handed it back, not the copies later jobs were given. The file asked
  // about stands for its own version.
  const seen = new Map<string, FileRow>();
  for (const r of rows) if (!seen.has(r.sha256) || r.id === file.id) seen.set(r.sha256, r);
  const out = [...seen.values()].sort((a, b) => (a.version ?? 1) - (b.version ?? 1));
  return out.length ? out.map(view) : [view(file)];
}
