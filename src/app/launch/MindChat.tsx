"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/WalletProvider";

/**
 * Talk to the mind, on the token's page: anyone can ask the token's mind a question and read its answer in its own
 * voice, under what it has thought. Nothing asked here changes what the mind does; its own treasury pays for the
 * answer. A visitor asks as a visitor; a wallet that signs in is named, shortened, beside its question.
 */

export interface ChatItem {
  id: number;
  asker: string | null;
  question: string;
  answer: string;
  modelLabel: string;
  standin: boolean;
  at: string;
}

const LABEL = "font-mono text-[10px] uppercase tracking-[0.2em] text-gray-400";
const ago = (iso: string, now: number): string => {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
};

const EXAMPLES = ["Why did you do what you did today?", "What are you watching right now?", "What do you make of the chart?", "What would make you buy back?"];

export default function MindChat({ token, symbol, chats, maxChars, now, stopped, onAsked }: {
  token: string;
  symbol: string | null;
  /** the exchanges already on the page, newest first */
  chats: ChatItem[];
  maxChars: number;
  now: number;
  /** a stopped or paused mind does not answer; the page says so above, this only keeps the box quiet */
  stopped: boolean;
  /** the answer that just came back, so the page shows it at once */
  onAsked: (chat: ChatItem) => void;
}) {
  const { address, apiKey, signIn, busy: walletBusy } = useWallet();
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "asking">("idle");
  const [note, setNote] = useState<string | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  // the answer that just arrived is marked for a moment so the eye finds it in the list
  useEffect(() => {
    if (fresh === null) return;
    const t = setTimeout(() => setFresh(null), 4000);
    return () => clearTimeout(t);
  }, [fresh]);

  const ask = async () => {
    const q = text.replace(/\s+/g, " ").trim();
    if (q.length < 2) { setNote("Ask it something."); return; }
    setState("asking"); setNote(null);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const r = await fetch(`/api/minds/tokens/${token}/chat`, { method: "POST", headers, body: JSON.stringify({ question: q }) });
      const body = (await r.json().catch(() => ({}))) as { chat?: ChatItem; error?: string };
      if (!r.ok || !body.chat) { setNote(body.error ?? "The mind could not answer just now. Try again in a minute."); return; }
      setText("");
      setFresh(body.chat.id);
      onAsked(body.chat);
    } catch {
      setNote("The question did not get through. Check your connection and try again.");
    } finally {
      setState("idle");
    }
  };

  const signedIn = Boolean(address && apiKey);
  return (
    <div>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Ask it anything about what it does: why it moved, what it is watching, what it makes of the chart. It answers in its own voice from its own numbers, plan and log. A question never changes what it does, and its own treasury pays for the answer.
      </p>
      {!stopped && (
        <div className="mt-4">
          <label htmlFor={`ask-${token}`} className={`mb-1.5 block ${LABEL}`}>Ask {symbol ? `$${symbol}` : "its mind"}</label>
          <textarea
            id={`ask-${token}`}
            ref={box}
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, maxChars))}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (state === "idle") void ask(); } }}
            rows={2}
            placeholder={EXAMPLES[chats.length % EXAMPLES.length]}
            className="w-full resize-none rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none dark:border-gray-800 dark:bg-gray-950 dark:text-gray-100 dark:focus:border-gray-600"
          />
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <button type="button" onClick={() => void ask()} disabled={state === "asking" || text.trim().length < 2} className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
              {state === "asking" ? "Asking…" : "Ask"}
            </button>
            {signedIn ? (
              <span className="text-xs text-gray-400">Asking as {address!.slice(0, 6)}…{address!.slice(-4)}.</span>
            ) : (
              <button type="button" onClick={() => void signIn()} disabled={walletBusy} className="text-xs text-gray-500 underline decoration-gray-300 underline-offset-2 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:decoration-gray-700 dark:hover:text-white">
                {walletBusy ? "Check your wallet…" : "Sign in with your wallet to ask as yourself"}
              </button>
            )}
            <span className="ml-auto font-mono text-[11px] tabular-nums text-gray-400">{text.length} / {maxChars}</span>
          </div>
          {note && <p role="status" className="mt-2 text-sm text-gray-600 dark:text-gray-300">{note}</p>}
        </div>
      )}
      {chats.length === 0 ? (
        <p className="mt-5 text-sm text-gray-500 dark:text-gray-400">Nobody has asked it anything yet.</p>
      ) : (
        <ol className="mt-5 space-y-5">
          {chats.map((c) => (
            <li key={c.id} className={c.id === fresh ? "rounded-xl bg-white px-3 py-2 ring-1 ring-gray-300 transition dark:bg-gray-950 dark:ring-gray-700" : ""}>
              <p className="text-sm leading-relaxed text-gray-500 dark:text-gray-400"><span className="font-mono text-[11px] text-gray-400">{c.asker ?? "a visitor"} asked</span> {c.question}</p>
              <p className="mt-1.5 border-l-2 border-gray-300 pl-3 text-sm leading-relaxed dark:border-gray-700">{c.answer}</p>
              <p className="mt-1.5 font-mono text-[11px] text-gray-400" suppressHydrationWarning>{ago(c.at, now)} ago · {c.modelLabel}</p>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-4 text-xs text-gray-400">Five questions a minute each. The mind answers from what it has in front of it and says when it does not know. It never predicts a price and never gives advice.</p>
    </div>
  );
}
