// Where a saved file came from.
//
// A picture of a web page, or a copy of one, proves nothing by itself: it has to say which page and when. An agent
// that saves something from its browser has that written down beside the file: the address, the page's title, what
// kind of copy it is, and the moment it was made. It is read with the file, by whoever may read the file.
//
// Nothing here imports the file store: the store asks this, not the other way round.

import { getDb } from "./db";

export type SavedKind = "picture" | "whole-page picture" | "pdf" | "text";
export interface FileSource { url: string; title: string; kind: SavedKind; at: string }

const KINDS: readonly string[] = ["picture", "whole-page picture", "pdf", "text"];

/** Write down where a file was saved from. Only a web address is ever kept. Returns false when nothing was written. */
export function recordSource(fileId: string, from: { url: string; title?: string; kind: SavedKind }, now = Date.now()): boolean {
  try {
    let url: URL;
    try { url = new URL(from.url); } catch { return false; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !KINDS.includes(from.kind)) return false;
    getDb().prepare("INSERT OR REPLACE INTO task_file_sources (file_id, url, title, kind, captured_at) VALUES (?,?,?,?,?)")
      .run(fileId, url.toString().slice(0, 2000), String(from.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200), from.kind, new Date(now).toISOString());
    return true;
  } catch {
    return false;
  }
}

/** Where a file was saved from, or null for a file that was not saved from a page. */
export function sourceOf(fileId: string): FileSource | null {
  try {
    const r = getDb().prepare("SELECT url, title, kind, captured_at FROM task_file_sources WHERE file_id = ?").get(fileId) as { url: string; title: string; kind: string; captured_at: string } | undefined;
    return r && KINDS.includes(r.kind) ? { url: r.url, title: r.title, kind: r.kind as SavedKind, at: r.captured_at } : null;
  } catch {
    return null;
  }
}
