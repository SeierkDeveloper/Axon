"use client";
// Triggers, on the dashboard: jobs that start themselves. Save an agent and what to ask it, and say what sets it off:
// a call or a file sent to its own address, a contract doing something on chain, or a web page changing. See what each run returned, and
// pause, resume or delete.
//
// It shows nothing at all until the server says triggers are on, so the dashboard is unchanged while they are off.
// Everything goes through /api/triggers with the owner's key.

import { useCallback, useEffect, useState } from "react";

interface Trigger {
  triggerId: string;
  agentId: string;
  name: string;
  kind: "inbound" | "chain" | "page";
  instructions: string;
  url?: string;
  chain?: { address: string | null; topic0: string | null; readUpToBlock: number | null };
  page?: { url: string | null; watch: string | null; everyMinutes: number | null; lookedAt: string | null; changedAt: string | null; changes: number };
  maxPriceEth: string | null;
  maxRunsPerDay: number;
  status: "active" | "paused";
  pauseReason: string | null;
  runsDone: number;
  lastFiredAt: string | null;
}
interface Run {
  runId: string;
  summary: string;
  status: "running" | "completed" | "failed" | "skipped";
  reason: string | null;
  output: string | null;
  priceEth: string | null;
  receiptUrl: string | null;
  at: string;
}
interface Limits { triggers: number; runsPerDay: { default: number; max: number }; freeRunsPerDay: number; page?: { everyMinutes: { min: number; default: number; max: number } } }
interface AgentLite { agentId: string; name: string; price?: string }

const input =
  "w-full rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-gray-400 dark:focus:border-gray-500";
const button =
  "text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const label = "block text-[11px] uppercase tracking-wide text-gray-400 mb-1";
const chip = (on: boolean) =>
  `text-[11px] px-2 py-0.5 rounded-full border ${on ? "border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400" : "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400"}`;
const RUN_TONE: Record<Run["status"], string> = {
  completed: "text-green-700 dark:text-green-400",
  running: "text-gray-500 dark:text-gray-400",
  failed: "text-red-600 dark:text-red-400",
  skipped: "text-amber-700 dark:text-amber-400",
};
const PAUSED: Record<string, string> = {
  owner: "Paused by you.",
  failures: "Paused itself: the payment was refused three times in a row.",
  agent_unavailable: "Paused itself: the agent is not available any more.",
  allowance_expired: "Paused itself: your allowance has expired.",
  page_unreachable: "Paused itself: the page could not be read five times in a row.",
};
/** How often a page is looked at, in words. */
const every = (minutes: number): string => (minutes < 60 ? `${minutes} minutes` : minutes === 60 ? "hour" : minutes < 1440 ? `${+(minutes / 60).toFixed(1)} hours` : minutes === 1440 ? "day" : `${+(minutes / 1440).toFixed(1)} days`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function TriggersPanel({ apiKey, onToast }: { apiKey: string; onToast: (type: "success" | "error", message: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [runs, setRuns] = useState<Record<string, Run[]>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ triggerId: string; url: string; secret: string } | null>(null);
  const [refreshes, setRefreshes] = useState(0);

  // the form
  const [agentId, setAgentId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [kind, setKind] = useState<"inbound" | "chain" | "page">("inbound");
  // a page to watch: its address, the words to watch for on it, and how often to look
  const [pageUrl, setPageUrl] = useState("");
  const [pageWatch, setPageWatch] = useState("");
  const [pageEvery, setPageEvery] = useState("60");
  const [address, setAddress] = useState("");
  const [event, setEvent] = useState<"transfer" | "any">("transfer");
  const [maxPrice, setMaxPrice] = useState("");
  const [perDay, setPerDay] = useState("");

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
    void (async () => {
      try {
        const [t, a] = await Promise.all([authed("/api/triggers"), fetch("/api/agents?limit=500").then((x) => x.json()).catch(() => ({ agents: [] }))]);
        if (!alive) return;
        setTriggers((t as { triggers: Trigger[] }).triggers);
        setLimits((t as { limits: Limits }).limits);
        setAgents(((a as { agents: AgentLite[] }).agents ?? []).sort((x, y) => x.name.localeCompare(y.name)));
        setOn(true);
      } catch (e) {
        // 404 is "not switched on here": show nothing. Anything else is a real failure worth a line.
        if (alive) setOn((e as { status?: number }).status === 404 ? false : null);
      }
    })();
    return () => { alive = false; };
  }, [authed, refreshes]);

  if (!on) return null;
  const reload = () => setRefreshes((n) => n + 1);
  const agent = agents.find((a) => a.agentId === agentId);
  const charges = Boolean(agent?.price);
  const full = limits ? triggers.length >= limits.triggers : false;
  const nameOf = (id: string) => agents.find((a) => a.agentId === id)?.name ?? id;

  const act = async (id: string, what: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await what();
      onToast("success", done);
      reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("new");
    try {
      const made = (await authed("/api/triggers", {
        method: "POST",
        body: JSON.stringify({
          agentId, instructions, kind,
          ...(kind === "chain" ? { chain: { address: address.trim(), event } } : {}),
          ...(kind === "page" ? { page: { url: pageUrl.trim(), ...(pageWatch.trim() ? { watch: pageWatch.trim() } : {}), everyMinutes: Number(pageEvery) } } : {}),
          ...(charges ? { maxPriceEth: maxPrice.trim() } : {}),
          ...(perDay.trim() ? { maxRunsPerDay: Number(perDay) } : {}),
        }),
      })) as { trigger: Trigger; secret?: string };
      if (made.secret && made.trigger.url) setSecret({ triggerId: made.trigger.triggerId, url: made.trigger.url, secret: made.secret });
      onToast("success", "Trigger saved");
      setCreating(false);
      setInstructions(""); setAddress(""); setMaxPrice(""); setPerDay(""); setPageUrl(""); setPageWatch("");
      reload();
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Could not save the trigger");
    } finally {
      setBusy(null);
    }
  };

  const showRuns = async (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    try {
      const d = (await authed(`/api/triggers/${id}`)) as { trigger: Trigger; runs: Run[] };
      setRuns((r) => ({ ...r, [id]: d.runs }));
      // the count in the heading is as fresh as the list under it
      setTriggers((all) => all.map((t) => (t.triggerId === id ? { ...t, ...d.trigger } : t)));
    } catch (e) {
      onToast("error", e instanceof Error ? e.message : "Could not load the runs");
    }
  };

  return (
    <section id="triggers" className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="font-semibold text-gray-900 dark:text-white">Triggers</h2>
        {!creating && <button onClick={() => setCreating(true)} disabled={full} className={button}>New trigger</button>}
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Jobs that start themselves. Save an agent and what to ask it, and it is hired the moment something happens: your
        own system calls it, a file is sent to it, a contract does something on chain, or a web page changes. An agent that charges is paid from
        your allowance.
      </p>
      {limits && (
        <p className={`mb-4 text-xs ${full ? "text-amber-800 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}`}>
          {triggers.length} of {limits.triggers} triggers in use. Agents that do not charge run up to {limits.freeRunsPerDay} times a day across your triggers.
          {full && " Delete one to make room."}
        </p>
      )}

      {secret && (
        <div className="mb-5 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-4 text-xs text-amber-900 dark:text-amber-300 space-y-2">
          <p className="font-medium">Keep this secret now. It is shown once.</p>
          <p className="break-all font-mono">{secret.secret}</p>
          <p>Send it as the <span className="font-mono">X-Trigger-Key</span> header when you call:</p>
          <p className="break-all font-mono">{secret.url}</p>
          <p className="break-all font-mono text-[11px] text-amber-800 dark:text-amber-400">
            curl -X POST {secret.url} -H &quot;X-Trigger-Key: {secret.secret}&quot; -H &quot;content-type: application/json&quot; -d &apos;{"{"}&quot;order&quot;: 1042{"}"}&apos;
          </p>
          <div className="flex gap-2">
            <button onClick={() => { void navigator.clipboard.writeText(secret.secret); onToast("success", "Secret copied"); }} className={button}>Copy secret</button>
            <button onClick={() => { void navigator.clipboard.writeText(secret.url); onToast("success", "Address copied"); }} className={button}>Copy address</button>
            <button onClick={() => setSecret(null)} className={button}>I have it</button>
          </div>
        </div>
      )}

      {creating && (
        <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-4 mb-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="trg-agent">Agent</label>
              <select id="trg-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} className={input}>
                <option value="">Choose an agent…</option>
                {agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.name} · {a.price ?? "free"}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="trg-kind">Starts when</label>
              <select id="trg-kind" value={kind} onChange={(e) => setKind(e.target.value as "inbound" | "chain" | "page")} className={input}>
                <option value="inbound">A call or a file arrives</option>
                <option value="chain">Something happens on chain</option>
                {limits?.page && <option value="page">A web page changes</option>}
              </select>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="trg-task">What to ask it</label>
            <textarea id="trg-task" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} placeholder={kind === "page" ? "Tell me what changed and whether it matters. Open the page if you need more." : kind === "chain" ? "Say in two lines what this transfer is and whether it looks unusual." : "Summarise what arrived and list anything I need to act on."} className={input} />
            <p className="mt-1 text-[11px] text-gray-400">What arrives is added under this as the event. The agent is told it is data, not instructions.</p>
          </div>
          {kind === "page" && limits?.page && (
            <div className="space-y-3">
              <div>
                <label className={label} htmlFor="trg-page">The page to watch</label>
                <input id="trg-page" value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} placeholder="https://example.com/pricing" className={input} inputMode="url" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={label} htmlFor="trg-watch">Words to watch for (optional)</label>
                  <input id="trg-watch" value={pageWatch} onChange={(e) => setPageWatch(e.target.value)} placeholder="Price" className={input} maxLength={120} />
                </div>
                <div>
                  <label className={label} htmlFor="trg-every">Look every</label>
                  <select id="trg-every" value={pageEvery} onChange={(e) => setPageEvery(e.target.value)} className={input}>
                    {[1, 5, 15, 30, 60, 180, 360, 720, 1440].filter((m) => m >= limits.page!.everyMinutes.min && m <= limits.page!.everyMinutes.max).map((m) => (
                      <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 60 ? "hour" : m < 1440 ? `${m / 60} hours` : "day"}</option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-gray-400">
                The page is read in a real browser. With words to watch for, only the lines that mention them count, so a clock or an advert changing does not start a job. The first look only notes how the page is.
              </p>
            </div>
          )}
          {kind === "chain" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="trg-address">Contract on Robinhood Chain</label>
                <input id="trg-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" className={`${input} font-mono`} />
              </div>
              <div>
                <label className={label} htmlFor="trg-event">Which logs</label>
                <select id="trg-event" value={event} onChange={(e) => setEvent(e.target.value as "transfer" | "any")} className={input}>
                  <option value="transfer">Token transfers</option>
                  <option value="any">Every log it writes</option>
                </select>
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {charges && (
              <div>
                <label className={label} htmlFor="trg-max">Most one run may cost, in ETH</label>
                <input id="trg-max" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder={agent?.price?.replace(/\s*ETH$/i, "")} className={input} inputMode="decimal" />
              </div>
            )}
            <div>
              <label className={label} htmlFor="trg-day">Runs a day at most</label>
              <input id="trg-day" value={perDay} onChange={(e) => setPerDay(e.target.value)} placeholder={String(limits?.runsPerDay.default ?? 20)} className={input} inputMode="numeric" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => void create()} disabled={busy === "new" || !agentId || instructions.trim().length < 3 || (kind === "chain" && !address.trim()) || (kind === "page" && pageUrl.trim().length < 4) || (charges && !maxPrice.trim())} className={button}>
              {busy === "new" ? "Saving…" : "Save trigger"}
            </button>
            <button onClick={() => setCreating(false)} className={button}>Cancel</button>
          </div>
        </div>
      )}

      {triggers.length === 0 && !creating && <p className="text-sm text-gray-400">No triggers yet.</p>}

      <div className="space-y-3">
        {triggers.map((t) => (
          <div key={t.triggerId} className="rounded-lg border border-gray-100 dark:border-gray-800 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-sm text-gray-900 dark:text-white">{nameOf(t.agentId)}</p>
              <span className={chip(t.status === "active")}>{t.status === "active" ? "waiting" : "paused"}</span>
              <span className="text-[11px] text-gray-400">{t.kind === "chain" ? "on chain" : t.kind === "page" ? "a page changes" : "call or file"}</span>
              <span className="ml-auto text-[11px] text-gray-400">{t.runsDone} {t.runsDone === 1 ? "run" : "runs"}{t.lastFiredAt ? `, last ${when(t.lastFiredAt)}` : ""}</span>
            </div>
            <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-300 break-words">{t.instructions}</p>
            {t.kind === "inbound" && t.url && <p className="mt-1.5 break-all font-mono text-[11px] text-gray-400">POST {t.url}</p>}
            {t.kind === "chain" && t.chain && (
              <p className="mt-1.5 break-all font-mono text-[11px] text-gray-400">
                {t.chain.topic0 ? "transfers" : "every log"} of {t.chain.address}{t.chain.readUpToBlock !== null ? `, read to block ${t.chain.readUpToBlock.toLocaleString("en-US")}` : ""}
              </p>
            )}
            {t.kind === "page" && t.page && (
              <p className="mt-1.5 break-words text-[11px] text-gray-400">
                Watching <span className="break-all font-mono">{t.page.url}</span>{t.page.watch ? <> for &ldquo;{t.page.watch}&rdquo;</> : null}, every {every(t.page.everyMinutes ?? 60)}.{" "}
                {t.page.lookedAt ? `Last looked ${when(t.page.lookedAt)}` : "Not looked at yet"}{t.page.changedAt ? `, last changed ${when(t.page.changedAt)}` : t.page.lookedAt ? ", no change seen yet" : ""}.
              </p>
            )}
            {t.status === "paused" && <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">{PAUSED[t.pauseReason ?? "owner"] ?? "Paused."}</p>}
            <p className="mt-1.5 text-[11px] text-gray-400">
              Up to {t.maxRunsPerDay} runs a day{t.maxPriceEth ? `, at most ${t.maxPriceEth} ETH each from your allowance` : ", free"}.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => void showRuns(t.triggerId)} className={button}>{open === t.triggerId ? "Hide runs" : "Runs"}</button>
              {t.status === "active" ? (
                <button disabled={busy === t.triggerId} onClick={() => void act(t.triggerId, () => authed(`/api/triggers/${t.triggerId}`, { method: "PATCH", body: JSON.stringify({ action: "pause" }) }), "Paused")} className={button}>Pause</button>
              ) : (
                <button disabled={busy === t.triggerId} onClick={() => void act(t.triggerId, () => authed(`/api/triggers/${t.triggerId}`, { method: "PATCH", body: JSON.stringify({ action: "resume" }) }), "Waiting again")} className={button}>Resume</button>
              )}
              {t.kind === "page" && t.status === "active" && (
                <button
                  disabled={busy === t.triggerId}
                  onClick={() => void (async () => {
                    setBusy(t.triggerId);
                    try {
                      const d = (await authed(`/api/triggers/${t.triggerId}`, { method: "PATCH", body: JSON.stringify({ action: "look" }) })) as { look: { looked: boolean; changed?: boolean; first?: boolean; fired?: boolean; message?: string; reason?: string } };
                      const l = d.look;
                      onToast(l.looked ? "success" : "error", !l.looked ? `The page could not be read: ${l.reason ?? "try again later"}` : l.changed ? l.message ?? "The page changed." : l.first ? "Looked. This is how the page is now; the next change starts the job." : "Looked. Nothing has changed.");
                      reload();
                    } catch (e) {
                      onToast("error", e instanceof Error ? e.message : "Could not look at the page");
                    } finally {
                      setBusy(null);
                    }
                  })()}
                  className={button}
                >
                  {busy === t.triggerId ? "Looking…" : "Look now"}
                </button>
              )}
              {t.kind === "inbound" && (
                <button
                  disabled={busy === t.triggerId}
                  onClick={() => void act(t.triggerId, async () => {
                    const d = (await authed(`/api/triggers/${t.triggerId}`, { method: "PATCH", body: JSON.stringify({ action: "rotate" }) })) as { trigger: Trigger; secret: string };
                    setSecret({ triggerId: t.triggerId, url: d.trigger.url ?? t.url ?? "", secret: d.secret });
                  }, "New secret made. The old one no longer works.")}
                  className={button}
                >
                  New secret
                </button>
              )}
              <button disabled={busy === t.triggerId} onClick={() => { if (window.confirm("Delete this trigger and its list of runs?")) void act(t.triggerId, () => authed(`/api/triggers/${t.triggerId}`, { method: "DELETE" }), "Deleted"); }} className={button}>Delete</button>
            </div>
            {open === t.triggerId && (
              <div className="mt-3 space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3">
                {(runs[t.triggerId] ?? []).length === 0 && <p className="text-xs text-gray-400">It has not fired yet.</p>}
                {(runs[t.triggerId] ?? []).map((r) => (
                  <div key={r.runId} className="text-xs">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className={`font-medium ${RUN_TONE[r.status]}`}>{r.status === "skipped" ? "not run" : r.status}</span>
                      <span className="text-gray-400">{when(r.at)}</span>
                      {r.priceEth && <span className="text-gray-400">{r.priceEth} ETH</span>}
                      {r.receiptUrl && <a href={r.receiptUrl} target="_blank" rel="noopener noreferrer" className="text-teal-600 dark:text-teal-400 hover:underline">receipt</a>}
                    </p>
                    <p className="mt-0.5 break-words text-gray-600 dark:text-gray-300">{r.summary}</p>
                    {r.reason && <p className="mt-0.5 text-gray-500 dark:text-gray-400">{r.reason}</p>}
                    {r.output && <p className="mt-1 whitespace-pre-wrap break-words rounded border border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-950/40 p-2 text-gray-700 dark:text-gray-300 max-h-48 overflow-auto">{r.output}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
