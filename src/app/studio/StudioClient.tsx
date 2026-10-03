"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AgentCore, { type CoreState } from "@/components/AgentCore";
import MarkdownOutput from "@/components/MarkdownOutput";
import { useWallet } from "@/components/WalletProvider";
import Earnings from "./Earnings";
import UseAnywhere from "@/components/UseAnywhere";

// Agent Studio: one sentence in, a tested agent out. The page writes the draft, tests it, grades every answer and
// improves it, and shows each step as it happens: the core reacts, each test fills in as it is graded, the score climbs
// round by round. Then a chat to change anything, which sends the agent back to be tested again.

type Status = "drafting" | "drafted" | "testing" | "improving" | "ready" | "published" | "failed" | "stopped";
interface Draft { name: string; handle: string; description: string; capabilities: string[]; category: string; instructions: string; model: string; tools: string[]; priceEth: number }
interface Build { id: string; sentence: string; status: Status; draft: Draft | null; score: number | null; error: string | null; createdAt: string; updatedAt: string }
interface Result { task: string; lookFor: string; answer: string | null; score: number | null; feedback: string | null }
interface Round { round: number; instructions: string; results: Result[]; score: number | null }
interface Tweak { at: string; request: string; ok: boolean; note: string | null }

const RUNNING: Status[] = ["drafting", "testing", "improving"];
const MIN_PUBLISH_SCORE = 6;
const EXAMPLES = [
  "An agent that turns any earnings call into a five bullet brief for investors",
  "An agent that reviews a smart contract and lists the three riskiest functions",
  "An agent that writes a weekly market recap for BTC, ETH and the top movers",
  "An agent that rewrites a product description to sell better, in under 120 words",
];
const coreState = (s: Status | null, busy: boolean): CoreState =>
  busy ? "drafting" : !s ? "idle" : s === "drafting" ? "drafting" : s === "testing" ? "testing" : s === "improving" ? "improving" : s === "failed" ? "failed" : s === "ready" || s === "published" ? "ready" : "idle";
const statusText: Record<Status, string> = {
  drafting: "Writing the agent", drafted: "Draft ready", testing: "Testing on real tasks", improving: "Improving where it scored low",
  ready: "Tested and ready", published: "Live on Axon", failed: "Could not finish", stopped: "Stopped early",
};

export default function StudioClient() {
  const { apiKey, signIn, busy: walletBusy } = useWallet();
  const [sentence, setSentence] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [current, setCurrent] = useState<{ build: Build; rounds: Round[]; tweaks: Tweak[] } | null>(null);
  const [tweak, setTweak] = useState("");
  const [tweaking, setTweaking] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);
  const [price, setPrice] = useState<string>("");
  const [publishing, setPublishing] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const page = useRef<HTMLDivElement>(null);

  const call = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: T }> => {
    const r = await fetch(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) } });
    return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T };
  }, [apiKey]);

  // the cursor's light on the page: two CSS variables, no renders
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const move = (e: PointerEvent) => { el.style.setProperty("--mx", `${e.clientX}px`); el.style.setProperty("--my", `${e.clientY}px`); };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, []);

  const fetchList = useCallback(() => call<{ builds: Build[] }>("/api/studio/builds").then((r) => (r.ok ? r.body.builds : null)), [call]);
  const loadList = useCallback(async () => {
    if (!apiKey) return;
    const list = await fetchList();
    if (list) setBuilds(list);
  }, [apiKey, fetchList]);
  useEffect(() => {
    if (!apiKey) return;
    let alive = true;
    fetchList().then((list) => { if (alive && list) setBuilds(list); }).catch(() => {});
    return () => { alive = false; };
  }, [apiKey, fetchList]);

  const open_ = useCallback(async (id: string) => {
    const r = await call<{ build: Build; rounds: Round[]; tweaks: Tweak[] }>(`/api/studio/builds/${id}`);
    if (r.ok) setCurrent(r.body);
  }, [call]);

  // while a build runs, follow it closely: every answer shows the moment it is graded
  const running = current ? RUNNING.includes(current.build.status) : false;
  useEffect(() => {
    if (!current || !running) return;
    const id = current.build.id;
    const t = setInterval(() => { void open_(id); }, 1_500);
    return () => clearInterval(t);
  }, [current, running, open_]);
  // and refresh the list when one finishes
  const lastStatus = useRef<Status | null>(null);
  useEffect(() => {
    const s = current?.build.status ?? null;
    if (lastStatus.current && s && RUNNING.includes(lastStatus.current) && !RUNNING.includes(s)) void loadList();
    lastStatus.current = s;
  }, [current?.build.status, loadList]);

  const test = useCallback(async (id: string) => {
    const r = await call<{ build: Build; error?: string }>(`/api/studio/builds/${id}/test`, { method: "POST" });
    if (!r.ok) setError(r.body.error ?? "Testing could not start.");
    await open_(id);
  }, [call, open_]);

  const build = async () => {
    const s = sentence.trim();
    if (!s || creating) return;
    setCreating(true);
    setError(null);
    setCurrent(null);
    try {
      const r = await call<{ build?: Build; error?: string }>("/api/studio/drafts", { method: "POST", body: JSON.stringify({ sentence: s }) });
      if (!r.body.build) { setError(r.body.error ?? "Studio could not start this build."); return; }
      setCurrent({ build: r.body.build, rounds: [], tweaks: [] });
      void loadList();
      // straight on to testing: the sentence is the whole job, the rest is Studio's
      if (r.body.build.status === "drafted") await test(r.body.build.id);
    } finally {
      setCreating(false);
    }
  };

  const publish = async () => {
    if (!current || publishing) return;
    setPublishing(true);
    setError(null);
    const priceEth = Number(price || current.build.draft?.priceEth);
    const r = await call<{ agentId?: string; error?: string }>(`/api/studio/builds/${current.build.id}/publish`, { method: "POST", body: JSON.stringify({ priceEth }) });
    setPublishing(false);
    if (!r.ok || !r.body.agentId) { setError(r.body.error ?? "It could not be published."); return; }
    setLive(r.body.agentId);
    await open_(current.build.id);
    void loadList();
  };

  // /studio?remix=<agent>: arriving from an agent's page, start the copy as soon as the wallet is signed in
  const remixing = useRef(false);
  useEffect(() => {
    if (!apiKey || remixing.current) return;
    const agentId = new URLSearchParams(window.location.search).get("remix");
    if (!agentId) return;
    remixing.current = true;
    void call<{ build?: Build; error?: string }>("/api/studio/remix", { method: "POST", body: JSON.stringify({ agentId }) }).then((r) => {
      window.history.replaceState(null, "", "/studio");
      if (!r.body.build) { setError(r.body.error ?? "That agent could not be remixed."); return; }
      void open_(r.body.build.id);
      void loadList();
    });
  }, [apiKey, call, open_, loadList]);

  const sendTweak = async () => {
    if (!current || !tweak.trim() || tweaking) return;
    setTweaking(true);
    setError(null);
    const r = await call<{ build?: Build; error?: string }>(`/api/studio/builds/${current.build.id}/tweak`, { method: "POST", body: JSON.stringify({ request: tweak.trim() }) });
    setTweaking(false);
    if (!r.ok) { setError(r.body.error ?? "That change could not be made."); await open_(current.build.id); return; }
    setTweak("");
    await open_(current.build.id);
  };

  const b = current?.build ?? null;
  const d = b?.draft ?? null;
  const rounds = current?.rounds ?? [];
  const last = rounds.at(-1) ?? null;
  const best = rounds.reduce<number | null>((m, r) => (r.score !== null && (m === null || r.score > m) ? r.score : m), null);
  const state = coreState(b?.status ?? null, creating);

  return (
    <div ref={page} className="relative min-h-[calc(100vh-4rem)] overflow-hidden">
      <div className="studio-light" aria-hidden />
      <div className="studio-grid pointer-events-none absolute inset-0" aria-hidden />

      <div className="relative z-10 mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[360px_1fr]">
          {/* ── the left: the core, the sentence, your builds ── */}
          <aside className="lg:sticky lg:top-20 lg:self-start">
            <div className="studio-face flex flex-col items-center pt-8 text-center sm:pt-0">
              <AgentCore state={state} size={250} label={b ? statusText[b.status] : "Agent Studio"} />
              <p className="mt-5 text-xs font-mono uppercase tracking-[0.25em] text-gray-400 dark:text-gray-500">Agent Studio</p>
              <h1 className="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">One sentence. A tested agent.</h1>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Axon writes it, tests it on real tasks, grades every answer and improves it before it goes live. Free to build. You set the price and keep what it earns.</p>
            </div>

            {!apiKey ? (
              <button type="button" onClick={() => void signIn()} disabled={walletBusy}
                className="mt-6 w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-60 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                {walletBusy ? "Waiting for your wallet…" : "Sign in with your wallet to build"}
              </button>
            ) : (
              <div className="mt-6">
                <label htmlFor="studio-sentence" className="sr-only">Describe your agent in one sentence</label>
                <textarea id="studio-sentence" value={sentence} onChange={(e) => setSentence(e.target.value.slice(0, 400))}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void build(); }}
                  rows={3} placeholder="An agent that…"
                  className="w-full resize-none rounded-xl border border-gray-200 bg-white/80 px-4 py-3 text-sm text-gray-900 shadow-sm backdrop-blur placeholder:text-gray-400 focus:border-gray-400 focus:outline-none dark:border-gray-800 dark:bg-gray-950/80 dark:text-white" />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {EXAMPLES.map((x) => (
                    <button key={x} type="button" onClick={() => setSentence(x)} className="rounded-full border border-gray-200 px-2.5 py-1 text-[11px] text-gray-500 transition hover:border-gray-400 hover:text-gray-900 dark:border-gray-800 dark:text-gray-400 dark:hover:text-white">
                      {x.replace("An agent that ", "").slice(0, 34)}…
                    </button>
                  ))}
                </div>
                <button type="button" onClick={() => void build()} disabled={creating || sentence.trim().length < 12 || running}
                  className="mt-3 w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                  {creating ? "Writing your agent…" : running ? "Building…" : "Build it"}
                </button>
                {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

                <Earnings apiKey={apiKey} refreshKey={`${builds.length}:${b?.status ?? ""}`} />

                {builds.length > 0 && (
                  <div className="mt-8">
                    <p className="text-xs font-mono uppercase tracking-[0.2em] text-gray-400">Your builds</p>
                    <ul className="mt-2 space-y-1">
                      {builds.slice(0, 8).map((x) => (
                        <li key={x.id}>
                          <button type="button" onClick={() => void open_(x.id)}
                            className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${b?.id === x.id ? "bg-gray-100 dark:bg-gray-900" : "hover:bg-gray-50 dark:hover:bg-gray-900/60"}`}>
                            <span className="truncate text-gray-800 dark:text-gray-200">{x.draft?.name ?? x.sentence}</span>
                            <span className="shrink-0 font-mono text-xs text-gray-400">{x.score !== null ? x.score.toFixed(1) : RUNNING.includes(x.status) ? "…" : x.status === "failed" ? "–" : ""}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </aside>

          {/* ── the right: the build ── */}
          <section className="min-w-0">
            {!b && !creating && (
              <div className="flex h-full min-h-[420px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 p-10 text-center dark:border-gray-800">
                <p className="text-sm text-gray-500 dark:text-gray-400">Describe an agent on the left. Studio writes it, then you watch it get tested and improved here, answer by answer.</p>
                <ol className="mt-6 grid w-full max-w-lg grid-cols-4 gap-2 text-left">
                  {["Written", "Tested", "Improved", "Ready"].map((s, i) => (
                    <li key={s} className="rounded-xl border border-gray-200 p-3 dark:border-gray-800"><span className="font-mono text-xs text-gray-400">0{i + 1}</span><p className="mt-1 text-sm font-semibold text-gray-900 dark:text-white">{s}</p></li>
                  ))}
                </ol>
              </div>
            )}

            {creating && !b && (
              <div className="space-y-3">
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-gray-400">Writing the agent</p>
                <p className="text-lg text-gray-900 dark:text-white">“{sentence.trim()}”</p>
                {[80, 64, 92, 48].map((w, i) => <div key={i} className="h-3 animate-pulse rounded bg-gray-100 dark:bg-gray-900" style={{ width: `${w}%` }} />)}
                <p className="text-sm text-gray-500">Instructions, model, tools and a price, from what similar agents charge. About 20 seconds.</p>
              </div>
            )}

            {b && (
              <div className="space-y-6">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${b.status === "failed" ? "border-red-200 text-red-600 dark:border-red-900 dark:text-red-400" : "border-gray-200 text-gray-700 dark:border-gray-800 dark:text-gray-300"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${RUNNING.includes(b.status) ? "animate-pulse bg-gray-900 dark:bg-white" : b.status === "ready" ? "bg-emerald-500" : b.status === "failed" ? "bg-red-500" : "bg-gray-400"}`} />
                    {statusText[b.status]}
                  </span>
                  {b.error && <span className="text-sm text-gray-500">{b.error}</span>}
                </div>

                {d && (
                  <div className="rounded-2xl border border-gray-200 bg-white/80 p-6 backdrop-blur dark:border-gray-800 dark:bg-gray-950/70">
                    <div className="flex items-start justify-between gap-6">
                      <div className="min-w-0 flex-1">
                        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{d.name}</h2>
                        <p className="mt-1 font-mono text-xs text-gray-400">@{d.handle} · {d.category}</p>
                        <p className="mt-3 max-w-xl text-sm text-gray-600 dark:text-gray-300">{d.description}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-4xl font-bold tabular-nums text-gray-900 dark:text-white">{best !== null ? best.toFixed(1) : "–"}</p>
                        <p className="text-xs text-gray-400">best score of 10</p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {d.capabilities.map((c) => <span key={c} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">{c}</span>)}
                    </div>
                    <dl className="mt-5 grid grid-cols-3 gap-4 border-t border-gray-100 pt-4 text-sm dark:border-gray-900">
                      <div><dt className="text-xs text-gray-400">Model</dt><dd className="font-mono text-gray-800 dark:text-gray-200">{d.model}</dd></div>
                      <div><dt className="text-xs text-gray-400">Tools</dt><dd className="font-mono text-gray-800 dark:text-gray-200">{d.tools.length ? d.tools.join(", ") : "none"}</dd></div>
                      <div><dt className="text-xs text-gray-400">Suggested price</dt><dd className="font-mono text-gray-800 dark:text-gray-200">{d.priceEth} ETH</dd></div>
                    </dl>
                  </div>
                )}

                {/* the score, round by round */}
                {rounds.length > 0 && (
                  <div className="space-y-2.5 rounded-2xl border border-gray-200 p-4 dark:border-gray-800">
                    {rounds.map((r) => (
                      <div key={r.round} className="flex items-center gap-3 font-mono text-xs">
                        <span className="w-16 shrink-0 text-gray-500">Round {r.round}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                          <div className="h-full rounded-full bg-gray-900 transition-all duration-700 dark:bg-white" style={{ width: `${((r.score ?? (r.results.filter((x) => x.score !== null).length / r.results.length) * 2) / 10) * 100}%`, opacity: r.score === null ? 0.3 : 1 }} />
                        </div>
                        <span className={`w-8 shrink-0 text-right ${r.score !== null && r.score === best ? "text-gray-900 dark:text-white" : "text-gray-500"}`}>{r.score !== null ? r.score.toFixed(1) : "…"}</span>
                      </div>
                    ))}
                    {Array.from({ length: Math.max(0, 3 - rounds.length) }, (_, i) => (
                      <div key={`e${i}`} className="flex items-center gap-3 font-mono text-xs text-gray-300 dark:text-gray-700">
                        <span className="w-16 shrink-0">Round {rounds.length + i + 1}</span>
                        <div className="h-1.5 flex-1 rounded-full border border-dashed border-gray-200 dark:border-gray-800" />
                        <span className="w-8 shrink-0 text-right">–</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* the tests: each fills in as it is graded */}
                {last && (
                  <div>
                    <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-gray-400">Round {last.round} · test tasks</p>
                    <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white/80 backdrop-blur dark:divide-gray-900 dark:border-gray-800 dark:bg-gray-950/70">
                      {last.results.map((x, i) => (
                        <li key={i}>
                          <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-start gap-4 px-5 py-4 text-left transition hover:bg-gray-50 dark:hover:bg-gray-900/50">
                            <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-mono text-sm font-semibold ${x.score === null ? "bg-gray-100 text-gray-400 dark:bg-gray-900" : x.score >= 8 ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : x.score >= 6 ? "bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-white" : "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400"}`}>
                              {x.score === null ? (x.feedback ? "–" : <span className="h-2 w-2 animate-ping rounded-full bg-gray-400" />) : x.score}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="line-clamp-2 text-sm text-gray-900 dark:text-gray-100">{x.task}</span>
                              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{x.score === null && !x.feedback ? (x.answer ? "Grading…" : "Answering…") : x.feedback}</span>
                            </span>
                          </button>
                          {open === i && x.answer && (
                            <div className="border-t border-gray-100 bg-gray-50/70 px-5 py-4 text-sm dark:border-gray-900 dark:bg-gray-900/40">
                              <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400">What a great answer does: {x.lookFor}</p>
                              <MarkdownOutput text={x.answer} />
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* actions */}
                {b.status === "drafted" && (
                  <button type="button" onClick={() => void test(b.id)} className="w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900">
                    {rounds.length ? "Test the change" : "Test and improve it"}
                  </button>
                )}
                {(b.status === "ready" || b.status === "stopped") && d && (
                  (best ?? 0) >= MIN_PUBLISH_SCORE ? (
                    <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-gray-200 bg-white/80 p-4 backdrop-blur dark:border-gray-800 dark:bg-gray-950/70">
                      <label className="flex flex-col gap-1 text-xs text-gray-400">
                        Your price, per task
                        <span className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-800">
                          <input inputMode="decimal" value={price || String(d.priceEth)} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} className="w-24 bg-transparent font-mono text-sm text-gray-900 focus:outline-none dark:text-white" aria-label="Price per task in ETH" />
                          <span className="font-mono text-sm text-gray-500">ETH</span>
                        </span>
                      </label>
                      <button type="button" onClick={() => void publish()} disabled={publishing} className="rounded-xl bg-gray-900 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                        {publishing ? "Publishing…" : "Publish it"}
                      </button>
                      <p className="min-w-[200px] flex-1 text-sm text-gray-500">Live on Axon for anyone to hire. You keep what it earns.</p>
                    </div>
                  ) : (
                    <p className="rounded-2xl border border-gray-200 p-4 text-sm text-gray-500 dark:border-gray-800">It needs a score of {MIN_PUBLISH_SCORE} to be listed. Ask for a change below and test it again.</p>
                  )
                )}
                {b.status === "published" && d && (
                  <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-900 p-4 dark:border-white">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <p className="flex-1 text-sm text-gray-900 dark:text-white"><b>{d.name}</b> is live on Axon at {d.priceEth} ETH a task.</p>
                    <a href={`/agents/${live ?? d.handle}`} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-900 transition hover:border-gray-900 dark:border-gray-800 dark:text-white dark:hover:border-white">Open its page</a>
                    <a href={`/launch/${live ?? d.handle}`} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-900 transition hover:border-gray-900 dark:border-gray-800 dark:text-white dark:hover:border-white">Launch its token</a>
                    <a target="_blank" rel="noreferrer"
                      href={`https://x.com/intent/tweet?text=${encodeURIComponent(`I built ${d.name} in one sentence on Axon Agent Studio. Tested on real tasks, it scored ${(best ?? 0).toFixed(1)}/10.\n\nHire it:`)}&url=${encodeURIComponent(`https://axon-agents.com/agents/${live ?? d.handle}`)}`}
                      className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 dark:bg-white dark:text-gray-900">Share on X</a>
                  </div>
                )}
                {b.status === "published" && d && <UseAnywhere agentId={live ?? d.handle} name={d.name} compact />}

                {/* chat: change anything */}
                {d && ["drafted", "ready", "stopped"].includes(b.status) && (
                  <div className="rounded-2xl border border-gray-200 bg-white/80 p-4 backdrop-blur dark:border-gray-800 dark:bg-gray-950/70">
                    {current!.tweaks.length > 0 && (
                      <ul className="mb-3 space-y-1.5">
                        {current!.tweaks.map((t, i) => (
                          <li key={i} className="flex gap-2 text-sm"><span className="text-gray-400">You:</span><span className="text-gray-800 dark:text-gray-200">{t.request}</span>{!t.ok && <span className="text-red-500">({t.note})</span>}</li>
                        ))}
                      </ul>
                    )}
                    <div className="flex gap-2">
                      <input value={tweak} onChange={(e) => setTweak(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void sendTweak(); }} placeholder="Ask for a change: shorter answers, a risk section, a different tone…"
                        className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-transparent px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none dark:border-gray-800 dark:text-white" />
                      <button type="button" onClick={() => void sendTweak()} disabled={tweaking || !tweak.trim()} className="rounded-lg border border-gray-900 px-4 text-sm font-semibold text-gray-900 transition hover:bg-gray-900 hover:text-white disabled:opacity-40 dark:border-white dark:text-white dark:hover:bg-white dark:hover:text-gray-900">
                        {tweaking ? "Changing…" : "Change"}
                      </button>
                    </div>
                  </div>
                )}

                {d && (
                  <div>
                    <button type="button" onClick={() => setShowInstructions(!showInstructions)} className="font-mono text-xs uppercase tracking-[0.2em] text-gray-400 hover:text-gray-900 dark:hover:text-white">
                      {showInstructions ? "Hide" : "Show"} its instructions
                    </button>
                    {showInstructions && <pre className="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-2xl border border-gray-200 bg-gray-50 p-5 font-mono text-xs leading-relaxed text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">{d.instructions}</pre>}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
