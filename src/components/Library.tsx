"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MarkdownOutput from "@/components/MarkdownOutput";
import OutputFiles, { type OutputFile } from "@/components/OutputFiles";
import { browserMemoryKey } from "@/components/AgentMemory";
import VoiceOutput from "@/components/VoiceOutput";

/**
 * Your library: every conversation you have had with an agent, the files that came back and their versions, and
 * for each job the receipt that proves it. It is found by the key this browser keeps and, for somebody signed in
 * on the dashboard, by their wallet as well. Both parts here show nothing at all until the server says the library
 * is on and there is something in it to show.
 */

export interface LibraryConversation {
  thread: string;
  agent: { id: string; name: string };
  agents: string[];
  lastAgent: { id: string; name: string };
  turns: number;
  asked: string;
  startedAt: string;
  lastAt: string;
  status: string;
  files: number;
  lastTaskId: string;
  onSite: boolean;
}

export interface LibraryTurn {
  taskId: string;
  claimToken: string;
  agent: { id: string; name: string; price: string | null };
  task: string;
  status: string;
  output: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  outputFiles: OutputFile[];
  receipt: string;
}

interface LibraryFile extends OutputFile { taskId: string; thread: string; agent: { id: string; name: string }; createdAt: string; receipt: string }

/** Where the dashboard keeps the key somebody signed in with. */
const DASHBOARD_KEY = "axon.dashboard.apiKey";

/** What proves a library is yours: this browser's key, and the wallet's API key where somebody is signed in. */
export function libraryHeaders(memoryKey: string | null): Record<string, string> {
  const h: Record<string, string> = {};
  if (memoryKey) h["x-memory-key"] = memoryKey;
  try {
    const k = window.localStorage.getItem(DASHBOARD_KEY);
    if (k) h.authorization = `Bearer ${k}`;
  } catch { /* storage is closed to this page: the browser key alone */ }
  return h;
}

/** One conversation in full. Null when it is not in this library, or could not be read. */
export async function readConversation(thread: string, memoryKey: string | null): Promise<LibraryTurn[] | null> {
  try {
    const r = await fetch(`/api/library/${encodeURIComponent(thread)}`, { headers: libraryHeaders(memoryKey) });
    const d = (await r.json()) as { turns?: LibraryTurn[] };
    return r.ok && Array.isArray(d.turns) ? d.turns : null;
  } catch {
    return null;
  }
}

function ago(iso: string, now: number): string {
  const then = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(then)) return "";
  const m = Math.max(0, Math.round((now - then) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  if (m < 43_200) return `${Math.round(m / 1440)} d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

const STANDS: Record<string, string> = { queued: "waiting to start", running: "working", waiting: "waiting on you", failed: "did not finish", cancelled: "called off" };
/** A conversation can be carried on while its latest turn is done or still going. */
const open = (c: Pick<LibraryConversation, "status" | "onSite">) => c.onSite && c.status !== "failed" && c.status !== "cancelled";

function Meta({ c, now }: { c: LibraryConversation; now: number }) {
  return (
    <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">
      {c.turns} {c.turns === 1 ? "turn" : "turns"}
      {c.files > 0 && ` · ${c.files} ${c.files === 1 ? "file" : "files"}`}
      {` · ${ago(c.lastAt, now)}`}
      {STANDS[c.status] && <span className={c.status === "waiting" ? "text-amber-600 dark:text-amber-400" : ""}>{` · ${STANDS[c.status]}`}</span>}
    </p>
  );
}

/**
 * On an agent's page: the conversations this agent worked on for you, the latest first, each with a button that
 * opens it again in the hire box above.
 */
export function AgentWork({ agentId, agentName, memoryKey, onContinue, refresh, disabled }: {
  agentId: string;
  agentName: string;
  memoryKey: string;
  onContinue: (thread: string) => void;
  /** changes when a job may have joined the library: read it again */
  refresh: number;
  disabled?: boolean;
}) {
  const [list, setList] = useState<LibraryConversation[]>([]);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let alive = true;
    void fetch(`/api/library?agent=${encodeURIComponent(agentId)}&limit=5`, { headers: libraryHeaders(memoryKey) })
      .then((r) => (r.ok ? (r.json() as Promise<{ conversations?: LibraryConversation[] }>) : null))
      .then((d) => { if (alive && d && Array.isArray(d.conversations)) { setList(d.conversations); setNow(Date.now()); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [agentId, memoryKey, refresh]);
  if (!list.length) return null;
  return (
    <div className="mt-4 border-t border-gray-100 pt-3.5 dark:border-gray-800">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Your work with {agentName}</p>
        <Link href="/dashboard#library" className="shrink-0 text-[11px] text-teal-600 hover:underline dark:text-teal-400">Your library →</Link>
      </div>
      <ul className="space-y-2">
        {list.map((c) => (
          <li key={c.thread} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-gray-800 dark:text-gray-200">{c.asked}</p>
              <Meta c={c} now={now} />
            </div>
            {open(c) ? (
              <button type="button" onClick={() => onContinue(c.thread)} disabled={disabled} className="shrink-0 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:border-teal-400 hover:text-teal-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:border-teal-600 dark:hover:text-teal-400">
                Continue
              </button>
            ) : (
              <a href={`/r/${encodeURIComponent(c.lastTaskId)}`} target="_blank" rel="noopener noreferrer" className="shrink-0 py-1 text-xs text-teal-600 hover:underline dark:text-teal-400">Receipt →</a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One conversation opened in the library: every turn with its answer, its files and its receipt. */
function Opened({ c, memoryKey, onRemoved }: { c: LibraryConversation; memoryKey: string | null; onRemoved: () => void }) {
  const [turns, setTurns] = useState<LibraryTurn[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void readConversation(c.thread, memoryKey).then((t) => { if (!alive) return; if (t) setTurns(t); else setFailed(true); });
    return () => { alive = false; };
  }, [c.thread, memoryKey]);

  const remove = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/library/${encodeURIComponent(c.thread)}`, { method: "DELETE", headers: libraryHeaders(memoryKey) });
      if (r.ok) onRemoved();
    } catch { /* still listed: it can be tried again */ } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  if (failed) return <p className="px-4 pb-4 text-xs text-amber-600 dark:text-amber-400">This conversation could not be read. Try again.</p>;
  if (!turns) return <p className="px-4 pb-4 text-xs text-gray-400">Reading…</p>;
  const many = new Set(turns.map((t) => t.agent.id)).size > 1;
  return (
    <div className="border-t border-gray-100 px-4 pb-4 pt-3.5 dark:border-gray-800">
      {turns.map((t, i) => (
        <div key={t.taskId} className="mb-4 border-b border-gray-100 pb-4 last:mb-3 dark:border-gray-800">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">You, turn {i + 1}</p>
          <p className="whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{t.task}</p>
          {many && <p className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">{t.agent.name}</p>}
          {t.status === "completed" ? (
            <div className="mt-2 max-h-72 overflow-auto break-words rounded-md border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-800 dark:bg-gray-900/40">
              {t.output ? <MarkdownOutput text={t.output} /> : <span className="text-sm text-gray-400">(empty response)</span>}
            </div>
          ) : (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t.agent.name}: {STANDS[t.status] ?? t.status}.</p>
          )}
          <OutputFiles files={t.outputFiles} />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <a href={t.receipt} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 hover:underline dark:text-teal-400">Receipt →</a>
            {t.status === "completed" && t.output && <VoiceOutput taskId={t.taskId} claimToken={t.claimToken} />}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {open(c) && (
          <Link href={`/agents/${encodeURIComponent(c.lastAgent.id)}?continue=${encodeURIComponent(c.thread)}`} className="rounded-md bg-teal-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-700">
            Continue with {c.lastAgent.name}
          </Link>
        )}
        {asking ? (
          <>
            <span className="text-xs text-gray-500 dark:text-gray-400">Take it out of your library? The receipts stay.</span>
            <button type="button" onClick={() => void remove()} disabled={busy} className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-800 hover:border-gray-500 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100">{busy ? "Removing…" : "Remove"}</button>
            <button type="button" onClick={() => setAsking(false)} disabled={busy} className="text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">Keep</button>
          </>
        ) : (
          <button type="button" onClick={() => setAsking(true)} className="text-xs text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200">Remove from library</button>
        )}
      </div>
    </div>
  );
}

/** The whole library, on the dashboard: conversations and files. */
export default function Library() {
  const [memoryKey, setMemoryKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [on, setOn] = useState(false);
  const [list, setList] = useState<LibraryConversation[]>([]);
  const [files, setFiles] = useState<LibraryFile[] | null>(null);
  const [tab, setTab] = useState<"conversations" | "files">("conversations");
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const read = useCallback(async (key: string | null) => {
    try {
      const r = await fetch("/api/library?limit=50", { headers: libraryHeaders(key) });
      if (r.status === 404) return; // the library is not on here
      setOn(true);
      const d = (await r.json().catch(() => ({}))) as { conversations?: LibraryConversation[] };
      if (r.ok && Array.isArray(d.conversations)) { setList(d.conversations); setNow(Date.now()); }
    } catch { /* shown as empty; the next visit reads it again */ }
  }, []);

  useEffect(() => {
    // the key lives in this browser's storage, which cannot be read while the page is made on the server
    const key = browserMemoryKey();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount, from storage the server has no access to
    setMemoryKey(key);
    void read(key).finally(() => setReady(true));
  }, [read]);

  useEffect(() => {
    if (tab !== "files" || files) return;
    let alive = true;
    void fetch("/api/library?view=files", { headers: libraryHeaders(memoryKey) })
      .then((r) => (r.ok ? (r.json() as Promise<{ files?: LibraryFile[] }>) : null))
      .then((d) => { if (alive) setFiles(d && Array.isArray(d.files) ? d.files : []); })
      .catch(() => { if (alive) setFiles([]); });
    return () => { alive = false; };
  }, [tab, files, memoryKey]);

  if (!ready || !on) return null;
  const tabClass = (t: typeof tab) => `rounded-md px-3 py-1 text-xs font-medium transition-colors ${tab === t ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"}`;
  const totalFiles = list.reduce((n, c) => n + c.files, 0);

  return (
    <section id="library" className="mb-10 scroll-mt-28 rounded-lg border border-gray-200 dark:border-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900 dark:text-white">Your library</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Every conversation with an agent, every file and every version, each with its receipt.</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-800">
          <button type="button" onClick={() => setTab("conversations")} className={tabClass("conversations")}>Conversations{list.length ? ` ${list.length}` : ""}</button>
          <button type="button" onClick={() => setTab("files")} className={tabClass("files")}>Files{totalFiles ? ` ${totalFiles}` : ""}</button>
        </div>
      </div>

      {tab === "conversations" && (
        list.length === 0 ? (
          <p className="border-t border-gray-100 px-4 py-6 text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
            Nothing here yet. <Link href="/agents" className="text-teal-600 hover:underline dark:text-teal-400">Hire an agent</Link> and the conversation is kept here, on this browser.
          </p>
        ) : (
          <ul>
            {list.map((c) => {
              const isOpen = openThread === c.thread;
              return (
                <li key={c.thread} className="border-t border-gray-100 dark:border-gray-800">
                  <button type="button" onClick={() => setOpenThread(isOpen ? null : c.thread)} aria-expanded={isOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50/70 dark:hover:bg-gray-900/40">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">{c.agents.join(" + ")}</p>
                      <p className={`mt-0.5 text-sm text-gray-800 dark:text-gray-200 ${isOpen ? "" : "truncate"}`}>{c.asked}</p>
                      <Meta c={c} now={now} />
                    </div>
                    <span className="mt-1 shrink-0 text-xs text-gray-400" aria-hidden>{isOpen ? "Close" : "Open"}</span>
                  </button>
                  {isOpen && <Opened c={c} memoryKey={memoryKey} onRemoved={() => { setOpenThread(null); setFiles(null); setList((had) => had.filter((x) => x.thread !== c.thread)); }} />}
                </li>
              );
            })}
          </ul>
        )
      )}

      {tab === "files" && (
        <div className="border-t border-gray-100 px-4 py-4 dark:border-gray-800">
          {!files ? <p className="text-xs text-gray-400">Reading…</p> : files.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No files yet. When an agent hands back a chart, a document or a picture, it is listed here.</p>
          ) : (
            <>
              <OutputFiles compact files={files.map((f) => ({ ...f, madeBy: f.madeBy ?? { agentId: f.agent.id, name: f.agent.name, taskId: f.taskId } }))} />
              <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">The latest version of each file. Earlier versions open under it, and each file&apos;s fingerprint is on the receipt of the job that made it.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
