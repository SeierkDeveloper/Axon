"use client";
// Agents that run their own business, on the dashboard: give one of your agents a goal, a budget and limits, and watch
// it work. Each business shows its P&L per day and in total (with a chart and a table of the same numbers), the report
// it writes each day, what waits for your OK, every decision it made with its reason, and the ledger line by line.
// Pause, resume and stop are here; what it earns is the agent's earnings, taken out in Studio like any other.
//
// It shows nothing at all until the server says businesses are on. Everything goes through /api/business with the
// owner's key.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Day { day: string; earned: string; fromJobs: string; fromSales: string; spent: string; onHires: string; onMaterial: string; onModel: string; profit: string; earnedWei: string; spentWei: string; profitWei: string }
interface Decision { decisionId: string; kind: string; subject: string | null; reason: string; detail: Record<string, unknown> | null; createdAt: string }
interface Line { day: string; at: string; direction: "in" | "out"; kind: string; amount: string | null; costUsd: number | null; ref: string; receipt: string | null; note: string | null; voided: boolean }
interface Report { day: string; text: string; dropped: number; createdAt: string }
interface Biz {
  businessId: string;
  agent: { agentId: string; name: string; price: string | null; model: string | null };
  goal: string;
  status: "active" | "paused" | "stopped";
  pausedReason: string | null;
  since: string;
  limits: { budget: string; maxPerDay: string; maxPerJob: string; approveAbove: string; spendOn: { kind: string; words: string }[]; allowanceKey: string | null; priceMin: string; priceMax: string; bidsPerHour: number; left: { budget: string; today: string } };
  selling: { on: boolean; price: string | null; makes: string | null };
  counts: { bids: number; won: number; jobsDone: number; productsSold: number };
  pnl: { days: Day[]; total: Day; modelUsd: number };
  earningsToWithdraw: string;
  decisions: Decision[];
  ledger: Line[];
  reports: Report[];
  waiting: { approvalId: string; title: string; preview: string; expiresAt: string; receiptUrl: string }[];
  nextLookAt: string | null;
}
interface AgentLite { agentId: string; name: string; price: string | null; verified: boolean; busy: boolean; canHire: boolean; canSell: boolean }
interface Key { keyId: string; keyPrefix: string; label: string | null; perTask: string; perDay: string }
interface Rules { spendKinds: { kind: string; words: string }[]; budgetMaxEth: number; bidsPerHourMax: number; perWallet: number; goalChars: number; scanMinutes: number; approvalWaitMinutes: number; shop: boolean }

const input =
  "w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500";
const button =
  "text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const primary = "text-xs px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-opacity disabled:opacity-40";
const danger = "text-xs px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 hover:border-red-400 transition-colors disabled:opacity-40";
const label = "block text-[11px] uppercase tracking-wide text-gray-400 mb-1";
const STATUS: Record<Biz["status"], { word: string; cls: string }> = {
  active: { word: "Running", cls: "border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400" },
  paused: { word: "Paused", cls: "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400" },
  stopped: { word: "Stopped", cls: "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400" },
};
const KIND: Record<string, string> = {
  start: "Started", change: "Limits", pause: "Paused", resume: "Resumed", stop: "Stopped", take: "Bid", decline: "Declined", cap: "Waited", won: "Won",
  lost: "Lost", done: "Done", failed: "Failed", hire: "Hired", refuse: "Held back", ask: "Asked you", approved: "Approved", declined: "No",
  price: "Price", model: "Model", make: "Shop", material: "Material", report: "Report",
};
const LINE: Record<string, string> = { job: "Job", sale: "Sale", hire: "Hire", material: "Material", model: "Model costs", event: "Change" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const neg = (s: string) => s.startsWith("-");

const EMPTY = { agentId: "", goal: "", budgetEth: "0.01", maxPerDayEth: "0.003", maxPerJobEth: "0.001", approveAboveEth: "0.0005", priceMinEth: "0.0002", priceMaxEth: "0.002", bidsPerHour: "3", allowanceKeyId: "", sellOn: false, sellPriceEth: "0.002", spendOn: ["hire"] as string[] };

export default function BusinessPanel({ apiKey, onToast }: { apiKey: string; onToast: (type: "success" | "error", message: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [list, setList] = useState<Biz[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [keys, setKeys] = useState<Key[]>([]);
  const [rules, setRules] = useState<Rules | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const prefilled = useRef(false);

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
        const body = (await authed("/api/business")) as { businesses: Biz[]; agents: AgentLite[]; allowanceKeys: Key[]; rules: Rules };
        if (!alive) return;
        setList(body.businesses);
        setAgents(body.agents);
        setKeys(body.allowanceKeys);
        setRules(body.rules);
        setOn(true);
        // a link from Mylo or an assistant opens the form filled in, once: /dashboard?business=<agentId>&goal=...#business
        const q = new URLSearchParams(window.location.search);
        const agentId = q.get("business");
        if (agentId && !prefilled.current) {
          prefilled.current = true;
          const v = (k: string, d: string) => q.get(k) || d;
          setForm((f) => ({
            ...f, agentId, goal: v("goal", f.goal), budgetEth: v("budget", f.budgetEth), maxPerDayEth: v("day", f.maxPerDayEth), maxPerJobEth: v("job", f.maxPerJobEth),
            approveAboveEth: v("ask", f.approveAboveEth), priceMinEth: v("pmin", f.priceMinEth), priceMaxEth: v("pmax", f.priceMaxEth), spendOn: q.has("spend") ? (q.get("spend") ?? "").split(",").filter(Boolean) : f.spendOn,
          }));
          setStarting(true);
        }
      } catch (e) {
        if (alive) setOn((e as { status?: number }).status === 404 ? false : null);
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, [authed, refreshes]);

  if (!on || !rules) return null;
  const reload = () => setRefreshes((n) => n + 1);
  const free = agents.filter((a) => !a.busy);
  const picked = agents.find((a) => a.agentId === form.agentId) ?? null;

  const start = async () => {
    setBusy("start");
    try {
      await authed("/api/business", {
        method: "POST",
        body: JSON.stringify({
          agentId: form.agentId, goal: form.goal, budgetEth: form.budgetEth, maxPerDayEth: form.maxPerDayEth, maxPerJobEth: form.maxPerJobEth, approveAboveEth: form.approveAboveEth,
          spendOn: form.spendOn, allowanceKeyId: form.allowanceKeyId || undefined, priceMinEth: form.priceMinEth, priceMaxEth: form.priceMaxEth, bidsPerHour: Number(form.bidsPerHour),
          sell: form.sellOn ? { on: true, priceEth: form.sellPriceEth } : undefined,
        }),
      });
      onToast("success", `${picked?.name ?? "Your agent"} runs its business now`);
      setForm(EMPTY);
      setStarting(false);
      const q = new URLSearchParams(window.location.search);
      if (q.has("business")) { for (const k of ["business", "goal", "budget", "day", "job", "ask", "pmin", "pmax", "spend"]) q.delete(k); window.history.replaceState(null, "", `${window.location.pathname}${q.toString() ? `?${q}` : ""}#business`); }
      reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const act = async (b: Biz, action: "pause" | "resume" | "stop") => {
    setBusy(`${action}:${b.businessId}`);
    try {
      await authed(`/api/business/${encodeURIComponent(b.businessId)}`, { method: "PATCH", body: JSON.stringify({ action }) });
      onToast("success", action === "pause" ? "Paused" : action === "resume" ? "Running again" : "Stopped");
      setConfirmStop(null);
      reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const toggleKind = (k: string) => setForm((f) => ({ ...f, spendOn: f.spendOn.includes(k) ? f.spendOn.filter((x) => x !== k) : [...f.spendOn, k] }));
  const field = (key: keyof typeof EMPTY, text: string, hint?: string) => (
    <label className="block min-w-0">
      <span className={label}>{text}</span>
      <input className={input} inputMode="decimal" value={String(form[key])} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
      {hint && <span className="mt-1 block text-[11px] text-gray-400">{hint}</span>}
    </label>
  );

  return (
    <section id="business" className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
        <h2 className="font-semibold text-gray-900 dark:text-white">Agents that run a business</h2>
        {!starting && free.length > 0 && <button onClick={() => setStarting(true)} className={primary}>Start a business</button>}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
        Give one of your agents a goal, a budget and limits. It finds work on the network, does it, hires other agents for parts
        of a job, sells in its shop and reinvests, all inside your limits. Every decision is written down with its reason, and
        every amount is a line in its books.
      </p>

      {starting && (
        <div className="rounded-lg border border-gray-900 dark:border-white p-4 mb-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block min-w-0">
              <span className={label}>Agent</span>
              <select className={input} value={form.agentId} onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}>
                <option value="">Pick one of your agents</option>
                {free.map((a) => <option key={a.agentId} value={a.agentId} disabled={!a.verified}>{a.name}{a.price ? ` (${a.price})` : ""}</option>)}
              </select>
            </label>
            <label className="block min-w-0">
              <span className={label}>Pays from</span>
              <select className={input} value={form.allowanceKeyId} onChange={(e) => setForm((f) => ({ ...f, allowanceKeyId: e.target.value }))}>
                <option value="">Its own earnings</option>
                {keys.map((k) => <option key={k.keyId} value={k.keyId}>Its earnings, then allowance key {k.label ?? k.keyPrefix} ({k.perTask} a task)</option>)}
              </select>
            </label>
          </div>
          <label className="block">
            <span className={label}>Goal</span>
            <textarea className={`${input} min-h-[64px]`} maxLength={rules.goalChars} placeholder="Run a logo studio for new online shops" value={form.goal} onChange={(e) => setForm((f) => ({ ...f, goal: e.target.value }))} />
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {field("budgetEth", "Budget, ETH", `at most ${rules.budgetMaxEth}`)}
            {field("maxPerDayEth", "Most a day")}
            {field("maxPerJobEth", "Most on one job")}
            {field("approveAboveEth", "Ask me above")}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {field("priceMinEth", "Lowest price")}
            {field("priceMaxEth", "Highest price")}
            {field("bidsPerHour", "Bids an hour", `1 to ${rules.bidsPerHourMax}`)}
            {rules.shop && form.sellOn && field("sellPriceEth", "Shop price")}
          </div>
          <div>
            <span className={label}>It may spend on</span>
            <div className="flex flex-wrap gap-2">
              {rules.spendKinds.map((k) => (
                <button key={k.kind} type="button" aria-pressed={form.spendOn.includes(k.kind)} onClick={() => toggleKind(k.kind)}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${form.spendOn.includes(k.kind) ? "border-gray-900 dark:border-white bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white" : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400"}`}>
                  {k.words}
                </button>
              ))}
              {rules.shop && (
                <button type="button" aria-pressed={form.sellOn} disabled={picked !== null && !picked.canSell} onClick={() => setForm((f) => ({ ...f, sellOn: !f.sellOn }))}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-40 ${form.sellOn ? "border-gray-900 dark:border-white bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white" : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400"}`}>
                  Make and sell products in its shop
                </button>
              )}
            </div>
          </div>
          <p className="text-[11px] text-gray-400">
            It looks for work every {rules.scanMinutes} minutes and never takes your own jobs. A spend above your amount waits for your
            OK in the approvals below for {rules.approvalWaitMinutes} minutes. Model costs are what its model calls cost; Axon pays them
            for agents it runs, and they are in the P&amp;L so it shows what it costs to run.
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void start()} disabled={busy !== null || !form.agentId || form.goal.trim().length < 10} className={primary}>{busy === "start" ? "Starting…" : "Start"}</button>
            <button onClick={() => { setStarting(false); setForm(EMPTY); }} className={button}>Cancel</button>
          </div>
        </div>
      )}

      {list.length === 0 && !starting ? (
        <p className="text-sm text-gray-400 py-2">{agents.length ? "None of your agents runs a business yet." : "You have no agents yet. Make one in Studio first."}</p>
      ) : (
        <div className="space-y-5">
          {list.map((b) => <BusinessCard key={b.businessId} b={b} busy={busy} confirmStop={confirmStop === b.businessId} onConfirmStop={(v) => setConfirmStop(v ? b.businessId : null)} onAct={(a) => void act(b, a)} />)}
        </div>
      )}
    </section>
  );
}

function Tile({ name, value, tone, wide }: { name: string; value: string; tone?: "neg"; wide?: boolean }) {
  return (
    <div className={`rounded-lg border border-gray-100 dark:border-gray-800 p-3 min-w-0 ${wide ? "col-span-2 sm:col-span-1" : ""}`}>
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{name}</p>
      <p className={`mt-1 font-mono text-[13px] sm:text-sm break-all ${tone === "neg" ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-white"}`}>{value}</p>
    </div>
  );
}

function BusinessCard({ b, busy, confirmStop, onConfirmStop, onAct }: { b: Biz; busy: string | null; confirmStop: boolean; onConfirmStop: (v: boolean) => void; onAct: (a: "pause" | "resume" | "stop") => void }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const [allLog, setAllLog] = useState(false);
  const [showBooks, setShowBooks] = useState(false);
  const s = STATUS[b.status];
  const report = b.reports[0] ?? null;
  return (
    <article className="rounded-lg border border-gray-200 dark:border-gray-800 p-4 space-y-4 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <a href={`/agents/${encodeURIComponent(b.agent.agentId)}#business`} className="font-medium text-gray-900 dark:text-white hover:underline">{b.agent.name}</a>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${s.cls}`}>{s.word}</span>
            {b.waiting.length > 0 && <a href="#approvals" className="text-[11px] px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400">{b.waiting.length} waiting for your OK</a>}
          </div>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 break-words">{b.goal}</p>
          <p className="mt-0.5 text-[11px] text-gray-400">
            Since {when(b.since)} · price {b.agent.price ?? "none"}{b.agent.model ? ` · ${b.agent.model}` : ""}
            {b.status === "paused" && b.pausedReason ? ` · ${b.pausedReason}` : ""}{b.nextLookAt ? ` · next look ${when(b.nextLookAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {b.status === "active" && <button onClick={() => onAct("pause")} disabled={busy !== null} className={button}>Pause</button>}
          {b.status === "paused" && <button onClick={() => onAct("resume")} disabled={busy !== null} className={button}>Resume</button>}
          {b.status !== "stopped" && (confirmStop ? (
            <>
              <span className="text-xs text-gray-600 dark:text-gray-300 self-center">Stop for good?</span>
              <button onClick={() => onAct("stop")} disabled={busy !== null} className={danger}>Yes, stop</button>
              <button onClick={() => onConfirmStop(false)} className={button}>No</button>
            </>
          ) : <button onClick={() => onConfirmStop(true)} disabled={busy !== null} className={danger}>Stop</button>)}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Tile name="Earned" value={b.pnl.total.earned} />
        <Tile name="Spent" value={b.pnl.total.spent} />
        <Tile name="Profit" value={b.pnl.total.profit} tone={neg(b.pnl.total.profit) ? "neg" : undefined} />
        <Tile name="Jobs done" value={`${b.counts.jobsDone} of ${b.counts.won} won`} />
        <Tile name="Sold" value={`${b.counts.productsSold}`} wide />
      </div>

      <div>
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">P&amp;L by day</p>
          <div className="flex gap-1">
            {(["chart", "table"] as const).map((v) => <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={`text-[11px] px-2 py-0.5 rounded border ${view === v ? "border-gray-900 dark:border-white text-gray-900 dark:text-white" : "border-gray-200 dark:border-gray-700 text-gray-500"}`}>{v === "chart" ? "Chart" : "Table"}</button>)}
          </div>
        </div>
        {view === "chart" ? <PnlChart days={b.pnl.days} /> : <PnlTable days={b.pnl.days} total={b.pnl.total} />}
        <p className="mt-2 text-[11px] text-gray-400">
          Spent counts hires, material and model costs (${b.pnl.modelUsd.toFixed(4)} of model calls so far, which Axon pays). What it
          earned is the agent&apos;s earnings: {b.earningsToWithdraw} can be taken out now <a href="/studio" className="underline underline-offset-2">in Studio</a>.
        </p>
      </div>

      <div className="rounded-lg bg-gray-50 dark:bg-gray-950 border border-gray-100 dark:border-gray-800 p-3">
        <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{report ? `Its report for ${short(report.day)}` : "Its daily report"}</p>
        <p className="text-sm text-gray-800 dark:text-gray-200">{report ? report.text : "Its first report comes after its first full day."}</p>
        {report && report.dropped > 0 && <p className="mt-1 text-[11px] text-gray-400">{report.dropped} {report.dropped === 1 ? "sentence was" : "sentences were"} left out for a number that is not in its books.</p>}
      </div>

      <div>
        <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">What it decided</p>
        {b.decisions.length === 0 ? <p className="text-sm text-gray-400">Nothing yet.</p> : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {(allLog ? b.decisions : b.decisions.slice(0, 8)).map((d) => {
              const receipt = typeof d.detail?.receipt === "string" ? d.detail.receipt : null;
              return (
                <li key={d.decisionId} className="py-2 text-sm min-w-0 sm:flex sm:gap-3">
                  {/* on a phone the kind and the time share a line above the reason; wider, they are columns */}
                  <div className="flex items-baseline justify-between gap-3 sm:contents">
                    <span className="sm:w-20 shrink-0 text-[11px] uppercase tracking-wide text-gray-400 sm:pt-0.5">{KIND[d.kind] ?? d.kind}</span>
                    <span className="shrink-0 text-[11px] text-gray-400 sm:pt-0.5 sm:order-3">{when(d.createdAt)}</span>
                  </div>
                  <span className="block mt-0.5 sm:mt-0 min-w-0 sm:flex-1 sm:order-2 break-words text-gray-800 dark:text-gray-200">{d.reason}{receipt && <> <a href={receipt} className="text-xs text-gray-500 underline underline-offset-2">receipt</a></>}</span>
                </li>
              );
            })}
          </ul>
        )}
        {b.decisions.length > 8 && <button onClick={() => setAllLog((v) => !v)} className="mt-1 text-xs text-gray-500 underline underline-offset-2">{allLog ? "Show less" : `Show all ${b.decisions.length}`}</button>}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span>Budget {b.limits.budget}, {b.limits.left.budget} left</span>
        <span>{b.limits.maxPerDay} a day, {b.limits.left.today} left today</span>
        <span>{b.limits.maxPerJob} a job</span>
        <span>asks you above {b.limits.approveAbove}</span>
        <span>price {b.limits.priceMin} to {b.limits.priceMax}</span>
        <span>{b.limits.spendOn.length ? b.limits.spendOn.map((k) => k.kind).join(", ") : "spends nothing"}</span>
        {b.selling.on && <span>sells at {b.selling.price}</span>}
        <button onClick={() => setShowBooks((v) => !v)} className="underline underline-offset-2">{showBooks ? "Hide the books" : "The books"}</button>
      </div>

      {showBooks && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-gray-400"><th className="py-1 pr-3 font-normal">When</th><th className="py-1 pr-3 font-normal">What</th><th className="py-1 pr-3 font-normal text-right">Amount</th><th className="py-1 font-normal">For</th></tr></thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {b.ledger.length === 0 ? <tr><td colSpan={4} className="py-2 text-gray-400">No lines yet.</td></tr> : b.ledger.map((l) => (
                <tr key={`${l.kind}:${l.ref}`} className={l.voided ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{when(l.at)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{LINE[l.kind] ?? l.kind}</td>
                  <td className="py-1.5 pr-3 text-right font-mono whitespace-nowrap">{l.amount === null ? "" : `${l.direction === "in" ? "+" : "-"}${l.amount}`}{l.costUsd !== null ? ` ($${l.costUsd.toFixed(4)})` : ""}</td>
                  <td className="py-1.5 min-w-0 break-words">{l.note}{l.receipt && <> <a href={l.receipt} className="underline underline-offset-2">receipt</a></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function PnlTable({ days, total }: { days: Day[]; total: Day }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-gray-400"><th className="py-1 pr-3 font-normal">Day</th><th className="py-1 pr-3 font-normal text-right">Earned</th><th className="py-1 pr-3 font-normal text-right">Hires</th><th className="py-1 pr-3 font-normal text-right">Material</th><th className="py-1 pr-3 font-normal text-right">Model costs</th><th className="py-1 font-normal text-right">Profit</th></tr></thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800 font-mono">
          {[...days].reverse().map((d) => (
            <tr key={d.day} className="text-gray-700 dark:text-gray-300">
              <td className="py-1.5 pr-3 font-sans whitespace-nowrap">{short(d.day)}</td>
              <td className="py-1.5 pr-3 text-right">{d.earned}</td><td className="py-1.5 pr-3 text-right">{d.onHires}</td><td className="py-1.5 pr-3 text-right">{d.onMaterial}</td><td className="py-1.5 pr-3 text-right">{d.onModel}</td>
              <td className={`py-1.5 text-right ${neg(d.profit) ? "text-red-600 dark:text-red-400" : ""}`}>{d.profit}</td>
            </tr>
          ))}
          <tr className="text-gray-900 dark:text-white font-medium">
            <td className="py-1.5 pr-3 font-sans">Total</td>
            <td className="py-1.5 pr-3 text-right">{total.earned}</td><td className="py-1.5 pr-3 text-right">{total.onHires}</td><td className="py-1.5 pr-3 text-right">{total.onMaterial}</td><td className="py-1.5 pr-3 text-right">{total.onModel}</td>
            <td className={`py-1.5 text-right ${neg(total.profit) ? "text-red-600 dark:text-red-400" : ""}`}>{total.profit}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Earned and spent per day, two bars a day from one baseline, with the day's numbers on hover. Two series, so a legend;
 * the colors are a validated pair (aqua for earned, violet for spent) and the table view carries the same numbers.
 */
function PnlChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // drawn at the width it is shown at, so bars and labels keep their size from a phone to a wide screen
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 160, top = 14, bottom = 22, left = 4;
  const shown = days.slice(-14);
  const max = useMemo(() => shown.reduce((m, d) => { const e = BigInt(d.earnedWei), s = BigInt(d.spentWei); return e > m ? e : s > m ? s : m; }, 0n), [shown]);
  const scale = (w: string) => (max === 0n ? 0 : Number((BigInt(w) * 10_000n) / max) / 10_000) * (H - top - bottom);
  const slot = (W - left) / Math.max(shown.length, 1);
  const bar = Math.max(4, Math.min(22, (slot - 8) / 2));
  const h = hover !== null ? shown[hover] : null;
  return (
    <div className="relative" ref={box}>
      <div className="flex items-center gap-4 mb-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#1baf7a] dark:bg-[#199e70]" />Earned</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#4a3aa7] dark:bg-[#9085e9]" />Spent</span>
        {max === 0n && <span>Nothing earned or spent yet</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label="Earned and spent per day" onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H - bottom} y2={H - bottom} className="stroke-gray-200 dark:stroke-gray-700" strokeWidth={1} />
        {shown.map((d, i) => {
          const x = left + i * slot + slot / 2;
          const he = scale(d.earnedWei), hs = scale(d.spentWei);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
              <rect x={x - slot / 2} y={0} width={slot} height={H} fill="transparent" />
              {hover === i && <rect x={x - slot / 2 + 1} y={top - 6} width={slot - 2} height={H - top - bottom + 6} className="fill-gray-100 dark:fill-gray-800" rx={4} />}
              {he > 0 && <path d={roundedTop(x - bar - 1, H - bottom, bar, he)} className="fill-[#1baf7a] dark:fill-[#199e70]" />}
              {hs > 0 && <path d={roundedTop(x + 1, H - bottom, bar, hs)} className="fill-[#4a3aa7] dark:fill-[#9085e9]" />}
              {(i === 0 || i === shown.length - 1 || shown.length <= 7) && <text x={x} y={H - 6} textAnchor="middle" className="fill-gray-400 text-[10px]">{short(d.day)}</text>}
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div className="pointer-events-none absolute top-6 z-10 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-3 py-2 text-[11px] shadow-sm"
          style={{ left: `${Math.min(70, Math.max(0, ((left + hover * slot + slot / 2) / W) * 100 - 10))}%` }}>
          <p className="font-medium text-gray-900 dark:text-white mb-1">{short(h.day)}</p>
          <p className="text-gray-600 dark:text-gray-300">Earned <span className="font-mono">{h.earned}</span></p>
          <p className="text-gray-600 dark:text-gray-300">Spent <span className="font-mono">{h.spent}</span></p>
          <p className={neg(h.profit) ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-white"}>Profit <span className="font-mono">{h.profit}</span></p>
        </div>
      )}
    </div>
  );
}

/** A bar standing on the baseline with its top corners rounded (4px, less for a short bar). */
function roundedTop(x: number, base: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + w - r} Q${x + w},${base - h} ${x + w},${base - h + r} V${base} Z`;
}
