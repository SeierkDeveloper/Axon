"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { payForBuild } from "@/lib/buildPaymentClient";
import MarkdownOutput from "@/components/MarkdownOutput";
import FileAttach, { type Attached } from "@/components/FileAttach";
import OutputFiles, { type OutputFile } from "@/components/OutputFiles";
import VoiceInput from "@/components/VoiceInput";
import VoiceOutput from "@/components/VoiceOutput";

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
interface Turn { taskId: string; claim: string; task: string; output: string; outFiles: OutputFile[] }

/** An earlier turn, shown above the one in hand. */
function EarlierTurn({ n, turn }: { n: number; turn: Turn }) {
  return (
    <div className="mb-4 border-b border-gray-100 pb-4 dark:border-gray-800">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">You, turn {n}</p>
      <p className="whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{turn.task}</p>
      <div className="mt-2 max-h-56 overflow-auto break-words rounded-md border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-800 dark:bg-gray-900/40">
        {turn.output ? <MarkdownOutput text={turn.output} /> : <span className="text-sm text-gray-400">(empty response)</span>}
      </div>
      <OutputFiles files={turn.outFiles} />
      <a href={`/r/${encodeURIComponent(turn.taskId)}`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-teal-600 hover:underline dark:text-teal-400">
        Receipt →
      </a>
    </div>
  );
}

/** The steps of a hire, oldest first. While it runs the last one is the one happening now. */
function StepList({ steps, live }: { steps: { n: number; text: string }[]; live?: boolean }) {
  if (!steps.length) return null;
  return (
    <ol className="mt-2.5 space-y-1.5 border-l border-gray-200 pl-3 dark:border-gray-700" aria-live={live ? "polite" : undefined}>
      {steps.map((s, i) => {
        const now = live && i === steps.length - 1;
        return (
          <li key={s.n} className={`relative text-xs leading-snug break-words ${now ? "text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"}`}>
            <span className={`absolute -left-[15.5px] top-[5px] h-1.5 w-1.5 rounded-full ${now ? "bg-teal-500 animate-pulse" : "bg-gray-300 dark:bg-gray-600"}`} />
            {s.text}
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
}: {
  agentId: string;
  agentName: string;
  isPaid: boolean;
  price?: string | null;
  receiver?: string;
  rpcUrl?: string;
  /** this agent can write a plan for the person to approve before it starts */
  canPlan?: boolean;
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
  const [steps, setSteps] = useState<{ n: number; text: string }[]>([]);
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
      const t = (await res.json()) as { status?: string; output?: string | null; outputFiles?: OutputFile[]; steps?: { n: number; text: string }[]; followUp?: { open?: boolean; turnsLeft?: number }; question?: Asked; questions?: Asked[]; plan?: OpenPlan };
      if (cancelled.current) return;
      if (Array.isArray(t.steps)) setSteps((had) => (t.steps!.length >= had.length ? t.steps! : had));
      if (Array.isArray(t.questions)) setAsked(t.questions.filter((q) => q.answeredAt));
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
        body: JSON.stringify({ from: "anonymous", to: agentId, task: task.trim(), allowQuestions: true, ...(planFirst && canPlan ? { planFirst: true } : {}), ...(files.length ? { files: files.map((f) => ({ id: f.id, token: f.token })) } : {}), ...(report ? { reportFile: true } : {}), ...(payment ?? {}) }),
      });
      const data = (await res.json()) as { taskId?: string; claimToken?: string; error?: string };
      if (cancelled.current) return;
      if (res.ok && data.taskId && data.claimToken) {
        setTaskId(data.taskId);
        setClaim(data.claimToken);
        setFiles([]); // they belong to this hire now
        setSteps([]);
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

  // Say more to the agent about the job it just finished. The same agent is hired again and is given the conversation
  // so far and the files from before; a paid agent is paid again, since this is another piece of work.
  async function sendFollowUp() {
    const said = followText.trim();
    if (!said || !taskId || !claim || output === null || followBusy) return;
    setFollowBusy(true);
    setFollowError(null);
    try {
      if (canPayInBrowser && !followPaid.current) {
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
          from: "anonymous", to: agentId, task: said, followUpOf: taskId, followUpToken: claim, allowQuestions: true,
          ...(files.length ? { files: files.map((f) => ({ id: f.id, token: f.token })) } : {}),
          ...(report ? { reportFile: true } : {}),
          ...(followPaid.current ?? {}),
        }),
      });
      const data = (await res.json()) as { taskId?: string; claimToken?: string; error?: string };
      if (cancelled.current) return;
      if (res.ok && data.taskId && data.claimToken) {
        // the turn just finished joins the conversation above, and the follow-up becomes the turn in hand
        setTurns((had) => [...had, { taskId, claim, task, output, outFiles }]);
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
        setSteps([]);
        setFiles([]);
        setFollow(null);
        setAsked([]);
        setQuestion(null);
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

  function reset() {
    cancelled.current = true;
    paid.current = null; // a fresh hire pays anew
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
    setSteps([]);
    setClaim(null);
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
          {turns.map((t, i) => <EarlierTurn key={t.taskId} n={i + 1} turn={t} />)}
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">You, turn {turns.length + 1}</p>
          <p className="mb-3 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">{task}</p>
        </div>
      )}

      {(phase === "idle" || phase === "hiring" || (phase === "error" && !taskId)) && (
        <>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={`Describe the task for ${agentName}…`}
            rows={3}
            disabled={phase === "hiring"}
            className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:border-teal-400 disabled:opacity-60 resize-y"
          />
          <FileAttach agentId={agentId} paid={payAndHire} files={files} onChange={setFiles} disabled={phase === "hiring"} report={report} onReport={setReport} />
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
            <VoiceInput disabled={phase === "hiring"} onText={(said) => setTask((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said))} />
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {payAndHire
                ? "Pay with MetaMask · leaves a verifiable receipt · payment is the authorization"
                : "Runs immediately · leaves a verifiable receipt · 3 free hires"}
            </span>
          </div>
          {phase === "hiring" && hint && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
          {error && <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">{error}</p>}
        </>
      )}

      {phase === "running" && (
        <div className="py-2">
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 animate-spin" />
            {agentName} is working on it…
          </div>
          <StepList steps={steps} live />
        </div>
      )}

      {/* The agent stopped to ask. The job waits here for the answer, and goes on with a best guess if none comes. */}
      {phase === "asking" && question && (
        <div className="py-1">
          <StepList steps={steps} />
          <div className="mt-3 rounded-md border border-teal-200 bg-teal-50/50 p-3.5 dark:border-teal-900/50 dark:bg-teal-950/20">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">{agentName} asks</p>
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
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">{agentName}&apos;s plan{plan.n > 1 ? `, changed ${plan.n - 1 === 1 ? "once" : `${plan.n - 1} times`}` : ""}</p>
            <div className="max-h-80 overflow-auto break-words rounded-md border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
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
          <p className="text-sm text-gray-700 dark:text-gray-300">Cancelled. No work was done{hasPaid ? ", and your payment is refunded" : ""}.</p>
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
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400 mb-1.5">Result</p>
          <div className="rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 p-3 break-words max-h-80 overflow-auto">
            {output ? <MarkdownOutput text={output} /> : <span className="text-sm text-gray-400">(empty response)</span>}
          </div>
          <OutputFiles files={outFiles} />
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

          {/* Say more: the same agent, the conversation so far and the files from before */}
          {follow?.open && taskId && claim && (
            <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-800">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">Follow up</p>
              <textarea
                value={followText}
                onChange={(e) => setFollowText(e.target.value)}
                placeholder={`Ask ${agentName} for a change, a detail or the next step…`}
                rows={2}
                disabled={followBusy}
                className="w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-teal-400 focus:outline-none disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              />
              <FileAttach agentId={agentId} paid={payAndHire} files={files} onChange={setFiles} disabled={followBusy} report={report} onReport={setReport} />
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <button
                  onClick={sendFollowUp}
                  disabled={!followText.trim() || followBusy}
                  className="rounded-md bg-teal-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:opacity-50"
                >
                  {followBusy ? (payAndHire && !followHasPaid ? "Paying…" : "Sending…") : payAndHire ? (followHasPaid ? "Retry follow-up" : `Pay ${price} & send`) : "Send follow-up"}
                </button>
                <span className="text-[11px] text-gray-400 dark:text-gray-500">
                  {payAndHire
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
