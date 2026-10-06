"use client";

import { useState } from "react";
import { useWallet } from "@/components/WalletProvider";

/**
 * What a token's mind works to and has to show for it, on the token's page: the plan it wrote, the brief its creator
 * left it, the orders and promises it has standing, what each of its moves was followed by, its daily reports, and
 * its books. Everything here is read from one endpoint; the only thing anybody can do here is the creator leaving a
 * brief, which changes what the mind is told its creator wishes and nothing else.
 */

export interface PlanView {
  mission: string; goalText: string | null; thesis: string | null; reserveEth: number; setAt: string; revisions: number;
  split: { buyback: number; reward: number; burnAxon: number; reserve: number };
  progress: { now: number | null; target: number | null; percent: number | null; reached: boolean } | null;
}
export interface OrderView { id: number; status: string; when: string; then: string; said: string | null; promise: boolean; createdAt: string; expiresAt: string | null; firedAt: string | null; note: string | null }
export interface PromisesView { made: number; standing: number; kept: number; missed: number; notCalled: number; beingKept: number; heldEth: number }
export interface MoveView { actionId: number; kind: string; eth: number; at: string; followedBy: string; lesson: string | null; measuredAt: string | null }
export interface KindView { kind: string; moves: number; measured: number; avgCapPct: number | null; timesUp: number; avgHolders: number | null; eth: number }
export interface ReportView { id: number; day: string; label: string; text: string; at: string }
export interface BooksView {
  fromFeesEth: number; holdsEth: number; setAsideEth: number; owedThinkingEth: number; reserveEth: number; heldForPromisesEth: number; freeEth: number;
  spent: { buybackEth: number; rewardEth: number; burnAxonEth: number; thinkingEth: number };
  thinkingPerDayEth: number | null; runwayDays: number | null;
}
export interface MindWorkData {
  plan: PlanView | null; orders: OrderView[]; promises: PromisesView | null;
  record: { summary: { moves: number; measured: number; byKind: KindView[] }; moves: MoveView[] } | null;
  reports: ReportView[]; brief: { text: string; setAt: string } | null; briefCanChangeAt: string | null; books: BooksView | null;
}

const LABEL = "font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400";
const eth = (v: number) => `${v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v >= 0.001 ? v.toFixed(4) : v > 0 ? v.toPrecision(2) : "0"} ETH`;
const ago = (iso: string, now: number): string => { const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`; };
const until = (iso: string, now: number): string => { const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} days`; };
const DID: Record<string, [string, string]> = { buyback: ["buyback", "buybacks"], reward: ["reward", "rewards"], burn_axon: ["$AXON burn", "$AXON burns"] };
const signed = (v: number, unit = "") => `${v > 0 ? "+" : ""}${v}${unit}`;

/** The plan a mind wrote for itself: what it is trying to do, how far along it is, and what it keeps back. */
export function Plan({ plan, now }: { plan: PlanView | null; now: number }) {
  if (!plan) return (
    <div className="mb-5">
      <p className={`mb-1.5 ${LABEL}`}>Its plan</p>
      <p className="text-sm text-gray-500 dark:text-gray-400">It has not written a plan yet. A mind writes its own plan the next time it thinks: a mission, a goal, and a reserve it will not spend below.</p>
    </div>
  );
  const parts = [
    { label: "Buybacks", v: plan.split.buyback, tone: "bg-gray-900 dark:bg-white" },
    { label: "Rewards", v: plan.split.reward, tone: "bg-gray-500 dark:bg-gray-400" },
    { label: "Burn $AXON", v: plan.split.burnAxon, tone: "bg-gray-400 dark:bg-gray-500" },
    { label: "Reserve", v: plan.split.reserve, tone: "bg-gray-300 dark:bg-gray-700" },
  ];
  const p = plan.progress;
  return (
    <div className="mb-5">
      <p className={`mb-1.5 ${LABEL}`}>Its plan <span className="normal-case tracking-normal text-gray-500 dark:text-gray-400" suppressHydrationWarning>· written by the mind {ago(plan.setAt, now)} ago{plan.revisions ? `, rewritten ${plan.revisions === 1 ? "once" : `${plan.revisions} times`}` : ""}</span></p>
      <p className="text-[15px] font-medium leading-snug">{plan.mission}</p>
      {plan.thesis && <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-gray-400">{plan.thesis}</p>}
      <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {plan.goalText && (
          <div>
            <p className="flex items-baseline justify-between gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400">Goal: <span className="text-gray-900 dark:text-gray-100">{plan.goalText}</span></span><span className="font-mono tabular-nums">{p?.reached ? "reached" : p?.percent === null || !p ? "…" : `${p.percent}%`}</span></p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800" role="img" aria-label={p?.reached ? "Goal reached" : `${p?.percent ?? 0}% of the way to its goal`}>
              <span className="block h-full rounded-full bg-gray-900 transition-[width] duration-700 dark:bg-white" style={{ width: `${p?.reached ? 100 : Math.max(2, p?.percent ?? 0)}%` }} />
            </div>
          </div>
        )}
        <div>
          <p className="flex items-baseline justify-between gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400">How it means to use its treasury</span><span className="font-mono tabular-nums text-gray-500 dark:text-gray-400">keeps {eth(plan.reserveEth)}</span></p>
          <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
            {parts.map((s) => s.v > 0 && <span key={s.label} className={`${s.tone} border-r-2 border-gray-50 last:border-r-0 dark:border-[#0f1115]`} style={{ width: `${s.v}%` }} />)}
          </div>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
            {parts.filter((s) => s.v > 0).map((s) => <span key={s.label} className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-sm ${s.tone}`} aria-hidden />{s.label} <span className="font-mono tabular-nums text-gray-900 dark:text-gray-100">{s.v}%</span></span>)}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-400">The plan is the mind&apos;s own and it may rewrite it. Its reserve is enforced: the rule check refuses any move that would take the treasury below it.</p>
    </div>
  );
}

/** The creator's note to the mind. Anybody reads it; only the wallet that launched the token can leave or change it. */
export function Brief({ token, creator, brief, canChangeAt, now, onChanged }: { token: string; creator: string; brief: MindWorkData["brief"]; canChangeAt: string | null; now: number; onChanged: () => void }) {
  const { address, apiKey } = useWallet();
  const mine = Boolean(address && address.toLowerCase() === creator.toLowerCase());
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending">("idle");
  const [note, setNote] = useState<string | null>(null);
  if (!brief && !mine) return null;
  const locked = canChangeAt !== null && Date.parse(canChangeAt) > now;
  const send = async (value: string) => {
    if (!apiKey) { setNote("Sign in with your wallet first."); return; }
    setState("sending"); setNote(null);
    try {
      const r = await fetch(`/api/minds/tokens/${token}/brief`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ text: value }) });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) { setNote(body.error ?? "The brief could not be saved."); return; }
      setEditing(false); setText(""); setNote(value ? "Left. Your mind reads it the next time it thinks, usually within a minute." : "Taken back.");
      onChanged();
    } catch { setNote("The brief could not be saved. Try again."); } finally { setState("idle"); }
  };
  return (
    <div className="mb-5">
      <p className={`mb-1.5 ${LABEL}`}>Brief from its creator {brief && <span className="normal-case tracking-normal text-gray-500 dark:text-gray-400" suppressHydrationWarning>· left {ago(brief.setAt, now)} ago</span>}</p>
      {brief ? <p className="border-l-2 border-gray-300 pl-3 text-sm leading-relaxed dark:border-gray-700">{brief.text}</p> : <p className="text-sm text-gray-500 dark:text-gray-400">You have not left your mind a brief. Tell it in a sentence or two what you would like it to care about.</p>}
      {mine && !editing && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" disabled={locked} onClick={() => { setText(brief?.text ?? ""); setEditing(true); setNote(null); }} className="rounded-xl border border-gray-300 px-3.5 py-1.5 text-sm font-semibold transition hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900">{brief ? "Change the brief" : "Leave a brief"}</button>
          <span className="text-xs text-gray-400" suppressHydrationWarning>{locked ? `A brief stands for six hours. You can change it in ${until(canChangeAt as string, now)}.` : "Only your wallet can. It is public, and it steers what the mind cares about, never its limits."}</span>
        </div>
      )}
      {mine && editing && (
        <div className="mt-3">
          <textarea aria-label="Your brief to the mind" value={text} onChange={(e) => setText(e.target.value.slice(0, 280))} rows={3} placeholder="For example: care most about the people who hold for the long run, and prefer steady buybacks over big ones." className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm leading-relaxed focus:border-gray-900 focus:outline-none dark:border-gray-700 dark:bg-gray-950 dark:focus:border-white" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void send(text.trim())} disabled={state === "sending" || text.trim().length < 8} className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">{state === "sending" ? "Saving…" : "Leave this brief"}</button>
            {brief && <button type="button" onClick={() => void send("")} disabled={state === "sending"} className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold transition hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900">Take it back</button>}
            <button type="button" onClick={() => { setEditing(false); setNote(null); }} className="px-2 py-2 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">Cancel</button>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-gray-400">{text.length} / 280</span>
          </div>
          <p className="mt-2 text-xs text-gray-400">Everybody can read it. Your mind weighs it as your wish beside its own judgment. It cannot change a limit, the reserve or anything locked at launch, and it stands for six hours once you leave it.</p>
        </div>
      )}
      {note && <p role="status" className="mt-2 text-sm text-gray-600 dark:text-gray-300">{note}</p>}
    </div>
  );
}

const ENDED: Record<string, string> = { fired: "Its condition came. On its way.", kept: "Carried out.", missed: "Its condition came, but it was not carried out.", lapsed: "Its time ran out before its condition came.", cancelled: "The mind took it back." };

/** Its standing orders and promises: what is waiting, and what became of the recent ones. */
export function Orders({ orders, promises, now }: { orders: OrderView[]; promises: PromisesView | null; now: number }) {
  const armed = orders.filter((o) => o.status === "armed"), rest = orders.filter((o) => o.status !== "armed");
  const row = (o: OrderView) => (
    <li key={o.id}>
      <p className="text-sm leading-relaxed"><span className="text-gray-500 dark:text-gray-400">When</span> {o.when}, <span className="text-gray-500 dark:text-gray-400">it will</span> {o.then}.</p>
      {o.said && <p className="mt-1 border-l-2 border-gray-300 pl-3 text-sm leading-relaxed text-gray-600 dark:border-gray-700 dark:text-gray-300">{o.said}</p>}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-gray-400">
        <span className={`rounded-md px-1.5 py-0.5 ${o.promise ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900" : "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>{o.promise ? "promise" : "standing order"}</span>
        <span suppressHydrationWarning>{o.status === "armed" ? (o.expiresAt ? `${o.promise ? "stands for another" : "waits another"} ${until(o.expiresAt, now)}` : "waiting") : `${ago(o.firedAt ?? o.expiresAt ?? o.createdAt, now)} ago`}</span>
        {o.status !== "armed" && <span className="font-sans">{ENDED[o.status] ?? o.status}{o.status === "missed" && o.note ? ` ${o.note}` : ""}</span>}
      </p>
    </li>
  );
  return (
    <div>
      {promises && promises.made > 0 && (
        <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
          {([["Promises kept", String(promises.kept)], ["Promises missed", String(promises.missed)], ["Standing now", String(promises.standing + promises.beingKept)], ["Held for them", eth(promises.heldEth)]] as const).map(([k, v]) => (
            <div key={k}><dt className="text-gray-500 dark:text-gray-400">{k}</dt><dd className="font-mono tabular-nums">{v}</dd></div>
          ))}
        </dl>
      )}
      {orders.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">It has no orders standing. A mind can set an action ahead of time, for example a buyback if the market cap falls by a set share. It fires the moment its condition is met, with no thinking, through the same rule check.</p>
      ) : (
        <>
          {armed.length > 0 && <ol className="space-y-4">{armed.map(row)}</ol>}
          {armed.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">Nothing is waiting right now.</p>}
          {rest.length > 0 && <><p className={`mb-3 mt-5 ${LABEL}`}>Earlier</p><ol className="space-y-4">{rest.map(row)}</ol></>}
        </>
      )}
      <p className="mt-4 text-xs text-gray-400">An order fires once and lapses when its time runs out. A promise cannot be taken back, and its ETH is held in the treasury until it is kept or its time runs out.</p>
    </div>
  );
}

/** What each of its moves was followed by an hour later, and what the mind took from it. */
export function Record({ record, now }: { record: MindWorkData["record"]; now: number }) {
  if (!record || record.summary.moves === 0) return <p className="text-sm text-gray-500 dark:text-gray-400">No move of its mind has been carried out yet. Every buyback, reward and $AXON burn is measured an hour later, and the mind writes what it takes from it.</p>;
  return (
    <div>
      <ul className="mb-5 space-y-1.5 text-sm">
        {record.summary.byKind.map((k) => (
          <li key={k.kind} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{k.moves} {(DID[k.kind] ?? [k.kind, k.kind])[k.moves === 1 ? 0 : 1]}</span>
            <span className="font-mono text-xs tabular-nums text-gray-400">{eth(k.eth)}</span>
            <span className="text-gray-500 dark:text-gray-400">{k.measured && k.avgCapPct !== null ? `followed an hour later by market cap ${signed(k.avgCapPct, "%")} on average, higher ${k.timesUp} of ${k.measured} times${k.avgHolders === null ? "" : `, holders ${signed(k.avgHolders)}`}` : "not measured yet"}</span>
          </li>
        ))}
      </ul>
      <ol className="space-y-4">
        {record.moves.map((m) => (
          <li key={m.actionId}>
            <p className="text-sm leading-relaxed"><span className="font-medium capitalize">{(DID[m.kind] ?? [m.kind])[0]}</span> with {eth(m.eth)} <span className="text-gray-500 dark:text-gray-400">· {m.followedBy}</span></p>
            {m.lesson && <p className="mt-1 border-l-2 border-gray-300 pl-3 text-sm leading-relaxed text-gray-600 dark:border-gray-700 dark:text-gray-300">{m.lesson}</p>}
            <p className="mt-1.5 font-mono text-[11px] text-gray-400" suppressHydrationWarning>{ago(m.at, now)} ago{m.lesson ? " · the mind's own lesson" : ""}</p>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-gray-400">This is what came after each move, read from the chain an hour later. It is not what the move caused: a market moves for many reasons.</p>
    </div>
  );
}

/** The mind's daily reports, newest first. */
export function Reports({ reports }: { reports: ReportView[] }) {
  if (!reports.length) return <p className="text-sm text-gray-500 dark:text-gray-400">It has not written a report yet. Each morning (UTC) a mind reports on the day before, if something happened on it and its treasury can pay for the thought.</p>;
  return (
    <ol className="space-y-5">
      {reports.map((r) => (
        <li key={r.id}>
          <p className={`mb-1.5 ${LABEL}`}>{r.label}</p>
          <p className="text-sm leading-relaxed">{r.text}</p>
        </li>
      ))}
    </ol>
  );
}

/** Its books: what came in, what it holds, what it spent and on what, what it keeps back, and how long its thinking is paid for. */
export function Books({ books, attached }: { books: BooksView | null; attached: boolean }) {
  if (!books) return <p className="text-sm text-gray-400">…</p>;
  const out = [["Buybacks", books.spent.buybackEth], ["Rewards for holders", books.spent.rewardEth], ["Burning $AXON", books.spent.burnAxonEth], ["Its own thinking", books.spent.thinkingEth]] as const;
  const total = out.reduce((s, [, v]) => s + v, 0);
  const tones = ["bg-gray-900 dark:bg-white", "bg-gray-500 dark:bg-gray-400", "bg-gray-400 dark:bg-gray-500", "bg-gray-300 dark:bg-gray-700"];
  const line = (k: string, v: string, strong = false) => (
    <div key={k} className="flex items-baseline justify-between gap-4 border-b border-gray-200 py-1.5 last:border-b-0 dark:border-gray-800">
      <dt className="text-gray-500 dark:text-gray-400">{k}</dt><dd className={`font-mono tabular-nums ${strong ? "font-semibold" : ""}`}>{v}</dd>
    </div>
  );
  return (
    <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      <div>
        <p className={`mb-2 ${LABEL}`}>In and held</p>
        <dl className="text-sm">
          {!attached && line("Received from trading fees", eth(books.fromFeesEth))}
          {line("Holds now", eth(books.holdsEth), true)}
          {line("Set aside for holders, unclaimed", eth(books.setAsideEth))}
          {line("Kept in reserve by its plan", eth(books.reserveEth))}
          {line("Held for its promises", eth(books.heldForPromisesEth))}
          {line("Free to spend now", eth(books.freeEth), true)}
        </dl>
      </div>
      <div>
        <p className={`mb-2 ${LABEL}`}>Spent so far</p>
        {total > 0 && (
          <div className="mb-3 flex h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
            {out.map(([k, v], i) => v > 0 && <span key={k} className={`${tones[i]} border-r-2 border-gray-50 last:border-r-0 dark:border-[#0f1115]`} style={{ width: `${(v / total) * 100}%` }} />)}
          </div>
        )}
        <dl className="text-sm">
          {out.map(([k, v]) => line(k, eth(v)))}
          {books.owedThinkingEth > 0 && line("Thinking done, not paid yet", eth(books.owedThinkingEth))}
        </dl>
        <p className="mt-4 text-sm"><span className="text-gray-500 dark:text-gray-400">Runway: </span>{books.runwayDays === null ? "its thinking has cost nothing so far." : <>its treasury covers about <span className="font-mono font-semibold tabular-nums">{books.runwayDays > 365 ? "365+" : books.runwayDays}</span> days of thinking{books.thinkingPerDayEth ? <> at {eth(books.thinkingPerDayEth)} a day, its pace of the last days.</> : "."}</>}</p>
      </div>
    </div>
  );
}
