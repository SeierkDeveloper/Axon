"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hear the answer: a button that has a finished job's answer read aloud. It shows nothing until the server says
 * voice is on. The sound is played from the bytes the page fetched with the job's own token, so nothing about it
 * is a public address.
 */

type State = "idle" | "loading" | "playing";

export default function VoiceOutput({ taskId, claimToken }: { taskId: string; claimToken: string }) {
  const [on, setOn] = useState(false);
  const [state, setState] = useState<State>("idle");
  const [note, setNote] = useState<string | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const kept = useRef<{ buffer: AudioBuffer; cut: boolean } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const can = typeof window !== "undefined" && typeof window.AudioContext !== "undefined";
    if (can) fetch("/api/voice").then((r) => { if (alive.current) setOn(r.ok); }).catch(() => {});
    return () => {
      alive.current = false;
      try { source.current?.stop(); } catch { /* not playing */ }
      void ctx.current?.close().catch(() => {});
    };
  }, []);

  if (!on) return null;

  const stop = () => {
    try { source.current?.stop(); } catch { /* not playing */ }
    source.current = null;
    setState("idle");
  };

  const play = (buffer: AudioBuffer, cut: boolean) => {
    const c = ctx.current!;
    const s = c.createBufferSource();
    s.buffer = buffer;
    s.connect(c.destination);
    s.onended = () => { if (source.current === s) { source.current = null; if (alive.current) setState("idle"); } };
    source.current = s;
    s.start();
    setState("playing");
    setNote(cut ? "This reads the first part. The rest is above." : null);
  };

  const listen = async () => {
    setNote(null);
    // made on the press, which is when a browser lets a page make sound
    ctx.current ??= new AudioContext();
    if (ctx.current.state === "suspended") await ctx.current.resume().catch(() => {});
    if (kept.current) { play(kept.current.buffer, kept.current.cut); return; }
    setState("loading");
    try {
      const r = await fetch("/api/voice/speak", { method: "POST", headers: { "content-type": "application/json", "x-claim-token": claimToken }, body: JSON.stringify({ taskId }) });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        if (alive.current) { setNote(d.error ?? "The answer could not be read aloud."); setState("idle"); }
        return;
      }
      const cut = r.headers.get("x-voice-cut") === "1";
      const buffer = await ctx.current.decodeAudioData(await r.arrayBuffer());
      if (!alive.current) return;
      kept.current = { buffer, cut };
      play(buffer, cut);
    } catch {
      if (alive.current) { setNote("The answer could not be read aloud. Try again."); setState("idle"); }
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={state === "playing" ? stop : () => void listen()}
        disabled={state === "loading"}
        className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-900 hover:underline disabled:opacity-60 dark:text-gray-400 dark:hover:text-white"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {state === "playing" ? <rect x="6" y="6" width="12" height="12" rx="1.5" /> : <><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /></>}
        </svg>
        {state === "playing" ? "Stop" : state === "loading" ? "Getting it ready…" : "Listen"}
      </button>
      {note && <span role="status" className="text-xs text-gray-500 dark:text-gray-400">{note}</span>}
    </span>
  );
}
