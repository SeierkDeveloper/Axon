"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { payForBuild } from "@/lib/buildPaymentClient";
import MarkdownOutput from "@/components/MarkdownOutput";
import FileAttach, { type Attached } from "@/components/FileAttach";
import OutputFiles, { type OutputFile } from "@/components/OutputFiles";
import StepPicture, { type StepShot } from "@/components/StepPicture";
import PagesVisited, { pageLabel, type Visited } from "@/components/PagesVisited";
import VoiceInput from "@/components/VoiceInput";
import VoiceOutput from "@/components/VoiceOutput";
import AgentMemory, { browserMemoryKey } from "@/components/AgentMemory";
import BringIn, { type Helper } from "@/components/BringIn";
import { AgentWork, readConversation } from "@/components/Library";
import type { StarterJob } from "@/lib/starterJobs";

// Close the loop: hire an agent right here. Free-lane agents run immediately;
// paid agents settle a single on-chain ETH payment (x402) first — pay with
// MetaMask, then the same anonymous hire runs. Either way we poll the result with
// the returned claimToken and the hire settles into a real receipt that feeds
// the agent's Proof Score, so discovery → reputation → work → reputation comes
// full circle.
//
// In-browser payment covers ETH-priced agents. A SOL price (or missing wallet
// config) falls back to the API/MCP, which pay per task.

type Phase = "idle" | "hiring" | "running" | "asking" | "planning" | "cancelled" | "done" | "error";

/** A note sent to the agent while it works, and whether it has read it. */
interface SentNote { n: number; text: string; deliveredAt?: string }

/** The plan a job is waiting on: what the agent will do, the price it does it for, and until when it waits. */
interface OpenPlan { n: number; text: string; answerBy: string; price: string | null; changesLeft: number }

/** A question the agent asked along the way, and what came back. */
interface Asked { n: number; text: string; choices?: string[]; answerBy: string; answer?: string; answeredAt?: string; answeredHow?: "person" | "timeout" }

const MAX_POLLS = 45; // ~90s at 2s intervals
const POLL_MS = 2000;
const WAIT_POLL_MS = 4000; // while the job waits on the person, there is no hurry

// Parse an ETH price like "0.25 ETH" → 0.25. null for SOL/unparseable prices.
function parsePrice(price?: string | null): number | null {
  const m = (price ?? "").trim().match(/^(\d+(?:\.\d{1,6})?)\s*ETH$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Turn a payForBuild error code into something a hirer can act on.
function payErrorMessage(msg: string, ethAmount: number): string {
  if (msg === "WALLET_NOT_FOUND") return "No wallet found in this browser. Install one to pay and hire here.";
  if (msg.startsWith("INSUFFICIENT_FUNDS")) {
    const have = msg.split(":")[1];
    return `Not enough ETH, this costs ${ethAmount} ETH, but your wallet only has ${have ?? "0"}. Add ETH and try again.`;
  }
  
  if (msg === "PAYMENT_FAILED") return "The payment didn't go through, you weren't charged. Try again.";
  if (/reject|declin|cancel/i.test(msg)) return "Payment cancelled.";
  return "Couldn't complete the payment. Try again.";
}

/** One finished turn of a conversation with the agent: what was asked, what came back, and the hire that did it. */
interface Turn { taskId: string; claim: string; task: string; output: string; outFiles: OutputFile[]; agentName: string }

/** An earlier turn, shown above the one in hand. */
function EarlierTurn({ n, turn, named }: { n: number; turn: Turn; named: boolean }) {
  return (
    <div className="mb-4 border-b border-gray-100 pb-4 dark:border-gray-800">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">You, turn {n}</p>
      <p className="whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{turn.task}</p>
      {named && <p className="mt-2 text-[11px] font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">{turn.agentName}</p>}
      <div className="mt-2 max-h-56 overflow-auto break-words rounded-md border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-800 dark:bg-gray-900/40">
        {turn.output ? <MarkdownOutput text={turn.output} /> : <span className="text-sm text-gray-400">(empty response)</span>}
      </div>
      <OutputFiles files={turn.outFiles} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <a href={`/r/${encodeURIComponent(turn.taskId)}`} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 hover:underline dark:text-teal-400">
          Receipt →
        </a>
        {turn.output && <VoiceOutput taskId={turn.taskId} claimToken={turn.claim} />}
      </div>
    </div>
  );
}

interface StepLine { n: number; text: string; shot?: StepShot }

/** An address as a person would say it: the site and the path. */

interface Sent { n: number; url: string; button: string; fields: { label: string; value: string }[] }

/**
 * What the agent's browser sent on this job: each form, the page it was on and every field with what was in it. A
 * form sent in the person's name is theirs to see in full, so it is shown open, above everything else about how the
 * job went. Shows nothing for a job that sent nothing.
 */
function FormsSent({ sent }: { sent: Sent[] }) {
  if (!sent.length) return null;
  return (
    <div className="mt-3 rounded-md border border-teal-200 bg-teal-50/50 p-3 text-xs dark:border-teal-900/50 dark:bg-teal-950/20">
      <p className="font-semibold text-gray-900 dark:text-white">{sent.length === 1 ? "It sent a form for you" : `It sent ${sent.length} forms for you`}</p>
      {sent.map((f) => (
        <div key={f.n} className="mt-2">
          <p className="break-words text-gray-600 dark:text-gray-300">
            To <a href={f.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-teal-700 hover:underline dark:text-teal-400">{pageLabel(f.url)}</a>
            {f.button ? <> with the button &ldquo;{f.button}&rdquo;</> : null}
          </p>
          {f.fields.length > 0 ? (
            <dl className="mt-1.5 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1">
              {f.fields.map((x, i) => (
                <div key={i} className="contents">
                  <dt className="break-words text-gray-500 dark:text-gray-400">{x.label || "A field"}</dt>
                  <dd className="break-words text-gray-900 dark:text-white">{x.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-1 text-gray-500 dark:text-gray-400">Nothing was filled in.</p>
          )}
        </div>
      ))}
    </div>
  );
}


/**
 * The steps of a hire, oldest first. While it runs the last one is the one happening now. A step an agent took in
 * its browser carries a picture of the page as it then was: while the job runs the newest picture is open, so the
 * person watches the agent's window; any other opens when asked for.
 */
function StepList({ steps, live }: { steps: StepLine[]; live?: boolean }) {
  // what the person opened or closed themselves wins over what is open by itself
  const [chosen, setChosen] = useState<Record<number, boolean>>({});
  if (!steps.length) return null;
  const newest = live ? [...steps].reverse().find((s) => s.shot)?.n : undefined;
  return (
    <ol className="mt-2.5 space-y-1.5 border-l border-gray-200 pl-3 dark:border-gray-700" aria-live={live ? "polite" : undefined}>
      {steps.map((s, i) => {
        const now = live && i === steps.length - 1;
        const open = s.shot ? chosen[s.n] ?? s.n === newest : false;
        return (
          <li key={s.n} className={`relative text-xs leading-snug break-words ${now ? "text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"}`}>
            <span className={`absolute -left-[15.5px] top-[5px] h-1.5 w-1.5 rounded-full ${now ? "bg-teal-500 animate-pulse" : "bg-gray-300 dark:bg-gray-600"}`} />
            {s.text}
            {s.shot && (
              <button type="button" onClick={() => setChosen((c) => ({ ...c, [s.n]: !open }))} aria-expanded={open} className="ml-2 text-[11px] text-teal-600 hover:underline dark:text-teal-400">
                {open ? "Hide the picture" : "See the page"}
              </button>
            )}
            {s.shot && open && <StepPicture shot={s.shot} alt={`The page after: ${s.text}`} />}
          </li>
        );
      })}
    </ol>
  );
}

export default function HirePanel({
  agentId,
  agentName,
  isPaid,
  price,
  receiver,
  rpcUrl,
  canPlan = false,
  canRemember = false,
  canBringIn = false,
  canLibrary = false,
  starters = [],
}: {
  agentId: string;
  agentName: string;
  isPaid: boolean;
  price?: string | null;
  receiver?: string;
  rpcUrl?: string;
  /** this agent can write a plan for the person to approve before it starts */
  canPlan?: boolean;
  /** agents remember the people who hire them here */
  canRemember?: boolean;
  /** a follow-up can go to another agent, which joins the conversation */
  canBringIn?: boolean;
  /** hires are kept in the person's library, and a conversation from it can be opened here again */
  canLibrary?: boolean;
  /** jobs this agent is good at, written out: one tap puts one in the box */
  starters?: StarterJob[];
}) {
  const [task, setTask] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [hint, setHint] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // files handed over with the hire: uploaded as they are chosen, attached when the hire is created
  const [files, setFiles] = useState<Attached[]>([]);
  // the answer as a file as well, and whatever the agent handed back with it
  const [report, setReport] = useState(false);
  const [outFiles, setOutFiles] = useState<OutputFile[]>([]);
  // what the agent has done so far, one line a step, while it runs and after
  const [steps, setSteps] = useState<StepLine[]>([]);
  // where the agent's browser went on this job, when it used one
  const [pages, setPages] = useState<Visited[]>([]);
  // and what it sent there: each form, field by field
  const [sent, setSent] = useState<Sent[]>([]);
  const cancelled = useRef(false);
  // the hire's own token: what reads its answer, and what has that answer read aloud
  const [claim, setClaim] = useState<string | null>(null);
  // A payment that already landed on-chain — kept so a failed submit retries with
  // the SAME signature instead of charging the wallet a second time.
  const paid = useRef<{ paymentSignature: string; payerWallet: string } | null>(null);
  // Work with your agent: the finished turns before the one in hand, whether this one can be followed up, and the
  // follow-up being written. A follow-up is a hire of its own that continues the one shown.
  const [turns, setTurns] = useState<Turn[]>([]);
  const [follow, setFollow] = useState<{ open: boolean; turnsLeft: number } | null>(null);
  const [followText, setFollowText] = useState("");
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  // Bringing in another agent: the agent that did the turn in hand (at first the one this page is about), the one
  // picked to take the next follow-up instead, and whether the picker is open.
  const [turnAgent, setTurnAgent] = useState<Helper>({ id: agentId, name: agentName, price: price ?? null });
  const [helper, setHelper] = useState<Helper | null>(null);
  const [picking, setPicking] = useState(false);
  // a follow-up's payment that already landed, kept so a failed send retries with it instead of paying again
  const followPaid = useRef<{ paymentSignature: string; payerWallet: string } | null>(null);
  // whether a payment is already held for the hire, and for the follow-up: what the buttons say depends on it
  const [hasPaid, setHasPaid] = useState(false);
  const [followHasPaid, setFollowHasPaid] = useState(false);
  // The agent asks: the question the job is waiting on, the answer being written, and what was asked along the way.
  const [question, setQuestion] = useState<Asked | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [asked, setAsked] = useState<Asked[]>([]);
  // the question just answered here, so a read that was already on its way does not show it again
  const answeredQ = useRef(0);
  // Plan first: whether it was asked for, the plan the job is waiting on, and what is being decided about it.
  const [planFirst, setPlanFirst] = useState(false);
  const [plan, setPlan] = useState<OpenPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [change, setChange] = useState("");
  const decidedPlan = useRef(0);
  // It remembers you: the key this browser keeps for its memory with agents, whether memory is left out of the next
  // hire, what the job in hand noted, and a count that has the memory read again after a job.
  const [memoryKey, setMemoryKey] = useState<string | null>(null);
  const [memoryOff, setMemoryOff] = useState(false);
  const [noted, setNoted] = useState<{ id: string; text: string }[]>([]);
  const [memoryRead, setMemoryRead] = useState(0);
  useEffect(() => {
    // the key lives in this browser's storage, which cannot be read while the page is made on the server
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount, from storage the server has no access to
    if (canRemember || canLibrary) setMemoryKey(browserMemoryKey());
  }, [canRemember, canLibrary]);
  /**
   * What a hire says about who it is from: this browser's key, and whether the agent's memory of it is used. The key
   * goes along even when memory is left out, since the library hangs on it too. Nothing where neither is offered.
   */
  const memoryFields = () => (memoryKey ? { memory: canRemember && !memoryOff, memoryKey } : {});
  // Your library: a count that has the list of earlier work read again, and whether a conversation is being opened.
  const [libraryRead, setLibraryRead] = useState(0);
  const [opening, setOpening] = useState(false);
  // Starter jobs: the one whose sample file is being fetched.
  const [starting, setStarting] = useState<string | null>(null);
  // Stop and steer: whether a note or a stop is possible now, the notes sent, the one being written, and whether
  // the job was stopped here.
  const [steer, setSteer] = useState<{ open: boolean; stoppable: boolean; notesLeft: number } | null>(null);
  const [notes, setNotes] = useState<SentNote[]>([]);
  const [noteText, setNoteText] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [stopAsk, setStopAsk] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [stoppedHere, setStoppedHere] = useState(false);

  /** What was said out loud, added to what is already written in a box. */
  const add = (said: string) => (had: string) => (had.trim() ? `${had.trimEnd()} ${said}` : said);

  // Stop the poll loop if the user navigates away mid-hire — no setState on an
  // unmounted component, no orphaned timers.
  useEffect(() => () => { cancelled.current = true; }, []);

  const ethAmount = parsePrice(price);
  // In-browser payment needs an ETH price AND the receiver + RPC config. Anything
  // else (SOL price, unset env) keeps the API/MCP fallback.
  // No RPC needed: the wallet sends the transaction itself. Gating on one would hide the pay
  // button whenever that variable happened to be unset, which is not a reason to hide it.
  const canPayInBrowser = isPaid && ethAmount !== null && Boolean(receiver);

  async function poll(id: string, claimToken: string, attempt: number) {
    if (cancelled.current) return;
    if (attempt > MAX_POLLS) {
      setError("The agent is taking longer than expected, check the receipt shortly.");
      setPhase("error");
      return;
    }
    try {
      // Send the claimToken as a header, not in the URL — keeps this read
      // permission out of access logs and browser history.
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { headers: { "x-claim-token": claimToken } });
      if (cancelled.current) return;
      // A bad token (403) is terminal — it will never read this task, so don't
      // poll to the timeout pretending it's just slow. A 404 is NOT terminal: on
      // a horizontally-scaled deploy the read can hit an instance whose replica
      // hasn't synced the just-created task yet, so keep polling through it.
      if (res.status === 403) {
        setError("Couldn't read this hire's result, check the receipt shortly.");
        setPhase("error");
        return;
      }
      const t = (await res.json()) as { status?: string; output?: string | null; outputFiles?: OutputFile[]; steps?: StepLine[]; pages?: Visited[]; sent?: Sent[]; followUp?: { open?: boolean; turnsLeft?: number }; question?: Asked; questions?: Asked[]; plan?: OpenPlan; steer?: { open?: boolean; stoppable?: boolean; notesLeft?: number }; notes?: SentNote[]; remembered?: { id: string; text: string }[] };
      if (cancelled.current) return;
      if (Array.isArray(t.steps)) setSteps((had) => (t.steps!.length >= had.length ? t.steps! : had));
      if (Array.isArray(t.pages)) setPages((had) => (t.pages!.length >= had.length ? t.pages! : had));
      if (Array.isArray(t.sent)) setSent((had) => (t.sent!.length >= had.length ? t.sent! : had));
      if (Array.isArray(t.questions)) setAsked(t.questions.filter((q) => q.answeredAt));
      setSteer(t.steer ? { open: Boolean(t.steer.open), stoppable: Boolean(t.steer.stoppable), notesLeft: Number(t.steer.notesLeft) || 0 } : null);
      if (Array.isArray(t.notes)) setNotes(t.notes);
      // The agent stopped to ask: show the question and keep looking, slowly and without a time limit, for the job to
      // go on (answered here, or its time ran out).
      if (t.status === "waiting" && t.question) {
        const stale = t.question.n === answeredQ.current;
        if (!stale) {
          setQuestion(t.question);
          setPhase("asking");
        }
        setTimeout(() => poll(id, claimToken, 0), stale ? POLL_MS : WAIT_POLL_MS);
        return;
      }
      // Plan first: the plan is out. Show it and keep looking, slowly, for the job to go on.
      if (t.status === "waiting" && t.plan) {
        const stale = t.plan.n === decidedPlan.current;
        if (!stale) {
          setPlan(t.plan);
          setPhase("planning");
        }
        setTimeout(() => poll(id, claimToken, 0), stale ? POLL_MS : WAIT_POLL_MS);
        return;
      }
      if (t.status === "cancelled") {
        setPlan(null);
        setPhase("cancelled");
        return;
      }
      if (t.status === "queued" || t.status === "running") {
        setQuestion(null);
        setPlan(null);
        setPhase((p) => (p === "asking" || p === "planning" ? "running" : p));
      }
      if (t.status === "completed") {
        setOutput(t.output ?? "");
        setOutFiles(Array.isArray(t.outputFiles) ? t.outputFiles : []);
        setFollow(t.followUp ? { open: Boolean(t.followUp.open), turnsLeft: Number(t.followUp.turnsLeft) || 0 } : null);
        setNoted(Array.isArray(t.remembered) ? t.remembered : []);
        setMemoryRead((n) => n + 1);
        setLibraryRead((n) => n + 1);
        setPhase("done");
        return;
      }
      if (t.status === "failed") {
        // A paid hire that fails is refunded automatically — say so, or a buyer who
        // just paid assumes they lost the money. Free-lane failures cost nothing.
        setError(
          paid.current
            ? "The agent couldn't complete this task, your payment was refunded. See the receipt for details."
            : "The agent couldn't complete this task. See the receipt for details.",
        );
        setPhase("error");
        return;
      }
    } catch {
      /* transient — keep polling */
    }
    setTimeout(() => poll(id, claimToken, attempt + 1), POLL_MS);
  }

  // Create the task (optionally with a verified payment) and start polling.
  // Self-contained: sets its own error/phase, never throws to the caller.
  async function submit(payment?: { paymentSignature: string; payerWallet: string }) {
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "anonymous", to: agentId, task: task.trim(), allowQuestions: true, ...memoryFields(), ...(planFirst && canPlan ? { planFirst: true } : {}), ...(files.length ? { files: files.map((f) => ({ id: f.id, token: f.token })) } : {}), ...(report ? { reportFile: true } : {}), ...(payment ?? {}) }),
      });
      const data = (await res.json()) as { taskId?: string; claimToken?: string; error?: string };
      if (cancelled.current) return;
      if (res.ok && data.taskId && data.claimToken) {
        setTaskId(data.taskId);
        setClaim(data.claimToken);
        setFiles([]); // they belong to this hire now
        setSteps([]); setPages([]); setSent([]);
        setPhase("running");
        poll(data.taskId, data.claimToken, 0);
        return;
      }
      // The payment already created a task (replay), but this response carries no
      // claimToken — a claimToken is minted only on the first create, never on a
      // replay, since the payment signature is public on-chain and re-reading it
      // must not hand anyone the private output. Surface the receipt so a spent
      // payment never dead-ends.
      if (res.ok && data.taskId) {
        setTaskId(data.taskId);
        setError("This payment already started a hire, view its receipt below.");
        setPhase("error");
        return;
      }
      setError(data.error ?? "Couldn't start the hire. Try again.");
      setPhase("error");
    } catch {
      setError("Network error starting the hire. Try again.");
      setPhase("error");
    }
  }

  async function hireFree() {
    if (!task.trim() || phase === "hiring" || phase === "running") return;
    cancelled.current = false;
    setPhase("hiring");
    setError(null);
    setOutput(null);
    setHint(null);
    await submit();
  }

  async function hirePaid() {
    if (!task.trim() || phase === "hiring" || phase === "running") return;
    if (ethAmount === null || !receiver) return;
    cancelled.current = false;
    setPhase("hiring");
    setError(null);
    setOutput(null);
    try {
      // Pay once. If a previous attempt already paid (submit then failed), reuse
      // that signature — the money is already in the treasury; never charge twice.
      let justPaid = false;
      if (!paid.current) {
        setHint("Confirm the payment in your wallet…");
        // The receiver is the Axon treasury — the server re-verifies this payment
        // on-chain (amount, currency, and that `payer` signed it) before running.
        const { signature, payer } = await payForBuild({ rpcUrl, treasury: receiver, ethAmount });
        if (cancelled.current) return;
        paid.current = { paymentSignature: signature, payerWallet: payer };
        setHasPaid(true);
        justPaid = true;
      }
      setHint(justPaid ? "Payment sent, starting the hire…" : "Starting the hire…");
      await submit(paid.current);
    } catch (e) {
      if (cancelled.current) return;
      setError(payErrorMessage(e instanceof Error ? e.message : "", ethAmount));
      setPhase("error");
    } finally {
      setHint(null);
    }
  }

  // Who the next follow-up goes to: another agent brought in, else the agent that did the turn in hand. And what
  // that costs: each agent is paid for its own part of the conversation.
  const target = helper ?? turnAgent;
  const targetAmount = parsePrice(target.price);
  const targetPays = Boolean(target.price) && targetAmount !== null && Boolean(receiver);

  // Say more about the job just finished. The agent it goes to is hired for it and is given the conversation so far
  // and the files from before; a paid agent is paid for it, since this is another piece of work.
  async function sendFollowUp() {
    const said = followText.trim();
    if (!said || !taskId || !claim || output === null || followBusy) return;
    if (target.price && !targetPays) { setFollowError(`${target.name} is a paid agent that cannot be paid from this page. Hire it through the API.`); return; }
    setFollowBusy(true);
    setFollowError(null);
    try {
      if (targetPays && !followPaid.current) {
        const ethAmount = targetAmount;
        if (ethAmount === null || !receiver) return;
        try {
          const { signature, payer } = await payForBuild({ rpcUrl, treasury: receiver, ethAmount });
          if (cancelled.current) return;
          followPaid.current = { paymentSignature: signature, payerWallet: payer };
          setFollowHasPaid(true);
        } catch (e) {
          setFollowError(payErrorMessage(e instanceof Error ? e.message : "", ethAmount));
          return;
        }
      }
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "anonymous", to: target.id, task: said, followUpOf: taskId, followUpToken: claim, allowQuestions: true, ...memoryFields(),
          ...(files.length ? { files: files.map((f) => ({ id: f.id, token: f.token })) } : {}),
          ...(report ? { reportFile: true } : {}),
          ...(followPaid.current ?? {}),
        }),
      });
      const data = (await res.json()) as { taskId?: string; claimToken?: string; error?: string };
      if (cancelled.current) return;
      if (res.ok && data.taskId && data.claimToken) {
        // the turn just finished joins the conversation above, and the follow-up becomes the turn in hand
        setTurns((had) => [...had, { taskId, claim, task, output, outFiles, agentName: turnAgent.name }]);
        setTurnAgent(target);
        setHelper(null);
        setPicking(false);
        paid.current = followPaid.current;
        followPaid.current = null;
        setHasPaid(Boolean(paid.current));
        setFollowHasPaid(false);
        setTask(said);
        setFollowText("");
        setTaskId(data.taskId);
        setClaim(data.claimToken);
        setOutput(null);
        setOutFiles([]);
        setSteps([]); setPages([]); setSent([]);
        setFiles([]);
        setFollow(null);
        setAsked([]);
        setQuestion(null);
        setNotes([]);
        setSteer(null);
        setNoted([]);
        answeredQ.current = 0;
        setPhase("running");
        poll(data.taskId, data.claimToken, 0);
        return;
      }
      setFollowError(data.error ?? "Couldn't send the follow-up. Try again.");
    } catch {
      setFollowError("Network error sending the follow-up. Try again.");
    } finally {
      setFollowBusy(false);
    }
  }

  // Answer the question the job is waiting on. It is the same job: it goes on from here, nothing is paid again.
  async function sendAnswer(text: string) {
    const said = text.trim();
    if (!said || !taskId || !claim || answerBusy) return;
    setAnswerBusy(true);
    setAnswerError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-claim-token": claim },
        body: JSON.stringify({ answer: said }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; details?: { refused?: string } };
      if (cancelled.current) return;
      // answered, or the job already went on without one: either way it is working again
      if (res.ok || data.details?.refused === "not_waiting") {
        answeredQ.current = question?.n ?? 0;
        setAnswer("");
        setQuestion(null);
        setPhase("running");
        return;
      }
      setAnswerError(data.error ?? "Couldn't send the answer. Try again.");
    } catch {
      setAnswerError("Network error sending the answer. Try again.");
    } finally {
      setAnswerBusy(false);
    }
  }

  // Decide on the plan: approve it and the work starts, ask for a change and it is written again, or cancel.
  async function decide(action: "approve" | "change" | "cancel") {
    if (!taskId || !claim || !plan || planBusy) return;
    if (action === "change" && !change.trim()) return;
    setPlanBusy(true);
    setPlanError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-claim-token": claim },
        body: JSON.stringify({ action, ...(action === "change" ? { change: change.trim() } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; details?: { refused?: string } };
      if (cancelled.current) return;
      // decided, or the job already went on by itself: either way this plan is no longer waiting
      if (res.ok || data.details?.refused === "not_waiting") {
        decidedPlan.current = plan.n;
        setPlan(null);
        setChange("");
        setChanging(false);
        setPhase(action === "cancel" && res.ok ? "cancelled" : "running");
        return;
      }
      setPlanError(data.error ?? "That did not go through. Try again.");
    } catch {
      setPlanError("Network error. Try again.");
    } finally {
      setPlanBusy(false);
    }
  }

  // Tell the agent something while it works. It reads the note at its next step, or before it finishes.
  async function sendNoteNow() {
    const said = noteText.trim();
    if (!said || !taskId || !claim || noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/steer`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-claim-token": claim },
        body: JSON.stringify({ note: said }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; notes?: SentNote[]; steer?: { open?: boolean; stoppable?: boolean; notesLeft?: number } };
      if (cancelled.current) return;
      if (res.ok) {
        setNoteText("");
        if (Array.isArray(data.notes)) setNotes(data.notes);
        if (data.steer) setSteer({ open: Boolean(data.steer.open), stoppable: Boolean(data.steer.stoppable), notesLeft: Number(data.steer.notesLeft) || 0 });
        return;
      }
      setNoteError(data.error ?? "Couldn't send the note. Try again.");
    } catch {
      setNoteError("Network error sending the note. Try again.");
    } finally {
      setNoteBusy(false);
    }
  }

  // Stop the job. Nothing is delivered, and a paid job is refunded.
  async function stopNow() {
    if (!taskId || !claim || stopBusy) return;
    setStopBusy(true);
    setNoteError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/stop`, { method: "POST", headers: { "x-claim-token": claim } });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (cancelled.current) return;
      if (res.ok) {
        setStoppedHere(true);
        setQuestion(null);
        setPlan(null);
        setPhase("cancelled");
        return;
      }
      // it finished in the same moment: the next read shows the result
      setNoteError(data.error ?? "Couldn't stop it. Try again.");
    } catch {
      setNoteError("Network error. Try again.");
    } finally {
      setStopBusy(false);
      setStopAsk(false);
    }
  }

  function reset() {
    cancelled.current = true;
    paid.current = null; // a fresh hire pays anew
    setSteer(null);
    setNotes([]);
    setNoteText("");
    setNoteError(null);
    setStopAsk(false);
    setStoppedHere(false);
    setNoted([]);
    setPlan(null);
    setPlanError(null);
    setChanging(false);
    setChange("");
    setPlanFirst(false);
    decidedPlan.current = 0;
    setHasPaid(false);
    setFollowHasPaid(false);
    setQuestion(null);
    setAnswer("");
    setAnswerError(null);
    setAsked([]);
    answeredQ.current = 0;
    followPaid.current = null;
    setTurns([]);
    setTurnAgent({ id: agentId, name: agentName, price: price ?? null });
    setHelper(null);
    setPicking(false);
    setFollow(null);
    setFollowText("");
    setFollowError(null);
    setPhase("idle");
    setOutput(null);
    setError(null);
    setHint(null);
    setTaskId(null);
    setTask("");
    setOutFiles([]);
    setReport(false);
    setSteps([]); setPages([]); setSent([]);
    setClaim(null);
  }

  // Open a conversation from the library here again: its finished turns above, its latest turn in hand, and from
  // there everything a conversation can do (a follow-up, another agent, an answer the job is waiting on).
  async function resume(thread: string) {
    if (opening || phase === "hiring" || phase === "running") return;
    setOpening(true);
    const all = await readConversation(thread, memoryKey);
    setOpening(false);
    const live = (t: { status: string }) => t.status === "completed" || t.status === "queued" || t.status === "running" || t.status === "waiting";
    const at = all ? all.findLastIndex(live) : -1;
    if (!all || at < 0) { setError("That conversation could not be opened. Try again from your library."); return; }
    const last = all[at];
    reset();
    cancelled.current = false;
    setTurns(all.slice(0, at).filter((t) => t.status === "completed").map((t) => ({ taskId: t.taskId, claim: t.claimToken, task: t.task, output: t.output ?? "", outFiles: t.outputFiles, agentName: t.agent.name })));
    setTurnAgent({ id: last.agent.id, name: last.agent.name, price: last.agent.price });
    setTask(last.task);
    setTaskId(last.taskId);
    setClaim(last.claimToken);
    setPhase("running");
    poll(last.taskId, last.claimToken, 0);
  }
  // A conversation opened from the library on the dashboard arrives as ?continue=<thread>.
  const arrived = useRef(false);
  useEffect(() => {
    if (!canLibrary || !memoryKey || arrived.current) return;
    arrived.current = true;
    const url = new URL(window.location.href), thread = url.searchParams.get("continue");
    if (!thread) return;
    url.searchParams.delete("continue");
    window.history.replaceState(null, "", url.toString());
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opened once after mount, from the address the person arrived with
    void resume(thread);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when this browser's key is known
  }, [canLibrary, memoryKey]);

  // A starter job: its words go in the box, and its sample file is fetched and attached as if the person had
  // picked it. Nothing is hired until the person presses the button.
  async function pickStarter(s: StarterJob) {
    if (starting || phase !== "idle") return;
    setTask(s.task);
    setError(null);
    if (!s.sample || files.some((f) => f.name === s.sample!.name)) return;
    setStarting(s.id);
    try {
      const got = await fetch(s.sample.path);
      if (!got.ok) throw new Error("sample");
      const body = new FormData();
      body.append("file", new File([await got.blob()], s.sample.name, { type: s.sample.type }));
      const r = await fetch("/api/files", { method: "POST", body });
      const d = (await r.json().catch(() => ({}))) as { file?: { id: string; name: string; size: number; kind: Attached["kind"] }; fileToken?: string };
      if (!r.ok || !d.file || !d.fileToken) throw new Error("upload");
      const added = { id: d.file.id, token: d.fileToken, name: d.file.name, size: d.file.size, kind: d.file.kind };
      setFiles((had) => [...had, added]);
    } catch {
      setError(`The sample file ${s.sample.name} could not be attached. Attach a file of your own, or hire without one.`);
    } finally {
      setStarting(null);
    }
  }

  // ── Paid agent we can't settle in-browser (SOL price, or wallet config unset):
  // point at the API/MCP, which pay per task.
  if (isPaid && !canPayInBrowser) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5 mb-10">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">Hire {agentName}</p>
          <span className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 rounded-md">{price} / task</span>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Paid agents settle with a single on-chain payment (x402), the payment is the authorization, no account
          needed. Hire via the <Link href="/docs/sdk" className="text-teal-600 dark:text-teal-400 hover:underline">API or MCP</Link>.
        </p>
      </div>
    );
  }

  const payAndHire = canPayInBrowser;
  // more than one agent has worked on this conversation: each answer says whose it is
  const manyAgents = turns.some((t) => t.agentName !== turnAgent.name);

  return (
    <div className="rounded-lg border border-teal-200 dark:border-teal-900/50 p-5 mb-10">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm font-semibold text-gray-900 dark:text-white">Hire {agentName}</p>
        {payAndHire ? (
          <span className="text-xs font-mono text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900/50 px-2 py-0.5 rounded-full">{price} / task</span>
        ) : (
          <span className="text-xs font-medium text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900/50 px-2 py-0.5 rounded-full">Free lane</span>
        )}
      </div>

      {turns.length > 0 && (
        <div>
          {turns.map((t, i) => <EarlierTurn key={t.taskId} n={i + 1} turn={t} named={manyAgents} />)}
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">You, turn {turns.length + 1}</p>
          <p className="mb-3 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{task}</p>
        </div>
      )}

      {(phase === "idle" || phase === "hiring" || (phase === "error" && !taskId)) && (
        <>
          {starters.length > 0 && phase === "idle" && turns.length === 0 && (
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[11px] text-gray-400 dark:text-gray-500">Try one</span>
              {starters.map((s) => (
                <button key={s.id} type="button" onClick={() => void pickStarter(s)} disabled={Boolean(starting)} title={s.sample ? `Fills the box and attaches ${s.sample.name}` : "Fills the box"} className={`rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-60 ${task === s.task ? "border-teal-400 bg-teal-50 text-teal-800 dark:border-teal-700 dark:bg-teal-950/30 dark:text-teal-300" : "border-gray-200 text-gray-700 hover:border-teal-400 hover:text-teal-700 dark:border-gray-700 dark:text-gray-200 dark:hover:border-teal-600 dark:hover:text-teal-400"}`}>
                  {starting === s.id ? "Attaching…" : s.label}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={`Describe the task for ${agentName}…`}
            rows={3}
            disabled={phase === "hiring"}
            className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:border-teal-400 disabled:opacity-60 resize-y"
          />
          <FileAttach agentId={agentId} paid={payAndHire} files={files} onChange={setFiles} disabled={phase === "hiring"} report={report} onReport={setReport} />
          {canRemember && memoryKey && (
            <AgentMemory agentId={agentId} agentName={agentName} memoryKey={memoryKey} off={memoryOff} onOff={setMemoryOff} refresh={memoryRead} disabled={phase === "hiring"} />
          )}
          {canPlan && (
            <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
              <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} disabled={phase === "hiring"} className="mt-0.5 h-3.5 w-3.5 accent-teal-600" />
              <span>
                Show me the plan first
                <span className="block text-[11px] text-gray-400 dark:text-gray-500">{agentName} says what it will do, and starts only when you approve.{payAndHire ? " Cancel at the plan and your payment is refunded." : ""}</span>
              </span>
            </label>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button
              onClick={payAndHire ? hirePaid : hireFree}
              disabled={!task.trim() || phase === "hiring"}
              className="text-sm font-medium px-4 py-2 rounded-md bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white transition-colors"
            >
              {phase === "hiring"
                ? (payAndHire && !hasPaid ? "Paying…" : "Starting…")
                : payAndHire
                  ? (hasPaid ? "Retry hire" : `Pay ${price} & Hire`)
                  : "Hire"}
            </button>
            <VoiceInput disabled={phase === "hiring"} onText={(said) => setTask(add(said))} />
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {payAndHire
                ? "Pay with MetaMask · leaves a verifiable receipt · payment is the authorization"
                : "Runs immediately · leaves a verifiable receipt · 3 free hires"}
            </span>
          </div>
          {phase === "hiring" && hint && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
          {error && <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">{error}</p>}
          {canLibrary && memoryKey && turns.length === 0 && (
            <AgentWork agentId={agentId} agentName={agentName} memoryKey={memoryKey} onContinue={(thread) => void resume(thread)} refresh={libraryRead} disabled={opening || phase === "hiring"} />
          )}
        </>
      )}

      {phase === "running" && (
        <div className="py-2">
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 animate-spin" />
            {turnAgent.name} is working on it…
          </div>
          <StepList steps={steps} live />
          {/* Stop and steer: say something to the agent while it works, or stop the job */}
          {steer && (steer.open || steer.stoppable || notes.length > 0) && (
            <div className="mt-3.5 border-t border-gray-100 pt-3 dark:border-gray-800">
              {notes.length > 0 && (
                <ul className="mb-2.5 space-y-1">
                  {notes.map((nt) => (
                    <li key={nt.n} className="flex items-baseline gap-2 text-xs">
                      <span className="min-w-0 break-words text-gray-700 dark:text-gray-300">{nt.text}</span>
                      <span className={`shrink-0 text-[11px] ${nt.deliveredAt ? "text-teal-600 dark:text-teal-400" : "text-gray-400 dark:text-gray-500"}`}>{nt.deliveredAt ? "read" : "sent"}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {steer.open && (
                  <>
                    <input
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void sendNoteNow(); }}
                      placeholder="Tell it something while it works…"
                      maxLength={1000}
                      disabled={noteBusy}
                      className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-teal-400 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                    />
                    <button onClick={() => void sendNoteNow()} disabled={!noteText.trim() || noteBusy} className="shrink-0 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 transition-colors hover:border-teal-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
                      {noteBusy ? "Sending…" : "Send"}
                    </button>
                    <VoiceInput what="a note" disabled={noteBusy} onText={(said) => setNoteText(add(said))} />
                  </>
                )}
                {steer.stoppable && !stopAsk && (
                  <button onClick={() => setStopAsk(true)} className="shrink-0 px-1 py-1.5 text-sm text-gray-500 hover:text-gray-900 hover:underline dark:text-gray-400 dark:hover:text-white">
                    Stop
                  </button>
                )}
              </div>
              {stopAsk && (
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
                  Stop the job? Nothing is delivered{hasPaid ? ", and your payment is refunded" : ""}.
                  <button onClick={() => void stopNow()} disabled={stopBusy} className="font-medium text-gray-900 underline disabled:opacity-50 dark:text-white">{stopBusy ? "Stopping…" : "Yes, stop it"}</button>
                  <button onClick={() => setStopAsk(false)} disabled={stopBusy} className="text-gray-500 hover:underline dark:text-gray-400">Keep going</button>
                </p>
              )}
              {noteError && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{noteError}</p>}
            </div>
          )}
        </div>
      )}

      {/* The agent stopped to ask. The job waits here for the answer, and goes on with a best guess if none comes. */}
      {phase === "asking" && question && (
        <div className="py-1">
          <StepList steps={steps} />
          <div className="mt-3 rounded-md border border-teal-200 bg-teal-50/50 p-3.5 dark:border-teal-900/50 dark:bg-teal-950/20">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">{turnAgent.name} asks</p>
            <p className="whitespace-pre-wrap break-words text-sm text-gray-900 dark:text-white">{question.text}</p>
            {question.choices && question.choices.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {question.choices.map((c) => (
                  <button key={c} type="button" onClick={() => void sendAnswer(c)} disabled={answerBusy} className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-left text-sm text-gray-800 transition-colors hover:border-teal-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
                    {c}
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={question.choices?.length ? "Or write your own answer…" : "Your answer…"}
              rows={2}
              disabled={answerBusy}
              className="mt-3 w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-teal-400 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <button onClick={() => void sendAnswer(answer)} disabled={!answer.trim() || answerBusy} className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-50">
                {answerBusy ? "Sending…" : "Answer"}
              </button>
              <VoiceInput what="your answer" disabled={answerBusy} onText={(said) => setAnswer(add(said))} />
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                Same job, nothing more to pay. With no answer by {new Date(question.answerBy).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} it goes on with its best guess.
              </span>
            </div>
            {answerError && <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">{answerError}</p>}
          </div>
        </div>
      )}

      {/* Plan first. The job waits here until the plan is approved, changed or cancelled. */}
      {phase === "planning" && plan && (
        <div className="py-1">
          <StepList steps={steps} />
          <div className="mt-3 rounded-md border border-teal-200 bg-teal-50/50 p-3.5 dark:border-teal-900/50 dark:bg-teal-950/20">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">{turnAgent.name}&apos;s plan{plan.n > 1 ? `, changed ${plan.n - 1 === 1 ? "once" : `${plan.n - 1} times`}` : ""}</p>
            {/* shown whole: a plan is short, and nobody should approve one they had to scroll a box to read */}
            <div className="break-words rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
              <MarkdownOutput text={plan.text} />
            </div>
            <p className="mt-2.5 text-xs text-gray-600 dark:text-gray-300">
              <span className="font-semibold text-gray-900 dark:text-white">Price: {plan.price ?? "free"}.</span>{" "}
              {plan.price ? "It is held until you approve. Cancel and it is refunded." : "Nothing to pay."}
            </p>
            {changing && (
              <textarea
                value={change}
                onChange={(e) => setChange(e.target.value)}
                placeholder="What should be different?"
                rows={2}
                disabled={planBusy}
                className="mt-3 w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-teal-400 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {changing ? (
                <>
                  <button onClick={() => void decide("change")} disabled={!change.trim() || planBusy} className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-50">
                    {planBusy ? "Sending…" : "Send the change"}
                  </button>
                  <VoiceInput what="the change" disabled={planBusy} onText={(said) => setChange(add(said))} />
                  <button onClick={() => { setChanging(false); setChange(""); }} disabled={planBusy} className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 transition-colors hover:border-gray-400 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200">
                    Back
                  </button>
                </>
              ) : (
                <>
                  <button onClick={() => void decide("approve")} disabled={planBusy} className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-50">
                    {planBusy ? "Sending…" : "Approve and start"}
                  </button>
                  {plan.changesLeft > 0 && (
                    <button onClick={() => setChanging(true)} disabled={planBusy} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800 transition-colors hover:border-teal-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100">
                      Ask for a change
                    </button>
                  )}
                  <button onClick={() => void decide("cancel")} disabled={planBusy} className="px-2 py-2 text-sm text-gray-500 hover:underline disabled:opacity-50 dark:text-gray-400">
                    Cancel
                  </button>
                </>
              )}
            </div>
            <p className="mt-2.5 text-[11px] text-gray-500 dark:text-gray-400">
              With no answer by {new Date(plan.answerBy).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} it goes on with this plan.
            </p>
            {planError && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{planError}</p>}
          </div>
        </div>
      )}

      {/* Called off at the plan: nothing was done. */}
      {phase === "cancelled" && (
        <div>
          <p className="text-sm text-gray-700 dark:text-gray-300">{stoppedHere ? "Stopped. Nothing was delivered" : "Cancelled. No work was done"}{hasPaid ? ", and your payment is refunded" : ""}.</p>
          <div className="mt-3 flex items-center gap-4">
            {taskId && (
              <a href={`/r/${encodeURIComponent(taskId)}`} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 hover:underline dark:text-teal-400">
                View the receipt →
              </a>
            )}
            <button onClick={reset} className="text-xs text-gray-500 hover:underline dark:text-gray-400">
              Hire again
            </button>
          </div>
        </div>
      )}

      {/* The hire already started (a task exists), then the result failed or
          couldn't be read. Retrying the hire can't help, the payment is spent on
          this task, so point to the receipt and let them start a fresh hire. */}
      {phase === "error" && taskId && (
        <div>
          <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>
          <div className="mt-3 flex items-center gap-4">
            <a href={`/r/${encodeURIComponent(taskId)}`} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 dark:text-teal-400 hover:underline">
              View the receipt →
            </a>
            <button onClick={reset} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
              Hire again
            </button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400 mb-1.5">{manyAgents ? `${turnAgent.name}: result` : "Result"}</p>
          <div className="rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 p-3 break-words max-h-80 overflow-auto">
            {output ? <MarkdownOutput text={output} /> : <span className="text-sm text-gray-400">(empty response)</span>}
          </div>
          <OutputFiles files={outFiles} />
          {noted.length > 0 && (
            <p className="mt-3 break-words text-xs text-gray-500 dark:text-gray-400">
              <span className="text-gray-700 dark:text-gray-300">Noted for next time:</span> {noted.map((m) => m.text).join(" · ")}
            </p>
          )}
          {asked.length > 0 && (
            <div className="mt-3 space-y-1.5 text-xs text-gray-500 dark:text-gray-400">
              {asked.map((q) => (
                <p key={q.n} className="break-words">
                  <span className="text-gray-700 dark:text-gray-300">It asked:</span> {q.text}{" "}
                  <span className="text-gray-700 dark:text-gray-300">{q.answeredHow === "person" ? "You answered:" : "No answer came, so it went on with its best guess."}</span>{q.answeredHow === "person" ? ` ${q.answer ?? ""}` : ""}
                </p>
              ))}
            </div>
          )}
          <FormsSent sent={sent} />
          <PagesVisited pages={pages} />
          {steps.length > 0 && (
            <details className="mt-3 group">
              <summary className="cursor-pointer select-none text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white">
                How it got there, {steps.length} {steps.length === 1 ? "step" : "steps"}
              </summary>
              <StepList steps={steps} />
            </details>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {taskId && (
              <a href={`/r/${encodeURIComponent(taskId)}`} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-xs text-teal-600 dark:text-teal-400 hover:underline">
                View the receipt →
              </a>
            )}
            <button onClick={reset} className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400 hover:underline">
              Hire again
            </button>
            {taskId && claim && output && <VoiceOutput taskId={taskId} claimToken={claim} />}
          </div>

          {/* A note that did not reach the agent before it finished: it can go as a follow-up instead */}
          {notes.some((nt) => !nt.deliveredAt) && (
            <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">
              It finished before it read your note{notes.filter((nt) => !nt.deliveredAt).length === 1 ? "" : "s"}.{" "}
              {follow?.open && (
                <button onClick={() => setFollowText(notes.filter((nt) => !nt.deliveredAt).map((nt) => nt.text).join("\n"))} className="font-medium text-teal-700 underline dark:text-teal-400">
                  Put it in a follow-up
                </button>
              )}
            </p>
          )}

          {/* Say more: the same agent, the conversation so far and the files from before */}
          {follow?.open && taskId && claim && (
            <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-800">
              <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">Follow up</p>
                {helper && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[11px] text-teal-800 dark:border-teal-900/50 dark:bg-teal-950/30 dark:text-teal-300">
                    to {helper.name}{helper.price ? `, ${helper.price}` : ""}
                    <button type="button" onClick={() => setHelper(null)} disabled={followBusy} aria-label={`Not ${helper.name}: back to ${turnAgent.name}`} className="font-semibold hover:text-teal-950 dark:hover:text-white">×</button>
                  </span>
                )}
                {canBringIn && !helper && (
                  <button type="button" onClick={() => setPicking((o) => !o)} disabled={followBusy} className="text-xs text-teal-700 hover:underline disabled:opacity-50 dark:text-teal-400">
                    {picking ? "Keep it with " + turnAgent.name : "Bring in another agent"}
                  </button>
                )}
              </div>
              {canBringIn && picking && !helper && (
                <BringIn exclude={[turnAgent.id]} canPay={Boolean(receiver)} disabled={followBusy} onPick={(a) => { setHelper(a); setPicking(false); followPaid.current = null; setFollowHasPaid(false); }} />
              )}
              <textarea
                value={followText}
                onChange={(e) => setFollowText(e.target.value)}
                placeholder={`Ask ${target.name} for a change, a detail or the next step…`}
                rows={2}
                disabled={followBusy}
                className="w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-teal-400 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
              <FileAttach agentId={target.id} paid={targetPays} files={files} onChange={setFiles} disabled={followBusy} report={report} onReport={setReport} />
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <button
                  onClick={sendFollowUp}
                  disabled={!followText.trim() || followBusy}
                  className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-50"
                >
                  {followBusy
                    ? (targetPays && !followHasPaid ? "Paying…" : "Sending…")
                    : targetPays
                      ? (followHasPaid ? "Retry follow-up" : `Pay ${target.price} & send${helper ? ` to ${helper.name}` : ""}`)
                      : helper ? `Send to ${helper.name}` : "Send follow-up"}
                </button>
                <VoiceInput what="your follow-up" disabled={followBusy} onText={(said) => setFollowText(add(said))} />
                <span className="text-[11px] text-gray-400 dark:text-gray-500">
                  {helper
                    ? `${helper.name} joins · it gets the conversation and the files · ${targetPays ? "paid for its own part" : "uses one free hire of its own"}`
                    : targetPays
                      ? "Same agent · it keeps the conversation and the files · its own receipt"
                      : "Same agent · it keeps the conversation and the files · uses one free hire"}
                </span>
              </div>
              {followError && <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">{followError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
