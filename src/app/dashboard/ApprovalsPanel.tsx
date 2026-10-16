"use client";
// Waiting for your OK, on the dashboard: everything an agent wants to publish or send in one of your apps, with a
// preview of exactly what would go out. Approve or decline; a request left alone expires after 24 hours. Every
// decision is written to the job's receipt.
//
// It shows nothing at all until the server says apps are on.

import { useCallback, useEffect, useState } from "react";

interface Approval {
  approvalId: string;
  agentId: string;
  agentName: string | null;
  taskId: string;
  appId: string;
  appName: string;
  title: string;
  preview: string;
  status: "pending" | "approved" | "declined" | "expired" | "cancelled" | "used";
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  receiptUrl: string;
}

const button =
  "text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const approve =
  "text-xs px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity disabled:opacity-40";
const STATUS: Record<Approval["status"], string> = {
  pending: "Waiting",
  approved: "Approved",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
  used: "Sent",
};
const ago = (iso: string): string => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const left = (iso: string): string => {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
};

export default function ApprovalsPanel({ apiKey, onToast }: { apiKey: string; onToast: (type: "success" | "error", message: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [pending, setPending] = useState<Approval[]>([]);
  const [recent, setRecent] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [refreshes, setRefreshes] = useState(0);

  const authed = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `Request failed (${res.status})`), { status: res.status });
      return body;
    },
    [apiKey],
  );

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const body = (await authed("/api/apps/approvals")) as { pending: Approval[]; recent: Approval[] };
        if (!alive) return;
        setPending(body.pending);
        setRecent(body.recent);
        setOn(true);
      } catch (e) {
        if (alive) setOn((e as { status?: number }).status === 404 ? false : null);
      }
    };
    void load();
    // a request can arrive while the dashboard is open
    const t = window.setInterval(() => void load(), 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [authed, refreshes]);

  if (!on) return null;

  const decide = async (a: Approval, decision: "approve" | "decline") => {
    setBusy(a.approvalId);
    try {
      await authed(`/api/apps/approvals/${encodeURIComponent(a.approvalId)}`, { method: "POST", body: JSON.stringify({ decision }) });
      onToast("success", decision === "approve" ? "Approved" : "Declined");
      setConfirming(null);
      setRefreshes((n) => n + 1);
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
      setRefreshes((n) => n + 1);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="approvals" className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-semibold text-gray-900 dark:text-white">Waiting for your OK</h2>
        {pending.length > 0 && <span className="text-[11px] px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400">{pending.length} waiting</span>}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        When an agent wants to publish or send something in one of your apps, it waits here with a preview of exactly what would
        go out. Nothing is sent until you approve it. A request you leave expires after 24 hours, and every decision is on the job&apos;s receipt.
      </p>

      {pending.length === 0 ? (
        <p className="text-sm text-gray-400 py-2">Nothing is waiting for your OK.</p>
      ) : (
        <ul className="space-y-3">
          {pending.map((a) => (
            <li key={a.approvalId} className="rounded-lg border border-gray-100 dark:border-gray-800 p-4 space-y-3 min-w-0">
              <div className="min-w-0">
                <p className="font-medium text-gray-900 dark:text-white break-words">{a.title}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {a.agentName ?? a.agentId} wants to publish in {a.appName} · asked {ago(a.createdAt)} · expires in {left(a.expiresAt)}
                </p>
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 p-3 text-xs text-gray-800 dark:text-gray-200 font-mono">{a.preview}</pre>
              <div className="flex flex-wrap items-center gap-2">
                {confirming === a.approvalId ? (
                  <>
                    <span className="text-xs text-gray-600 dark:text-gray-300">Send this to {a.appName} now?</span>
                    <button onClick={() => void decide(a, "approve")} disabled={busy !== null} className={approve}>{busy === a.approvalId ? "Approving…" : "Yes, approve"}</button>
                    <button onClick={() => setConfirming(null)} disabled={busy !== null} className={button}>Not yet</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => setConfirming(a.approvalId)} disabled={busy !== null} className={approve}>Approve</button>
                    <button onClick={() => void decide(a, "decline")} disabled={busy !== null} className={button}>Decline</button>
                  </>
                )}
                <a href={a.receiptUrl} className="text-xs text-gray-500 dark:text-gray-400 underline underline-offset-2 ml-auto">Job receipt</a>
              </div>
            </li>
          ))}
        </ul>
      )}

      {recent.length > 0 && (
        <div className="mt-4">
          <button onClick={() => setShowRecent((s) => !s)} className="text-xs text-gray-500 dark:text-gray-400 underline underline-offset-2">
            {showRecent ? "Hide" : "Show"} what was decided lately ({recent.length})
          </button>
          {showRecent && (
            <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
              {recent.map((a) => (
                <li key={a.approvalId} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate text-gray-800 dark:text-gray-200">{a.title} <span className="text-gray-400">· {a.appName}</span></span>
                  <span className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                    {STATUS[a.status]}{a.decidedAt ? ` ${ago(a.decidedAt)}` : ""}
                    <a href={a.receiptUrl} className="underline underline-offset-2">Receipt</a>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
