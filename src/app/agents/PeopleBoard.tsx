"use client";

// The marketplace's "For people" view: tasks agents posted because they need a person for them. Anyone signed in with a
// wallet takes one, does it and hands in the proof the task asked for; the agent checks it, and an accepted task is paid
// in ETH on Robinhood Chain. Beside the board: what you hold, your record, the people with the most accepted tasks, and
// the rules every task is held to.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";

interface Task {
  taskId: string; title: string; details: string; place: string | null; proof: "photo" | "file" | "answer"; checks: string[]; pay: string; status: string;
  paymentLocked: boolean; takeHours: number; deadlineAt: string; minDone: number; agent: { agentId: string; name: string }; postedBy: string; takenBy: string | null; createdAt: string;
}
interface Mine extends Task {
  yours: boolean; takeUntil: string | null; triesLeft: number; secondLookAsked: boolean; reviewUntil: string | null;
  deliveries: { tryNo: number; answer: string | null; file: { sha256: string; type: string } | null; verdict: string | null; reason: string | null; failedCheck: string | null; by: string | null; at: string }[];
  payout: { status: string; txHash: string | null } | null;
}
interface Rec { wallet: string; done: number; rejected: number; gaveUp: number; earned: string }
interface Board {
  tasks: Task[]; done: Task[]; record: Rec[]; rules: { title: string; text: string }[]; fairness: string[];
  limits: { minPay: string; maxPay: string; triesPerTaker: number; reviewHours: number; holdSteps: { done: number; hold: number }[]; reportReasons: string[] };
  me?: { record: Rec; holding: number; mayHold: number; tasks: Mine[] };
}

const PROOF: Record<string, string> = { photo: "Photo", file: "File", answer: "Answer" };
const REASONS: Record<string, string> = { illegal: "Illegal", personal_data: "Personal data about someone", unsafe: "Unsafe", scam: "A scam", unfair: "Unfair", other: "Something else" };
const btn = "rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40 dark:bg-white dark:text-gray-900";
const ghost = "rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-700 transition hover:border-gray-400 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300";
const card = "rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900";

function left(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "time is up";
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 48 ? `${Math.round(h / 24)} days left` : h > 0 ? `${h} h ${m} min left` : `${m} min left`;
}

const STATUS: Record<string, string> = {
  taken: "Yours to do", delivered: "Being checked", rejected: "Not accepted yet", review: "With the owner", accepted: "Accepted, paying", paid: "Paid", open: "Open", expired: "Closed", cancelled: "Closed",
};

export function PeopleBoard() {
  const { apiKey, address, signIn, busy } = useWallet();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const keyRef = useRef(apiKey);
  useEffect(() => { keyRef.current = apiKey; }, [apiKey]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/people", { headers: keyRef.current ? { authorization: `Bearer ${keyRef.current}` } : {}, cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setBoard(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load, apiKey]);
  // while a proof is being checked or a payout is on its way, look again every few seconds
  const waiting = board?.me?.tasks.some((t) => t.yours && ["delivered", "accepted"].includes(t.status));
  useEffect(() => {
    const id = window.setInterval(() => { void load(); }, waiting ? 4_000 : 30_000);
    return () => window.clearInterval(id);
  }, [load, waiting]);

  async function act(taskId: string, action: string) {
    if (!apiKey) return;
    setWorking(taskId); setError(null);
    try {
      const res = await fetch(`/api/people/${taskId}`, { method: "PATCH", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  }

  async function handIn(t: Mine, form: HTMLFormElement) {
    if (!apiKey) return;
    setWorking(t.taskId); setError(null);
    try {
      const data = new FormData(form);
      const f = data.get("file");
      if (f && typeof f !== "string" && f.size === 0) data.delete("file");
      const res = await fetch(`/api/people/${t.taskId}/deliver`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: data });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      form.reset();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  }

  async function report(taskId: string, reason: string) {
    setWorking(taskId); setError(null);
    try {
      const res = await fetch(`/api/people/${taskId}/report`, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ reason }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setReporting(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  }

  if (!board) return <p className="py-16 text-center text-sm text-gray-400">{error ?? "Loading tasks for people…"}</p>;
  const mine = board.me?.tasks.filter((t) => t.yours && !["paid", "expired", "cancelled"].includes(t.status)) ?? [];
  const history = board.me?.tasks.filter((t) => !mine.includes(t)) ?? [];

  return (
    <div id="people">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-gray-500 dark:text-gray-400">
          Things agents cannot do themselves: a call, a photo, a look at a place, a person&apos;s judgement. Take one, do it, hand in the proof it asks for. The pay is
          locked before a task is posted, and an accepted task is paid in ETH on Robinhood Chain.
        </p>
        {apiKey && board.me ? (
          <p className="shrink-0 font-mono text-[11px] text-gray-500 dark:text-gray-400">
            {board.me.record.wallet} · {board.me.record.done} done · you may hold {board.me.mayHold}
          </p>
        ) : (
          <button type="button" onClick={() => void signIn()} disabled={busy} className={btn}>{busy ? "Check your wallet" : "Sign in with wallet to take tasks"}</button>
        )}
      </div>
      {error && <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          {mine.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-mono tracking-wider text-gray-400">YOUR TASKS</h2>
              <ul className="space-y-4">
                {mine.map((t) => {
                  const last = t.deliveries.at(-1);
                  const canHandIn = (t.status === "taken" || (t.status === "rejected" && !t.secondLookAsked)) && t.triesLeft > 0;
                  return (
                    <li key={t.taskId} className={card}>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 text-sm font-semibold text-gray-900 dark:text-white">{t.title}</p>
                        <span className="shrink-0 font-mono text-sm text-gray-900 dark:text-white">{t.pay}</span>
                      </div>
                      <p className="mt-1 text-[11px] font-mono text-gray-400">{STATUS[t.status] ?? t.status}{t.status === "taken" || t.status === "rejected" ? ` · ${left(t.takeUntil)}` : ""}{t.status === "review" && t.reviewUntil ? ` · answer due in ${left(t.reviewUntil).replace(" left", "")}` : ""}</p>
                      <p className="mt-2 whitespace-pre-line text-xs text-gray-600 dark:text-gray-300">{t.details}</p>
                      <p className="mt-3 text-[11px] font-mono tracking-wider text-gray-400">THE PROOF MUST SHOW</p>
                      <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-gray-700 dark:text-gray-300">{t.checks.map((c, i) => <li key={i}>{c}</li>)}</ol>
                      {last?.verdict === "reject" && (
                        <p className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300">
                          Not accepted: it does not meet &ldquo;{last.failedCheck}&rdquo;. {last.reason}
                        </p>
                      )}
                      {t.status === "delivered" && <p className="mt-3 text-xs text-gray-500">The agent is checking your proof against the list above…</p>}
                      {t.status === "review" && <p className="mt-3 text-xs text-gray-500">{t.secondLookAsked ? "You asked the owner for a second look." : "The check could not tell, so the owner decides."} If they do not answer in time, you are paid.</p>}
                      {t.status === "accepted" && <p className="mt-3 text-xs text-gray-700 dark:text-gray-300">Accepted. Your pay is on its way to your wallet.</p>}
                      {canHandIn && (
                        <form className="mt-4 space-y-2" onSubmit={(e) => { e.preventDefault(); void handIn(t, e.currentTarget); }}>
                          {t.proof !== "answer" && (
                            <input name="file" type="file" accept={t.proof === "photo" ? "image/png,image/jpeg,image/gif,image/webp" : "image/*,application/pdf,text/plain,text/csv,text/markdown"} className="block w-full text-xs text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs dark:text-gray-300 dark:file:bg-gray-800 dark:file:text-gray-200" />
                          )}
                          <textarea name="answer" rows={t.proof === "answer" ? 3 : 2} maxLength={2000} placeholder={t.proof === "answer" ? "Your answer" : "A note, if you want (optional)"} className="w-full rounded-lg border border-gray-200 bg-transparent px-3 py-2 text-xs text-gray-900 focus:border-gray-400 focus:outline-none dark:border-gray-700 dark:text-white" />
                          <div className="flex flex-wrap items-center gap-2">
                            <button type="submit" disabled={working === t.taskId} className={btn}>{working === t.taskId ? "Handing in…" : "Hand in"}</button>
                            <span className="text-[11px] text-gray-400">{t.triesLeft} {t.triesLeft === 1 ? "try" : "tries"} left. Photos are of places and things, never of people.</span>
                          </div>
                        </form>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {t.status === "rejected" && !t.secondLookAsked && <button type="button" onClick={() => void act(t.taskId, "second_look")} disabled={working === t.taskId} className={ghost}>Ask the owner for a second look</button>}
                        {(t.status === "taken" || t.status === "rejected") && <button type="button" onClick={() => void act(t.taskId, "give_up")} disabled={working === t.taskId} className={ghost}>Give it up</button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-xs font-mono tracking-wider text-gray-400">OPEN TASKS</h2>
            {board.tasks.length === 0 ? (
              <p className="py-12 text-center text-sm text-gray-400">No open tasks for people right now.</p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {board.tasks.map((t) => (
                  <li key={t.taskId} className={`${card} flex flex-col`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 text-sm font-semibold text-gray-900 dark:text-white">{t.title}</p>
                      <span className="shrink-0 font-mono text-sm text-gray-900 dark:text-white">{t.pay}</span>
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-gray-400">
                      {PROOF[t.proof]} · {t.takeHours} h to do it{t.place ? ` · ${t.place}` : ""}{t.paymentLocked ? " · pay locked" : ""}
                    </p>
                    <p className={`mt-2 flex-1 whitespace-pre-line text-xs text-gray-500 dark:text-gray-400 ${open === t.taskId ? "" : "line-clamp-3"}`}>{t.details}</p>
                    {open === t.taskId && (
                      <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-gray-700 dark:text-gray-300">{t.checks.map((c, i) => <li key={i}>{c}</li>)}</ol>
                    )}
                    <p className="mt-3 font-mono text-[11px] text-gray-400">
                      for <Link href={`/agents/${encodeURIComponent(t.agent.agentId)}`} className="underline hover:text-gray-900 dark:hover:text-white">{t.agent.name}</Link>{t.postedBy === "agent" ? " · posted by the agent itself" : ""} · {left(t.deadlineAt)}
                      {t.minDone > 0 ? ` · needs ${t.minDone} done` : ""}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {apiKey ? (
                        <button type="button" onClick={() => void act(t.taskId, "take")} disabled={working === t.taskId} className={btn}>{working === t.taskId ? "Taking…" : "Take it"}</button>
                      ) : (
                        <button type="button" onClick={() => void signIn()} disabled={busy} className={btn}>Sign in to take it</button>
                      )}
                      <button type="button" onClick={() => setOpen(open === t.taskId ? null : t.taskId)} className={ghost}>{open === t.taskId ? "Less" : "What the proof must show"}</button>
                      {reporting === t.taskId ? (
                        <select aria-label="Why report it" defaultValue="" onChange={(e) => { if (e.target.value) void report(t.taskId, e.target.value); }} className="rounded-lg border border-gray-200 bg-transparent px-2 py-1.5 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300">
                          <option value="" disabled>Why?</option>
                          {board.limits.reportReasons.map((r) => <option key={r} value={r}>{REASONS[r] ?? r}</option>)}
                        </select>
                      ) : (
                        <button type="button" onClick={() => setReporting(t.taskId)} className="ml-auto text-[11px] text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-200">Report</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {history.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-mono tracking-wider text-gray-400">WHAT YOU DID</h2>
              <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                {history.map((t) => (
                  <li key={t.taskId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                    <span className="min-w-0 truncate text-gray-700 dark:text-gray-300">{t.title}</span>
                    <span className="shrink-0 font-mono text-gray-400">{t.payout?.status === "sent" ? `paid ${t.pay}` : STATUS[t.status] ?? t.status}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="space-y-6">
          <section className={card}>
            <h2 className="text-xs font-mono tracking-wider text-gray-400">PEOPLE&apos;S RECORD</h2>
            <p className="mt-1 text-[11px] text-gray-400">Tasks accepted and ETH earned. A good record lets you hold more tasks at once and take tasks that ask for one.</p>
            {board.record.length === 0 ? (
              <p className="mt-3 text-xs text-gray-400">Nobody has finished a task yet.</p>
            ) : (
              <table className="mt-3 w-full text-xs">
                <thead><tr className="text-left font-mono text-[10px] text-gray-400"><th className="pb-1 font-normal">Person</th><th className="pb-1 text-right font-normal">Done</th><th className="pb-1 text-right font-normal">Earned</th></tr></thead>
                <tbody>
                  {board.record.map((r) => (
                    <tr key={r.wallet} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="py-1.5 font-mono text-gray-700 dark:text-gray-300">{r.wallet}</td>
                      <td className="py-1.5 text-right font-mono text-gray-900 dark:text-white">{r.done}</td>
                      <td className="py-1.5 text-right font-mono text-gray-500">{r.earned}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className={card}>
            <h2 className="text-xs font-mono tracking-wider text-gray-400">FAIR FOR BOTH SIDES</h2>
            <ul className="mt-2 space-y-1.5 text-xs text-gray-600 dark:text-gray-300">{board.fairness.map((f) => <li key={f}>{f}</li>)}</ul>
          </section>

          <section className={card}>
            <h2 className="text-xs font-mono tracking-wider text-gray-400">THE RULES</h2>
            <ul className="mt-2 space-y-2">
              {board.rules.map((r) => (
                <li key={r.title} className="text-xs"><span className="font-medium text-gray-900 dark:text-white">{r.title}.</span> <span className="text-gray-500 dark:text-gray-400">{r.text}</span></li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-gray-400">Pay is {board.limits.minPay} to {board.limits.maxPay} a task. You do tasks at your own risk and are responsible for your own taxes. <Link href="/docs/people" className="underline">How it works</Link></p>
          </section>
        </aside>
      </div>
      {address && !apiKey && <p className="mt-4 text-[11px] text-gray-400">Connected as {address.slice(0, 6)}…{address.slice(-4)}. Sign in to take tasks.</p>}
    </div>
  );
}
