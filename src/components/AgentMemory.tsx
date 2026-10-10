"use client";

import { useEffect, useState } from "react";

/**
 * What an agent remembers about the person looking at the page, and their say over it: every line it noted, each
 * with a delete, "forget everything", and a tick to leave memory out of the next hire. For somebody who hires
 * without signing in, the memory hangs on a key this browser keeps; it goes in a header, never in an address.
 */

const STORE = "axon_memory_key";

/** The key this browser keeps for its memory with agents, made the first time it is asked for. Null if it cannot keep one. */
export function browserMemoryKey(): string | null {
  try {
    const had = window.localStorage.getItem(STORE);
    if (had && /^[A-Za-z0-9_-]{32,128}$/.test(had)) return had;
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    const made = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(STORE, made);
    return made;
  } catch {
    return null;
  }
}

interface Line { id: string; text: string }

export default function AgentMemory({ agentId, agentName, memoryKey, off, onOff, refresh, disabled }: {
  agentId: string;
  agentName: string;
  memoryKey: string;
  /** memory is left out of the next hire */
  off: boolean;
  onOff: (off: boolean) => void;
  /** changes when a job may have added to the memory: read it again */
  refresh: number;
  disabled?: boolean;
}) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [jobs, setJobs] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const path = `/api/agents/${encodeURIComponent(agentId)}/memory`;

  useEffect(() => {
    let alive = true;
    void fetch(path, { headers: { "x-memory-key": memoryKey } })
      .then(async (r) => (r.ok ? ((await r.json()) as { lines?: Line[]; jobs?: number }) : null))
      .then((d) => { if (alive && d) { setLines(Array.isArray(d.lines) ? d.lines : []); setJobs(Number(d.jobs) || 0); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [path, memoryKey, refresh]);

  // nothing to show until the memory has been read; where memory is switched off it never is
  if (lines === null) return null;

  const drop = async (id?: string) => {
    setBusy(id ?? "all");
    setNote(null);
    try {
      const r = await fetch(id ? `${path}/${encodeURIComponent(id)}` : path, { method: "DELETE", headers: { "x-memory-key": memoryKey } });
      const d = (await r.json().catch(() => ({}))) as { lines?: Line[]; jobs?: number };
      if (r.ok && Array.isArray(d.lines)) { setLines(d.lines); setJobs(Number(d.jobs) || 0); }
      else setNote("That could not be deleted. Try again.");
    } catch {
      setNote("That could not be deleted. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const knows = lines.length > 0 || jobs > 0;
  const summary = lines.length > 0
    ? `${agentName} remembers ${lines.length} ${lines.length === 1 ? "thing" : "things"} about you`
    : jobs > 0
      ? `${agentName} remembers the work it did for you`
      : `${agentName} will remember you on the next hire`;

  return (
    <div className="mt-2.5 text-xs text-gray-600 dark:text-gray-300">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={off ? "text-gray-400 line-through dark:text-gray-500" : ""}>{summary}</span>
        {knows && (
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-teal-700 hover:underline dark:text-teal-400">{open ? "Hide" : "See"}</button>
        )}
        <label className="flex cursor-pointer items-center gap-1.5 text-gray-500 dark:text-gray-400">
          <input type="checkbox" checked={off} onChange={(e) => onOff(e.target.checked)} disabled={disabled} className="h-3.5 w-3.5 accent-teal-600" />
          Not for this hire
        </label>
      </div>
      {open && knows && (
        <div className="mt-2 rounded-md border border-gray-200 bg-gray-50/60 p-2.5 dark:border-gray-800 dark:bg-gray-900/40">
          {lines.length > 0 ? (
            <ul className="space-y-1.5">
              {lines.map((l) => (
                <li key={l.id} className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 break-words text-gray-800 dark:text-gray-200">{l.text}</span>
                  <button type="button" onClick={() => void drop(l.id)} disabled={busy !== null} aria-label={`Delete: ${l.text}`} className="shrink-0 text-gray-400 hover:text-gray-900 disabled:opacity-50 dark:hover:text-white">
                    {busy === l.id ? "…" : "Delete"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-gray-500 dark:text-gray-400">Nothing noted yet.</p>
          )}
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            {jobs > 0 && <span>It can also recall {jobs === 1 ? "the last job" : `your last ${Math.min(jobs, 4)} jobs`} it did for you.</span>}
            <button type="button" onClick={() => void drop()} disabled={busy !== null} className="underline hover:text-gray-900 disabled:opacity-50 dark:hover:text-white">
              {busy === "all" ? "Forgetting…" : "Forget everything"}
            </button>
          </p>
          <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500">Kept for you on this browser only. Passwords and keys are never kept.</p>
          {note && <p role="status" className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">{note}</p>}
        </div>
      )}
    </div>
  );
}
