"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AgentCore, { type CoreState } from "@/components/AgentCore";
import MarkdownOutput from "@/components/MarkdownOutput";
import { useWallet } from "@/components/WalletProvider";
import { ActionCard, Card, type ActionView, type CardData } from "./MyloCards";

// Mylo's page: Mylo centred and large, its name under it, then the conversation, the box to type in and, before the
// first message, things to ask. Talking to Mylo needs a signed-in wallet; without one the box is a sign-in button.
// Mylo's answer streams in as it is written and the face shows what it is doing: thinking while it reads, talking
// while it writes, happy when it is done.
// When Mylo looks something up, what it found shows under its words, and a hire it proposes shows as a card the
// person confirms and pays for themselves.

interface Msg { id: string; role: "user" | "assistant"; content: string; failed?: boolean; cards?: CardData[]; actions?: ActionView[]; working?: string | null }
interface Conv { id: string; title: string | null; updatedAt: string }

const SUGGESTIONS = [
  "What can I do on Axon?",
  "How do I build an agent that earns for me?",
  "How does hiring an agent work?",
  "What happens to $AXON trading fees?",
];

/** A random id this browser keeps, so a visitor's conversations are theirs alone. */
function visitorId(): string {
  try {
    let v = localStorage.getItem("mylo.visitor");
    if (!v) { v = crypto.randomUUID(); localStorage.setItem("mylo.visitor", v); }
    return v;
  } catch {
    return "";
  }
}

export default function MyloClient() {
  const { apiKey, signIn, busy: walletBusy } = useWallet();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [face, setFace] = useState<CoreState>("idle");
  const [left, setLeft] = useState<{ left: number; perDay: number; signedIn: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const faceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "content-type": "application/json" };
    const v = visitorId();
    if (v) h["x-mylo-visitor"] = v;
    if (apiKey) h.authorization = `Bearer ${apiKey}`;
    return h;
  }, [apiKey]);

  const loadList = useCallback(async () => {
    const r = await fetch("/api/mylo/conversations", { headers: headers(), cache: "no-store" }).catch(() => null);
    if (!r?.ok) return;
    const j = (await r.json()) as { conversations: Conv[]; left: number; perDay: number; signedIn: boolean };
    setConvs(j.conversations);
    setLeft({ left: j.left, perDay: j.perDay, signedIn: j.signedIn });
  }, [headers]);

  // signing in or out changes whose conversations these are: start fresh and load theirs
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await fetch("/api/mylo/conversations", { headers: headers(), cache: "no-store" }).catch(() => null);
      if (!alive || !r?.ok) return;
      const j = (await r.json()) as { conversations: Conv[]; left: number; perDay: number; signedIn: boolean };
      setConvs(j.conversations);
      setLeft({ left: j.left, perDay: j.perDay, signedIn: j.signedIn });
      setCurrent(null);
      setMsgs([]);
    })();
    return () => { alive = false; };
  }, [headers]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs]);

  const showFace = (s: CoreState, forMs?: number) => {
    if (faceTimer.current) clearTimeout(faceTimer.current);
    setFace(s);
    if (forMs) faceTimer.current = setTimeout(() => setFace("idle"), forMs);
  };

  const open = async (id: string) => {
    setNotice(null);
    const r = await fetch(`/api/mylo/conversations/${id}`, { headers: headers(), cache: "no-store" }).catch(() => null);
    if (!r?.ok) return setNotice("That conversation couldn't be opened.");
    const j = (await r.json()) as { messages: Msg[] };
    setCurrent(id);
    setMsgs(j.messages);
  };

  const fresh = () => { setCurrent(null); setMsgs([]); setNotice(null); showFace("idle"); boxRef.current?.focus(); };

  const send = async (raw?: string) => {
    const said = (raw ?? text).trim();
    if (!said || sending) return;
    setText("");
    setNotice(null);
    setSending(true);
    const mine: Msg = { id: `me-${Date.now()}`, role: "user", content: said };
    const reply: Msg = { id: `mylo-${Date.now()}`, role: "assistant", content: "" };
    setMsgs((m) => [...m, mine, reply]);
    showFace("drafting");
    try {
      const r = await fetch("/api/mylo/chat", { method: "POST", headers: headers(), body: JSON.stringify({ text: said, conversationId: current }) });
      if (!r.ok || !r.body) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Mylo couldn't answer just now.");
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as { type: string; id?: string; state?: string; delta?: string; message?: string; label?: string; card?: CardData; action?: ActionView };
          const patch = (f: (x: Msg) => Msg) => setMsgs((m) => m.map((x) => (x.id === reply.id ? f(x) : x)));
          if (e.type === "conversation" && e.id) setCurrent(e.id);
          else if (e.type === "face") showFace(e.state === "thinking" ? "drafting" : e.state === "working" ? "testing" : e.state === "happy" ? "ready" : e.state === "failed" ? "failed" : "idle", e.state === "happy" ? 2200 : e.state === "failed" ? 3500 : undefined);
          else if (e.type === "tool" && e.label) patch((x) => ({ ...x, working: e.label }));
          else if (e.type === "card" && e.card) patch((x) => ({ ...x, cards: [...(x.cards ?? []), e.card!] }));
          else if (e.type === "action" && e.action) patch((x) => ({ ...x, actions: [...(x.actions ?? []), e.action!] }));
          else if (e.type === "text" && e.delta) patch((x) => ({ ...x, working: null, content: x.content + e.delta }));
          else if (e.type === "error") {
            setMsgs((m) => m.map((x) => (x.id === reply.id ? { ...x, content: x.content || (e.message ?? "Mylo couldn't answer just now."), failed: !x.content } : x)));
            showFace("failed", 3500);
          }
        }
      }
    } catch (err) {
      setMsgs((m) => m.map((x) => (x.id === reply.id ? { ...x, content: err instanceof Error ? err.message : "Mylo couldn't answer just now.", failed: true } : x)));
      showFace("failed", 3500);
    } finally {
      setMsgs((m) => m.map((x) => (x.id === reply.id ? { ...x, working: null } : x)));
      setSending(false);
      void loadList();
      boxRef.current?.focus();
    }
  };

  // a confirmed hire finished: its answers arrive as Mylo's next message
  const arrived = useCallback((m: { id: string; content: string }) => {
    setMsgs((all) => (all.some((x) => x.id === m.id) ? all : [...all, { id: m.id, role: "assistant", content: m.content }]));
    showFace("ready", 2200);
  }, []);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  const empty = msgs.length === 0;
  const signedIn = Boolean(apiKey);
  const out = signedIn && left !== null && left.left <= 0;

  return (
    <div className="relative min-h-[calc(100vh-3.5rem)]">
      <div className="mx-auto flex max-w-3xl flex-col px-4 pt-24 pb-10 sm:px-6">
        {/* Mylo, centred */}
        <div className="mylo-face flex flex-col items-center text-center">
          <AgentCore state={face} size={empty ? 240 : 150} label={face === "drafting" ? "Mylo is thinking" : "Mylo"} />
          <p className="mt-10 font-mono text-xs uppercase tracking-[0.25em] text-gray-400 dark:text-gray-500">Axon&apos;s own AI</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-gray-900 dark:text-white">Mylo</h1>
          {empty && <p className="mt-3 max-w-md text-[15px] text-gray-500 dark:text-gray-400">Tell Mylo what you need. Ask about agents, building your own, or anything on Axon.</p>}
        </div>

        {/* the conversation */}
        {!empty && (
          <div className="mt-10 flex flex-col gap-5" aria-live="polite">
            {msgs.map((m) => (
              m.role === "user" ? (
                <div key={m.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-gray-900 px-4 py-3 text-[15px] leading-relaxed text-white dark:bg-white dark:text-gray-900">{m.content}</div>
              ) : (
                <div key={m.id} className="flex max-w-[92%] gap-3">
                  <span className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-gray-400">Mylo</span>
                  <div className="min-w-0 flex-1">
                    <div className={`rounded-2xl rounded-tl-md px-4 py-3 text-[15px] leading-relaxed ${m.failed ? "border border-red-200 text-red-600 dark:border-red-900 dark:text-red-400" : "bg-gray-50 text-gray-800 dark:bg-gray-900/70 dark:text-gray-200"}`}>
                      {m.content ? <MarkdownOutput text={m.content} /> : !m.working && <span className="inline-flex gap-1 py-1" aria-label="Mylo is thinking"><i className="mylo-dot" /><i className="mylo-dot" /><i className="mylo-dot" /></span>}
                      {m.working && <p className={`flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 ${m.content ? "mt-2" : ""}`}><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-900 dark:bg-white" />{m.working}…</p>}
                    </div>
                    {/* a proposal names its agents itself, so the list it was picked from isn't shown again */}
                    {m.cards?.filter((c) => !(m.actions?.length && c.kind === "agents")).map((c, i) => <Card key={i} card={c} />)}
                    {m.actions?.map((a) => <ActionCard key={a.id} initial={a} headers={headers} onMessage={arrived} />)}
                  </div>
                </div>
              )
            ))}
            <div ref={endRef} />
          </div>
        )}

        {/* the box to type in, or for someone not signed in the way to sign in: pinned to the bottom on a solid strip
            once there is a conversation, so it scrolls away behind it */}
        <div className={`mylo-input-bar sticky bottom-0 z-10 bg-background pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] ${empty ? "mt-10" : "mt-8"}`}>
          {signedIn ? (
            <div className="rounded-2xl border border-gray-200 bg-white p-2 shadow-[0_20px_40px_-24px_rgba(10,10,10,.35)] dark:border-gray-800 dark:bg-gray-950">
              <div className="flex items-end gap-2">
                <textarea ref={boxRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={1} maxLength={2000} disabled={out}
                  placeholder={out ? "That's today's messages. Come back tomorrow." : "Ask Mylo anything"} aria-label="Message Mylo"
                  className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-white" />
                <button type="button" onClick={() => void send()} disabled={sending || !text.trim() || out} aria-label="Send"
                  className="mb-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gray-900 text-white transition hover:bg-gray-700 disabled:opacity-30 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-5 text-center shadow-[0_20px_40px_-24px_rgba(10,10,10,.35)] sm:flex-row sm:justify-between sm:py-3 sm:pl-5 sm:pr-2 sm:text-left dark:border-gray-800 dark:bg-gray-950">
              <p className="text-[15px] text-gray-600 dark:text-gray-300">Sign in with your wallet to talk to Mylo. It&apos;s free.</p>
              <button type="button" onClick={() => void signIn()} disabled={walletBusy}
                className="h-10 shrink-0 rounded-xl bg-gray-900 px-5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                {walletBusy ? "Signing in…" : "Sign in"}
              </button>
            </div>
          )}
          {signedIn && (
            <div className="mt-2 flex items-center justify-between gap-3 px-1 text-xs text-gray-400">
              <span className="min-w-0 truncate">
                {left ? <>{left.left} of {left.perDay}<span className="hidden sm:inline"> messages</span> left today</> : " "}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {!empty && <button type="button" onClick={fresh} className="whitespace-nowrap underline underline-offset-2 hover:text-gray-900 dark:hover:text-white"><span className="sm:hidden">New</span><span className="hidden sm:inline">New conversation</span></button>}
                {convs.length > 0 && (
                  <select value={current ?? ""} onChange={(e) => (e.target.value ? void open(e.target.value) : fresh())} aria-label="Earlier conversations"
                    className="w-[120px] truncate rounded-md border border-gray-200 bg-transparent px-2 py-1 text-xs text-gray-500 sm:w-auto sm:max-w-[220px] dark:border-gray-800">
                    <option value="">Earlier conversations</option>
                    {convs.map((c) => <option key={c.id} value={c.id}>{c.title ?? "Untitled"}</option>)}
                  </select>
                )}
              </span>
            </div>
          )}
          {notice && <p className="mt-2 px-1 text-xs text-red-600 dark:text-red-400">{notice}</p>}
        </div>

        {/* things to ask, under the box, while it is empty; for someone not signed in, a tap signs them in first */}
        {empty && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((q) => (
              <button key={q} type="button" onClick={() => void (signedIn ? send(q) : signIn())} disabled={sending || out || walletBusy}
                className="rounded-xl border border-gray-200 px-4 py-3 text-left text-sm text-gray-700 transition hover:border-gray-900 hover:text-gray-900 disabled:opacity-50 dark:border-gray-800 dark:text-gray-300 dark:hover:border-white dark:hover:text-white">
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
