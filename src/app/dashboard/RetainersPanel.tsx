"use client";
// Retainers, on the dashboard: agents on a schedule, paid from the allowance. Set one up, see when it
// runs next, read what each run returned, and pause, resume or cancel.
//
// Nothing here signs anything: every run pays from the allowance above, inside its limits. All of it
// goes through /api/retainers with the owner's key.

import { useCallback, useEffect, useRef, useState } from "react";
import { INTERVAL_HOURS } from "@/lib/retainerPolicy";

type Schedule =
  | { kind: "interval"; everyHours: number }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; day: number; time: string; timeZone: string };

interface Retainer {
  retainerId: string;
  agentId: string;
  instructions: string;
  schedule: Schedule;
  scheduleText: string;
  payIn: "ETH" | "AXON";
  maxPrice: string;
  maxPerDay: string;
  status: "active" | "paused" | "ended" | "cancelled";
  pauseText: string | null;
  runsDone: number;
  maxRuns: number | null;
  endsAt: string | null;
  nextRunAt: string | null;
  createdByKey: boolean;
  keyExpiresAt?: string | null;
  webhook: { url: string; active: boolean; failuresInARow: number } | null;
}

interface Run {
  runId: string;
  scheduledFor: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  message: string | null;
  output: string | null;
  price: string | null;
  receiptUrl: string | null;
}

interface Limits {
  tier: string;
  active: number;
  inUse: number;
  fastestHours: number;
  next: { tier: string; hold: number; active: number; fastestHours: number } | null;
}

interface AgentLite {
  agentId: string;
  name: string;
  price?: string;
  acceptsAxon?: boolean;
  retainerDiscountBps?: number;
}

const input =
  "w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500";
const button =
  "text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const label = "block text-[11px] uppercase tracking-wide text-gray-400 mb-1";

const STATUS_STYLE: Record<Retainer["status"], string> = {
  active: "border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400",
  paused: "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400",
  ended: "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300",
  cancelled: "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300",
};
const RUN_STYLE: Record<Run["status"], string> = {
  pending: "text-gray-500 dark:text-gray-400",
  running: "text-blue-600 dark:text-blue-400",
  completed: "text-green-700 dark:text-green-400",
  failed: "text-red-700 dark:text-red-400",
  skipped: "text-amber-700 dark:text-amber-400",
};
const RUN_WORD: Record<Run["status"], string> = {
  pending: "starting",
  running: "working",
  completed: "done",
  failed: "failed",
  skipped: "skipped",
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The clock, read outside render: in handlers and timers, never while rendering. */
const clock = () => Date.now();

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** "in 3h 12m", "in 40s", "now". */
function countdown(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 30_000) return "any moment";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.round(h / 24)} days`;
}

const ethOf = (price?: string) => {
  const m = price?.match(/^([\d.]+)\s*ETH$/i);
  return m ? Number(m[1]) : null;
};

export default function RetainersPanel({
  apiKey,
  onToast,
}: {
  apiKey: string;
  onToast: (type: "success" | "error", message: string) => void;
}) {
  const [retainers, setRetainers] = useState<Retainer[] | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [allowancePerDay, setAllowancePerDay] = useState<number | null>(null);
  const [allowanceExpiry, setAllowanceExpiry] = useState<Record<string, string | null>>({});
  const [runs, setRuns] = useState<Record<string, Run[]>>({});
  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const [now, setNow] = useState(0);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ retainerId: string; secret: string } | null>(null);
  const [hookUrl, setHookUrl] = useState<Record<string, string>>({});
  const prefilled = useRef(false);
  const [zones, setZones] = useState<string[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);

  // the form
  const [agentId, setAgentId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<Schedule["kind"]>("daily");
  const [everyHours, setEveryHours] = useState(4);
  const [time, setTime] = useState("08:00");
  const [day, setDay] = useState(1);
  const [timeZone, setTimeZone] = useState("UTC");
  const [payIn, setPayIn] = useState<"ETH" | "AXON">("ETH");
  const [maxPrice, setMaxPrice] = useState("");
  const [maxRuns, setMaxRuns] = useState("");

  const authed = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
      return body;
    },
    [apiKey],
  );
  const load = useCallback(() => setRefreshes((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [r, a, st] = await Promise.all([
          authed("/api/retainers"),
          fetch("/api/agents?limit=500").then((x) => x.json()).catch(() => ({ agents: [] })),
          authed("/api/allowance").catch(() => ({ enabled: false })),
        ]);
        if (!alive) return;
        setRetainers((r as { retainers: Retainer[] }).retainers);
        setLimits((r as { limits?: Limits }).limits ?? null);
        setAgents(((a as { agents: AgentLite[] }).agents ?? []).filter((x) => (ethOf(x.price) ?? 0) > 0).sort((x, y) => x.name.localeCompare(y.name)));
        const accounts = (st as { enabled: boolean; accounts?: { token: string; configured: boolean; maxPerDay: string; expiresAt: string | null }[] }).accounts ?? [];
        const eth = accounts.find((x) => x.token === "ETH");
        setAllowancePerDay(eth?.configured ? Number(eth.maxPerDay) : null);
        setAllowanceExpiry(Object.fromEntries(accounts.filter((x) => x.configured).map((x) => [x.token, x.expiresAt])));
        setNow(clock());
        // Arrived from an agent's "Retain" button: open the form with that agent chosen, once.
        const retain = new URLSearchParams(window.location.search).get("retain");
        if (retain && !prefilled.current) {
          prefilled.current = true;
          setAgentId(retain);
          setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
          setCreating(true);
          window.setTimeout(() => document.getElementById("retainers")?.scrollIntoView({ behavior: "smooth" }), 100);
        }
      } catch {
        if (alive) setRetainers([]);
      }
    })();
    return () => { alive = false; };
  }, [authed, refreshes]);

  // The countdowns tick; the list refreshes every minute so finished runs and next slots move on.
  useEffect(() => {
    const tick = setInterval(() => setNow(clock()), 30_000);
    const refresh = setInterval(load, 60_000);
    return () => { clearInterval(tick); clearInterval(refresh); };
  }, [load]);

  const openForm = () => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    // Every zone the browser knows, as suggestions; the server checks whatever is typed.
    try {
      setZones((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []);
    } catch {
      setZones([]);
    }
    setCreating(true);
  };

  if (retainers === null) return null;

  const chosen = agents.find((a) => a.agentId === agentId);
  const chosenPrice = ethOf(chosen?.price);
  const priceCeiling = Number(maxPrice) > 0 ? Number(maxPrice) : chosenPrice ? chosenPrice * 1.25 : null;
  const runsPerDay = kind === "interval" ? Math.ceil(24 / everyHours) : 1;
  const perDay = priceCeiling !== null ? priceCeiling * runsPerDay : null;
  const overAllowance = perDay !== null && allowancePerDay !== null && perDay > allowancePerDay;
  const full = limits !== null && limits.inUse >= limits.active;
  const every = (h: number) => (h === 1 ? "hour" : `${h} hours`);

  async function act(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await fn();
      onToast("success", done);
      load();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const schedule: Schedule =
      kind === "interval" ? { kind, everyHours } : kind === "daily" ? { kind, time, timeZone } : { kind, day, time, timeZone };
    await act(
      "create",
      () =>
        authed("/api/retainers", {
          method: "POST",
          body: JSON.stringify({
            agentId,
            instructions,
            schedule,
            payIn,
            ...(maxPrice.trim() ? { maxPrice: maxPrice.trim() } : {}),
            ...(maxRuns.trim() ? { maxRuns: Number(maxRuns) } : {}),
          }),
        }),
      "Retainer created",
    );
    setCreating(false);
    setInstructions("");
    setMaxPrice("");
    setMaxRuns("");
  }

  async function showRuns(id: string) {
    if (openRuns === id) return setOpenRuns(null);
    setOpenRuns(id);
    try {
      const body = (await authed(`/api/retainers/${id}/runs?limit=20`)) as { runs: Run[] };
      setRuns((r) => ({ ...r, [id]: body.runs }));
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Could not load runs");
    }
  }

  async function setWebhook(id: string) {
    const url = (hookUrl[id] ?? "").trim();
    if (!url) return onToast("error", "Enter the URL to send results to");
    setBusy(`hook:${id}`);
    try {
      const body = (await authed(`/api/retainers/${id}/webhook`, { method: "PUT", body: JSON.stringify({ url }) })) as { secret: string };
      setSecret({ retainerId: id, secret: body.secret });
      load();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Could not set the webhook");
    } finally {
      setBusy(null);
    }
  }

  const live = retainers.filter((r) => r.status === "active" || r.status === "paused");
  // Retainers stop paying when the allowance behind them expires. Say so a week ahead, not after.
  const WEEK = 7 * 86_400_000;
  const soon = (iso: string | null | undefined) => !!iso && now > 0 && Date.parse(iso) - now < WEEK;
  const expiring = [...new Set(live.filter((r) => r.status === "active").map((r) => r.payIn))]
    .map((token) => ({ token, at: allowanceExpiry[token] }))
    .filter((x) => soon(x.at));
  const past = retainers.filter((r) => r.status === "ended" || r.status === "cancelled");

  return (
    <section id="retainers" className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-semibold text-gray-900 dark:text-white">Retainers</h2>
        {!creating && <button onClick={openForm} disabled={full} className={button}>New retainer</button>}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Agents on a schedule. Set it once and Axon hires the agent every time it comes round, paid from your allowance and
        inside its limits. Failed runs cost nothing.
      </p>

      {limits && (
        <p className={`mb-4 text-xs ${full ? "text-amber-800 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}`}>
          <span className="capitalize">{limits.tier}</span> tier: {limits.inUse} of {limits.active} retainers in use, every{" "}
          {every(limits.fastestHours)} at most.
          {full && " Cancel one to make room."}
          {limits.next && (
            <>
              {" "}Hold {limits.next.hold.toLocaleString("en-US")} $AXON for {limits.next.active}
              {limits.next.fastestHours < limits.fastestHours ? (limits.next.fastestHours === 1 ? ", hourly" : `, every ${every(limits.next.fastestHours)}`) : ""}.{" "}
              <a href="/tier" className="underline underline-offset-2">Tiers</a>
            </>
          )}
        </p>
      )}

      {allowancePerDay === null && (
        <p className="mb-4 text-xs rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400 p-3">
          Retainers pay from your allowance. Set one up above first, or every run will be refused.
        </p>
      )}

      {expiring.map((x) => (
        <p key={x.token} className="mb-4 text-xs rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400 p-3">
          {Date.parse(x.at!) <= now
            ? `Your ${x.token === "AXON" ? "$AXON " : ""}allowance has expired, so retainers paying from it are paused. Extend it above, then resume them.`
            : `Your ${x.token === "AXON" ? "$AXON " : ""}allowance expires ${when(x.at!)}. Retainers stop paying then: extend it above to keep them running.`}
        </p>
      ))}

      {creating && (
        <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-4 mb-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="ret-agent">Agent</label>
              <select id="ret-agent" value={agentId} onChange={(e) => { setAgentId(e.target.value); setPayIn("ETH"); }} className={input}>
                <option value="">Choose a paid agent…</option>
                {agents.map((a) => (
                  <option key={a.agentId} value={a.agentId}>{a.name} · {a.price}{a.retainerDiscountBps ? ` · ${a.retainerDiscountBps / 100}% off` : ""}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="ret-pay">Pay in</label>
              <select id="ret-pay" value={payIn} onChange={(e) => setPayIn(e.target.value as "ETH" | "AXON")} className={input}>
                <option value="ETH">ETH</option>
                {chosen?.acceptsAxon && <option value="AXON">$AXON</option>}
              </select>
            </div>
          </div>

          <div>
            <label className={label} htmlFor="ret-instructions">What it does each run</label>
            <textarea id="ret-instructions" rows={3} maxLength={32000} placeholder="e.g. Summarise overnight moves in NVDA, SPY and ETH, and flag anything over 3%." value={instructions} onChange={(e) => setInstructions(e.target.value)} className={input} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className={label} htmlFor="ret-kind">Runs</label>
              <select id="ret-kind" value={kind} onChange={(e) => setKind(e.target.value as Schedule["kind"])} className={input}>
                <option value="interval">Every few hours</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
              </select>
            </div>
            {kind === "interval" ? (
              <div>
                <label className={label} htmlFor="ret-hours">Every</label>
                <select id="ret-hours" value={everyHours} onChange={(e) => setEveryHours(Number(e.target.value))} className={input}>
                  {INTERVAL_HOURS.map((h) => {
                    const tooFast = limits !== null && h < limits.fastestHours;
                    return <option key={h} value={h} disabled={tooFast}>{every(h)}{tooFast ? " (holders)" : ""}</option>;
                  })}
                </select>
              </div>
            ) : (
              <>
                {kind === "weekly" && (
                  <div>
                    <label className={label} htmlFor="ret-day">On</label>
                    <select id="ret-day" value={day} onChange={(e) => setDay(Number(e.target.value))} className={input}>
                      {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={label} htmlFor="ret-time">At</label>
                  <input id="ret-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} />
                </div>
                <div className={kind === "daily" ? "col-span-2" : "col-span-2 sm:col-span-1"}>
                  <label className={label} htmlFor="ret-tz">Time zone</label>
                  <input id="ret-tz" list="ret-tz-list" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} className={input} />
                  <datalist id="ret-tz-list">
                    {zones.map((z) => <option key={z} value={z} />)}
                  </datalist>
                </div>
              </>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="ret-max">Most per run (ETH)</label>
              <input id="ret-max" inputMode="decimal" placeholder={chosenPrice ? String(+(chosenPrice * 1.25).toPrecision(6)) : "auto"} value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className={input} />
            </div>
            <div>
              <label className={label} htmlFor="ret-runs">Stop after (runs)</label>
              <input id="ret-runs" inputMode="numeric" placeholder="never" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} className={input} />
            </div>
          </div>

          {chosen?.retainerDiscountBps && chosenPrice ? (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">
              {chosen.name} takes {chosen.retainerDiscountBps / 100}% off each retainer run: {+(chosenPrice * (1 - chosen.retainerDiscountBps / 10_000)).toPrecision(6)} ETH instead of {chosenPrice}.
            </p>
          ) : null}

          {perDay !== null && (
            <p className={`text-xs ${overAllowance ? "text-red-700 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}>
              At most {+perDay.toPrecision(6)} ETH a day.
              {overAllowance && ` That is over your allowance's daily limit of ${allowancePerDay} ETH, so some runs would be refused.`}
              {" "}A run is skipped, not paid, if the agent&apos;s price rises above your maximum.
            </p>
          )}

          <div className="flex gap-2">
            <button onClick={() => void create()} disabled={busy !== null || !agentId || !instructions.trim()} className={button}>
              {busy === "create" ? "Creating…" : "Create retainer"}
            </button>
            <button onClick={() => setCreating(false)} className={button}>Cancel</button>
          </div>
        </div>
      )}

      {secret && (
        <div className="mb-4 p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-400 mb-2">Webhook signing secret, copy it now, it won&apos;t be shown again</p>
          <div className="flex items-center gap-2">
            <input readOnly value={secret.secret} onFocus={(e) => e.target.select()} className={`${input} font-mono text-xs`} />
            <button onClick={() => { void navigator.clipboard.writeText(secret.secret); onToast("success", "Secret copied"); }} className={button}>Copy</button>
            <button onClick={() => setSecret(null)} className={button}>✕</button>
          </div>
        </div>
      )}

      {live.length === 0 && !creating && (
        <p className="text-sm text-gray-400 py-4">
          No retainers yet. A morning market brief, a wallet check every few hours, a weekly report: set it up once.
        </p>
      )}

      <div className="space-y-3">
        {[...live, ...past].map((r) => (
          <div key={r.retainerId} className="rounded-lg border border-gray-100 dark:border-gray-800 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white break-words">{r.agentId}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {r.scheduleText} · up to {r.maxPrice} ETH a run{r.payIn === "AXON" ? ", paid in $AXON" : ""}
                  {r.createdByKey ? " · set up by a key" : ""}
                  {r.keyExpiresAt && (r.status === "active" || r.status === "paused") && (
                    <span className={soon(r.keyExpiresAt) ? "text-amber-700 dark:text-amber-400" : ""}>
                      {Date.parse(r.keyExpiresAt) <= now ? " (key expired)" : ` (key expires ${when(r.keyExpiresAt)})`}
                    </span>
                  )}
                </p>
              </div>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATUS_STYLE[r.status]}`}>{r.status}</span>
            </div>

            <p className="text-sm text-gray-700 dark:text-gray-300 mt-2 line-clamp-2 break-words">{r.instructions}</p>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400 mt-2">
              {r.status === "active" && r.nextRunAt && <span>Next run {countdown(r.nextRunAt, now)} ({when(r.nextRunAt)})</span>}
              <span>{r.runsDone}{r.maxRuns ? ` of ${r.maxRuns}` : ""} {r.runsDone === 1 && !r.maxRuns ? "run" : "runs"}</span>
              {r.webhook && <span>Webhook {r.webhook.active ? "on" : "switched off after failures"}</span>}
            </div>
            {r.pauseText && <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">{r.pauseText}</p>}

            <div className="flex flex-wrap gap-2 mt-3">
              <button onClick={() => void showRuns(r.retainerId)} className={button}>{openRuns === r.retainerId ? "Hide runs" : "Runs"}</button>
              {r.status === "active" && (
                <button onClick={() => void act(`pause:${r.retainerId}`, () => authed(`/api/retainers/${r.retainerId}/pause`, { method: "POST" }), "Paused")} disabled={busy !== null} className={button}>Pause</button>
              )}
              {r.status === "paused" && (
                <button onClick={() => void act(`resume:${r.retainerId}`, () => authed(`/api/retainers/${r.retainerId}/resume`, { method: "POST" }), "Resumed")} disabled={busy !== null} className={button}>Resume</button>
              )}
              {(r.status === "active" || r.status === "paused") && (
                <button
                  onClick={() => { if (confirm("Cancel this retainer? It will not run again.")) void act(`cancel:${r.retainerId}`, () => authed(`/api/retainers/${r.retainerId}`, { method: "DELETE" }), "Cancelled"); }}
                  disabled={busy !== null}
                  className={button}
                >
                  Cancel
                </button>
              )}
            </div>

            {openRuns === r.retainerId && (
              <div className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3 space-y-3">
                {(r.status === "active" || r.status === "paused") && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input aria-label="Webhook URL" placeholder={r.webhook?.url ?? "Send results to https://…"} value={hookUrl[r.retainerId] ?? ""} onChange={(e) => setHookUrl((h) => ({ ...h, [r.retainerId]: e.target.value }))} className={input} />
                    <div className="flex gap-2">
                      <button onClick={() => void setWebhook(r.retainerId)} disabled={busy !== null} className={button}>{r.webhook ? "Replace" : "Send results"}</button>
                      {r.webhook && (
                        <button onClick={() => void act(`unhook:${r.retainerId}`, () => authed(`/api/retainers/${r.retainerId}/webhook`, { method: "DELETE" }), "Webhook removed")} disabled={busy !== null} className={button}>Stop</button>
                      )}
                    </div>
                  </div>
                )}
                {(runs[r.retainerId] ?? []).length === 0 ? (
                  <p className="text-xs text-gray-400">No runs yet.</p>
                ) : (
                  (runs[r.retainerId] ?? []).map((run) => (
                    <div key={run.runId} className="text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="text-gray-500 dark:text-gray-400">{when(run.scheduledFor)}</span>
                        <span className={RUN_STYLE[run.status]}>
                          {RUN_WORD[run.status]}{run.price ? ` · ${run.price} ETH${run.status === "failed" ? " refunded" : ""}` : ""}
                          {run.receiptUrl && <> · <a href={run.receiptUrl} className="underline">receipt</a></>}
                        </span>
                      </div>
                      {run.output && (
                        <p className="mt-1 text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words line-clamp-6">{run.output}</p>
                      )}
                      {!run.output && run.message && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{run.message}</p>}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
