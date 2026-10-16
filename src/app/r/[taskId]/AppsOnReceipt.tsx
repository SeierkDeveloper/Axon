"use client";
// The owner's part of a job's receipt: what the agent did in their apps for this job. What it read, the drafts it wrote
// (with their text, to read and copy), and what it asked to post, with Approve and Decline right here. Approving goes
// through the same path as the dashboard's "Waiting for your OK", and a Slack post goes out at once, as them.
//
// Only for the person who hired the job, signed in on this browser (their dashboard key is kept here). Anybody else,
// and any job with nothing done in an app, sees nothing at all: the public receipt never shows what was written.

import { useCallback, useEffect, useState } from "react";
import AppIcon from "@/components/AppIcon";

type Status = "done" | "failed" | "draft" | "waiting" | "posted" | "declined" | "expired" | "cancelled" | "approved";
interface Line {
  actionId: string;
  appId: string;
  appName: string;
  action: "read" | "draft" | "publish";
  summary: string;
  targetLabel: string | null;
  body: string | null;
  approvalId: string | null;
  status: Status;
  error: string | null;
  link: string | null;
  createdAt: string;
}
interface Approval {
  approvalId: string;
  appId: string;
  appName: string;
  title: string;
  preview: string;
  status: "pending" | "approved" | "declined" | "expired" | "cancelled" | "used" | "failed";
  expiresAt: string;
}

const STORAGE_KEY = "axon.dashboard.apiKey";
const WORD: Record<Status, string> = {
  done: "Done",
  failed: "Did not work",
  draft: "Draft for you",
  waiting: "Waiting for your OK",
  posted: "Posted",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
  approved: "Approved, posting",
};
const TONE: Record<Status, string> = {
  done: "border-white/15 text-gray-400",
  failed: "border-red-500/40 text-red-300",
  draft: "border-white/25 text-gray-200",
  waiting: "border-amber-400/50 text-amber-200",
  posted: "border-emerald-500/40 text-emerald-300",
  declined: "border-white/15 text-gray-400",
  expired: "border-white/15 text-gray-400",
  cancelled: "border-white/15 text-gray-400",
  approved: "border-white/25 text-gray-200",
};
const left = (iso: string): string => {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};
const btn = "text-xs px-3 py-1.5 rounded-lg border border-white/15 text-gray-300 hover:border-white/40 hover:text-white transition-colors disabled:opacity-40";
const yes = "text-xs px-3 py-1.5 rounded-lg bg-white text-gray-900 font-semibold hover:opacity-90 transition-opacity disabled:opacity-40";

export default function AppsOnReceipt({ taskId }: { taskId: string }) {
  const [key, setKey] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [said, setSaid] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount, from storage the server has no access to
      setKey(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      setKey(null);
    }
  }, []);

  const load = useCallback(async () => {
    if (!key) return;
    const res = await fetch(`/api/apps/activity?taskId=${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json().catch(() => null)) as { actions?: Line[]; approvals?: Approval[] } | null;
    setLines(body?.actions ?? []);
    setApprovals(body?.approvals ?? []);
  }, [key, taskId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads from the server; the state is set when it answers
    void load();
    const t = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(t);
  }, [load, refreshes]);

  if (!key || (!lines.length && !approvals.length)) return null;

  const approvalOf = (id: string | null) => (id ? approvals.find((a) => a.approvalId === id) ?? null : null);
  // a request for an app that keeps no lines here (none yet) still shows, with its preview
  const loose = approvals.filter((a) => !lines.some((l) => l.approvalId === a.approvalId));

  const decide = async (approvalId: string, decision: "approve" | "decline") => {
    setBusy(approvalId);
    try {
      const res = await fetch(`/api/apps/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ decision }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; carried?: { outcome: string; message: string } };
      if (!res.ok) setSaid({ id: approvalId, ok: false, text: body.error ?? "That did not work. Try again." });
      else if (decision === "decline") setSaid({ id: approvalId, ok: true, text: "Declined. Nothing was posted." });
      else setSaid({ id: approvalId, ok: body.carried?.outcome !== "failed", text: body.carried && body.carried.outcome !== "none" ? body.carried.message : "Approved." });
      setConfirming(null);
      setRefreshes((n) => n + 1);
    } finally {
      setBusy(null);
    }
  };

  const copy = async (l: Line) => {
    try {
      await navigator.clipboard.writeText(l.body ?? "");
      setCopied(l.actionId);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      /* the text is on the page to select by hand */
    }
  };

  const ask = (a: Approval, where: string) =>
    a.status !== "pending" ? null : (
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {confirming === a.approvalId ? (
          <>
            <span className="text-xs text-gray-300">Post this in {where} now, as you?</span>
            <button onClick={() => void decide(a.approvalId, "approve")} disabled={busy !== null} className={yes}>{busy === a.approvalId ? "Posting…" : "Yes, post it"}</button>
            <button onClick={() => setConfirming(null)} disabled={busy !== null} className={btn}>Not yet</button>
          </>
        ) : (
          <>
            <button onClick={() => setConfirming(a.approvalId)} disabled={busy !== null} className={yes}>Approve</button>
            <button onClick={() => void decide(a.approvalId, "decline")} disabled={busy !== null} className={btn}>Decline</button>
            <span className="text-[11px] text-gray-500 ml-auto">expires in {left(a.expiresAt)}</span>
          </>
        )}
      </div>
    );

  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-5">
      <p className="text-[11px] tracking-[0.35em] font-mono text-gray-400">IN YOUR APPS</p>
      <p className="text-xs text-gray-500 mt-1 mb-4">Only you see this part: you hired this job. Nothing is posted without your OK.</p>
      <ul className="space-y-3">
        {lines.map((l) => {
          const a = approvalOf(l.approvalId);
          return (
            <li key={l.actionId} className="rounded-xl border border-white/10 bg-black/20 p-4 space-y-2 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <p className="flex items-center gap-2 text-sm text-gray-100 min-w-0">
                  <AppIcon appId={l.appId} size={16} className="shrink-0" />
                  <span className="break-words">{l.summary}</span>
                </p>
                <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${TONE[l.status]}`}>{WORD[l.status]}</span>
              </div>
              {l.body && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-gray-200 font-mono">{l.body}</pre>
              )}
              {l.error && <p className="text-xs text-red-300">{l.error}</p>}
              {l.status === "draft" && l.body && (
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => void copy(l)} className={btn}>{copied === l.actionId ? "Copied" : "Copy the text"}</button>
                  <span className="text-[11px] text-gray-500">This agent may write drafts only. Post it yourself, or let it publish on your dashboard.</span>
                </div>
              )}
              {l.link && (
                <a href={l.link} target="_blank" rel="noopener noreferrer" className="inline-block text-xs text-gray-300 underline underline-offset-2 hover:text-white">
                  Open in {l.appName}
                </a>
              )}
              {a && ask(a, l.targetLabel ?? a.appName)}
              {said?.id === l.approvalId && <p className={`text-xs ${said.ok ? "text-emerald-300" : "text-red-300"}`}>{said.text}</p>}
            </li>
          );
        })}
        {loose.map((a) => (
          <li key={a.approvalId} className="rounded-xl border border-white/10 bg-black/20 p-4 space-y-2 min-w-0">
            <p className="flex items-center gap-2 text-sm text-gray-100">
              <AppIcon appId={a.appId} size={16} />
              {a.title}
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-gray-200 font-mono">{a.preview}</pre>
            {ask(a, a.appName)}
            {said?.id === a.approvalId && <p className={`text-xs ${said.ok ? "text-emerald-300" : "text-red-300"}`}>{said.text}</p>}
          </li>
        ))}
      </ul>
      <a href="/dashboard#apps" className="mt-4 inline-block text-[11px] text-gray-500 hover:text-white">Your apps and what each agent may do →</a>
    </section>
  );
}
