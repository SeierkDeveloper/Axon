"use client";
// Agents that hire people, on the dashboard: post a task for people for one of your agents, and follow every task your
// agents posted, by hand or on their own: who took it, the proof they handed in, what the agent's check said, and the
// payout with its transaction. A proof the check could not judge, or one a person asked you to look at again, waits here
// for your answer; if you do not answer in time, the person is paid. Nothing shows until the server says it is on.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { payForBuild } from "@/lib/buildPaymentClient";

interface Delivery { deliveryId: string; wallet: string | null; tryNo: number; answer: string | null; file: { sha256: string | null; type: string | null; url: string } | null; verdict: string | null; reason: string | null; failedCheck: string | null; by: string | null; at: string }
interface Posted {
  taskId: string; title: string; details: string; place: string | null; proof: string; checks: string[]; pay: string; status: string; hidden: string | null; funding: string; lock: string;
  agent: { agentId: string; name: string }; postedBy: string; takenBy: string | null; takeUntil: string | null; reviewUntil: string | null; secondLook: boolean; parentTaskId: string | null;
  deliveries: Delivery[]; payouts: { kind: string; wallet: string | null; amount: string; status: string; txHash: string | null }[]; log: { kind: string; text: string; at: string }[]; closeReason: string | null;
}
interface AgentLite { agentId: string; name: string; verified: boolean; earnings: string }
interface Limits { minPay: string; maxPay: string; checksMax: number; maxDays: number; reviewHours: number }

const input = "w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500";
const button = "text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const primary = "text-xs px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity disabled:opacity-40";
const label = "block text-[11px] uppercase tracking-wide text-gray-400 mb-1";
const WORD: Record<string, string> = {
  approval: "Waiting for your OK", open: "On the board", taken: "Someone is doing it", delivered: "Being checked", rejected: "Not accepted yet", review: "Waiting for you",
  accepted: "Accepted, paying", paid: "Paid", cancelled: "Cancelled", expired: "Closed unused",
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const EMPTY = { agentId: "", title: "", details: "", place: "", proof: "photo", checks: "", priceEth: "0.0005", takeHours: "24", days: "3", minDone: "0", funding: "earnings" };

/** A proof photo, read with the owner's key (it is never public) and shown from memory. */
function ProofPicture({ url, apiKey }: { url: string; apiKey: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    void fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } }).then(async (r) => {
      if (!r.ok) return;
      made = URL.createObjectURL(await r.blob());
      setSrc(made);
    });
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [url, apiKey]);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="The proof a person handed in" className="mt-2 max-h-64 rounded border border-gray-200 dark:border-gray-700" /> : null;
}

export default function PeoplePanel({ apiKey, onToast }: { apiKey: string; onToast: (type: "success" | "error", message: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [posted, setPosted] = useState<Posted[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [payTo, setPayTo] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [posting, setPosting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ taskId: string; failedCheck: string; reason: string } | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const prefilled = useRef(false);

  const authed = useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(path, { ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `Request failed (${res.status})`), { status: res.status });
    return body;
  }, [apiKey]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const body = (await authed("/api/people")) as { posted: Posted[]; agents: AgentLite[]; limits: Limits; payTo: string | null };
        if (!alive) return;
        setPosted(body.posted); setAgents(body.agents); setLimits(body.limits); setPayTo(body.payTo); setOn(true);
        // a link from Mylo or an assistant opens the form filled in, once: /dashboard?people=<agentId>&title=...#people
        const q = new URLSearchParams(window.location.search);
        const agentId = q.get("people");
        if (agentId && !prefilled.current) {
          prefilled.current = true;
          setForm((f) => ({ ...f, agentId, title: q.get("title") ?? f.title, details: q.get("details") ?? f.details, place: q.get("place") ?? f.place, proof: q.get("proof") ?? f.proof, checks: (q.get("checks") ?? f.checks).split("|").join("\n"), priceEth: q.get("pay") ?? f.priceEth, takeHours: q.get("hours") ?? f.takeHours }));
          setPosting(true);
        }
      } catch (e) {
        if (!alive) return;
        if ((e as { status?: number }).status === 404) setOn(false);
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 15_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [authed, refreshes]);

  const reload = () => setRefreshes((n) => n + 1);

  async function post() {
    setBusy("post");
    try {
      let paymentTx: string | undefined;
      if (form.funding === "wallet") {
        if (!payTo) throw new Error("Payments are not set up on this network.");
        paymentTx = (await payForBuild({ treasury: payTo, ethAmount: form.priceEth })).signature;
      }
      const body = { agentId: form.agentId, title: form.title, details: form.details, place: form.place || undefined, proof: form.proof, checks: form.checks.split("\n").map((c) => c.trim()).filter(Boolean), priceEth: form.priceEth, takeHours: Number(form.takeHours), days: Number(form.days), minDone: Number(form.minDone), funding: form.funding, paymentTx };
      // a payment that is still confirming is tried again with the same hash, never paid twice
      for (let i = 0; ; i++) {
        try {
          await authed("/api/people", { method: "POST", body: JSON.stringify(body) });
          break;
        } catch (e) {
          if ((e as { status?: number }).status === 503 && paymentTx && i < 5) { await new Promise((r) => setTimeout(r, 3_000)); continue; }
          throw e;
        }
      }
      onToast("success", "Posted for people");
      setForm(EMPTY); setPosting(false); reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function act(taskId: string, action: string, extra: Record<string, unknown> = {}) {
    setBusy(`${action}:${taskId}`);
    try {
      await authed(`/api/people/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify({ action, ...extra }) });
      onToast("success", action === "accept" ? "Accepted. The person is being paid" : action === "reject" ? "Rejected, with your reason" : "Cancelled");
      setRejecting(null); reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  if (!on) return null;
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const waiting = posted.filter((t) => t.status === "review").length;

  return (
    <section id="people" className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
        <h2 className="font-semibold text-gray-900 dark:text-white">Agents that hire people {waiting > 0 && <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 align-middle">{waiting} waiting for you</span>}</h2>
        {!posting && agents.length > 0 && <button onClick={() => setPosting(true)} className={primary}>Post a task for people</button>}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        When one of your agents needs something only a person can do, it posts a task for people: a call, a photo, a look at a place, a judgement. The pay is locked
        first, anyone signed in with a wallet can take it, and the agent checks the proof against the lines you list. An accepted task is paid in ETH on Robinhood
        Chain. Agents running a business can post them on their own, inside its limits. See <Link className="underline" href="/agents?view=people">the board</Link>.
      </p>

      {posting && limits && (
        <div className="rounded-lg border border-gray-900 dark:border-white p-4 mb-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block min-w-0"><span className={label}>For agent</span>
              <select className={input} value={form.agentId} onChange={set("agentId")}>
                <option value="">Pick one of your agents</option>
                {agents.map((a) => <option key={a.agentId} value={a.agentId} disabled={!a.verified}>{a.name} ({a.earnings} earned)</option>)}
              </select>
            </label>
            <label className="block min-w-0"><span className={label}>Paid from</span>
              <select className={input} value={form.funding} onChange={set("funding")}>
                <option value="earnings">The agent&apos;s earnings</option>
                <option value="wallet">Your wallet, now</option>
              </select>
            </label>
          </div>
          <label className="block"><span className={label}>Title</span><input className={input} value={form.title} onChange={set("title")} placeholder="Check the opening hours at Central Library" /></label>
          <label className="block"><span className={label}>What to do</span><textarea className={input} rows={3} value={form.details} onChange={set("details")} placeholder="Go to the main entrance and photograph the sign with the opening hours." /></label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block min-w-0"><span className={label}>Where (an area or a public place)</span><input className={input} value={form.place} onChange={set("place")} /></label>
            <label className="block min-w-0"><span className={label}>Proof</span>
              <select className={input} value={form.proof} onChange={set("proof")}><option value="photo">A photo</option><option value="file">A file</option><option value="answer">A short answer</option></select>
            </label>
          </div>
          <label className="block"><span className={label}>The proof must show (one per line, up to {limits.checksMax}; the only grounds to reject it)</span><textarea className={input} rows={3} value={form.checks} onChange={set("checks")} placeholder={"The sign can be read\nThe library's name is visible"} /></label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="block min-w-0"><span className={label}>Pay, ETH</span><input className={input} inputMode="decimal" value={form.priceEth} onChange={set("priceEth")} /><span className="mt-1 block text-[11px] text-gray-400">{limits.minPay} to {limits.maxPay}</span></label>
            <label className="block min-w-0"><span className={label}>Hours to do it</span><input className={input} inputMode="numeric" value={form.takeHours} onChange={set("takeHours")} /></label>
            <label className="block min-w-0"><span className={label}>Days on the board</span><input className={input} inputMode="numeric" value={form.days} onChange={set("days")} /></label>
            <label className="block min-w-0"><span className={label}>Record needed</span><input className={input} inputMode="numeric" value={form.minDone} onChange={set("minDone")} /></label>
          </div>
          <p className="text-[11px] text-gray-400">Every task is checked against the rules before it goes up: nothing illegal, nothing about a private person, nobody put at risk. If the check cannot judge a proof, it waits for you for {limits.reviewHours} hours; after that the person is paid.</p>
          <div className="flex gap-2">
            <button onClick={() => void post()} disabled={busy === "post" || !form.agentId} className={primary}>{busy === "post" ? (form.funding === "wallet" ? "Check your wallet" : "Checking the rules…") : "Post it"}</button>
            <button onClick={() => setPosting(false)} className={button}>Not now</button>
          </div>
        </div>
      )}

      {posted.length === 0 ? (
        <p className="text-sm text-gray-400">None of your agents has posted a task for people yet.</p>
      ) : (
        <ul className="space-y-3">
          {posted.map((t) => (
            <li key={t.taskId} className="rounded-lg border border-gray-200 dark:border-gray-800 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 text-sm font-medium text-gray-900 dark:text-white">{t.title}</p>
                <span className="font-mono text-xs text-gray-900 dark:text-white">{t.pay}</span>
              </div>
              <p className="mt-0.5 text-[11px] font-mono text-gray-400">
                {WORD[t.status] ?? t.status} · {t.agent.name}{t.postedBy === "agent" ? " posted it during a job" : ""} · paid from {t.funding === "wallet" ? "your wallet" : "its earnings"}{t.takenBy ? ` · ${t.takenBy}` : ""}{t.hidden ? ` · ${t.hidden}` : ""}
              </p>
              {t.deliveries.length > 0 && (
                <div className="mt-3 space-y-2">
                  {t.deliveries.map((d) => (
                    <div key={d.deliveryId} className="rounded border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 p-3 text-xs">
                      <p className="font-mono text-[11px] text-gray-400">Try {d.tryNo} by {d.wallet} · {when(d.at)}{d.verdict ? ` · ${d.verdict === "accept" ? "accepted" : d.verdict === "reject" ? "not accepted" : "the check could not tell"}${d.by ? ` (${d.by})` : ""}` : " · being checked"}</p>
                      {d.answer && <p className="mt-1 whitespace-pre-line text-gray-700 dark:text-gray-300">{d.answer}</p>}
                      {d.file && (d.file.type ?? "").startsWith("image/") && <ProofPicture url={`${d.file.url}&view=1`} apiKey={apiKey} />}
                      {d.file && !(d.file.type ?? "").startsWith("image/") && <p className="mt-1 text-gray-500">A file ({d.file.type}), fingerprint {d.file.sha256?.slice(0, 12)}</p>}
                      {d.reason && <p className="mt-1 text-gray-500">{d.failedCheck ? `Does not meet "${d.failedCheck}". ` : ""}{d.reason}</p>}
                    </div>
                  ))}
                </div>
              )}
              {t.payouts.map((p) => (
                <p key={p.kind} className="mt-2 text-[11px] font-mono text-gray-500">{p.kind === "pay" ? `Paid ${p.amount} to ${p.wallet}` : `${p.amount} back to your wallet`} · {p.status}{p.txHash ? ` · ${p.txHash.slice(0, 10)}…${p.txHash.slice(-6)}` : ""}</p>
              ))}
              <div className="mt-3 flex flex-wrap gap-2">
                {["delivered", "rejected", "review"].includes(t.status) && <button onClick={() => void act(t.taskId, "accept")} disabled={busy !== null} className={primary}>Accept and pay</button>}
                {t.status === "review" && (rejecting?.taskId === t.taskId ? (
                  <div className="w-full space-y-2">
                    <select className={input} value={rejecting.failedCheck} onChange={(e) => setRejecting({ ...rejecting, failedCheck: e.target.value })}>
                      <option value="">Which line does it not meet?</option>
                      {t.checks.map((c, i) => <option key={i} value={i}>{c}</option>)}
                    </select>
                    <input className={input} value={rejecting.reason} onChange={(e) => setRejecting({ ...rejecting, reason: e.target.value })} placeholder="Why, in a few words. The person reads it." />
                    <div className="flex gap-2">
                      <button onClick={() => void act(t.taskId, "reject", { failedCheck: Number(rejecting.failedCheck), reason: rejecting.reason })} disabled={busy !== null || rejecting.failedCheck === "" || rejecting.reason.trim().length < 5} className={button}>Reject</button>
                      <button onClick={() => setRejecting(null)} className={button}>Back</button>
                    </div>
                  </div>
                ) : <button onClick={() => setRejecting({ taskId: t.taskId, failedCheck: "", reason: "" })} className={button}>Reject…</button>)}
                {(t.status === "open" || t.status === "approval") && <button onClick={() => void act(t.taskId, "cancel")} disabled={busy !== null} className={button}>Cancel</button>}
                {t.parentTaskId && <Link href={`/r/${t.parentTaskId}`} className={button}>The job it came from</Link>}
              </div>
              {t.status === "review" && t.reviewUntil && <p className="mt-2 text-[11px] text-gray-400">{t.secondLook ? "The person asked you to look again." : "The check could not tell."} Answer by {when(t.reviewUntil)}, or the person is paid.</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
