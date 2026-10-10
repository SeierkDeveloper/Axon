"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Say the job instead of typing it: a button that records a short clip, has it written down, and hands the words to
 * the page. It shows nothing at all until the server says voice is on and the browser can record, so a page that
 * includes it is unchanged while the feature is off.
 */

interface Limits { listen: { maxBytes: number; maxSeconds: number } }
type State = "idle" | "asking" | "recording" | "writing";

/** The recording format this browser makes, of the ones the server reads. */
function recordingType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
}

export default function VoiceInput({ onText, disabled, what = "the task" }: {
  onText: (text: string) => void;
  disabled?: boolean;
  /** what is being said, for whoever cannot see the button: "the task", "your answer", "a note" */
  what?: string;
}) {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [state, setState] = useState<State>("idle");
  const [seconds, setSeconds] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const can = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
    if (can) fetch("/api/voice").then((r) => (r.ok ? (r.json() as Promise<Limits>) : null)).then((d) => { if (alive.current) setLimits(d); }).catch(() => {});
    return () => {
      alive.current = false;
      if (tick.current) clearInterval(tick.current);
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  if (!limits) return null;
  const max = limits.listen.maxSeconds;

  const release = () => {
    if (tick.current) { clearInterval(tick.current); tick.current = null; }
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    recorder.current = null;
  };

  const send = async (blob: Blob) => {
    if (blob.size < 800) { setNote("Nothing was recorded. Hold on a little longer and speak."); setState("idle"); return; }
    if (blob.size > limits.listen.maxBytes) { setNote(`That was too long. Keep it under ${max} seconds.`); setState("idle"); return; }
    setState("writing");
    try {
      const r = await fetch("/api/voice/transcribe", { method: "POST", headers: { "content-type": blob.type || "application/octet-stream" }, body: blob });
      const d = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!alive.current) return;
      if (r.ok && d.text) onText(d.text);
      else setNote(d.error ?? "That could not be written down. Try again, or type it.");
    } catch {
      if (alive.current) setNote("That could not be sent. Check your connection and try again.");
    } finally {
      if (alive.current) setState("idle");
    }
  };

  const start = async () => {
    setNote(null);
    setState("asking");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { s.getTracks().forEach((t) => t.stop()); return; }
      stream.current = s;
      const type = recordingType();
      const rec = new MediaRecorder(s, type ? { mimeType: type } : undefined);
      const parts: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      rec.onstop = () => { const blob = new Blob(parts, { type: rec.mimeType || type || "audio/webm" }); release(); if (alive.current) void send(blob); };
      recorder.current = rec;
      rec.start();
      setSeconds(0);
      setState("recording");
      let n = 0;
      tick.current = setInterval(() => {
        n++;
        setSeconds(n);
        if (n >= max) stop(); // a recording ends itself at the limit
      }, 1000);
    } catch (err) {
      release();
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setNote(denied ? "Allow the microphone for this site to say the job out loud." : "No microphone was found.");
      setState("idle");
    }
  };

  const stop = () => {
    const rec = recorder.current;
    if (rec && rec.state !== "inactive") rec.stop();
  };

  const recording = state === "recording";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        onClick={recording ? stop : () => void start()}
        disabled={disabled || state === "asking" || state === "writing"}
        aria-pressed={recording}
        aria-label={recording ? "Stop recording" : `Say ${what} out loud`}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${recording ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300" : "border-gray-200 text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500"}`}
      >
        {recording ? (
          <span className="h-2.5 w-2.5 rounded-sm bg-red-600" aria-hidden />
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        )}
        {recording ? `Stop, ${seconds}s` : state === "writing" ? "Writing it down…" : state === "asking" ? "Waiting for the microphone…" : "Say it"}
      </button>
      {note && <span role="status" className="text-xs text-amber-600 dark:text-amber-400">{note}</span>}
    </span>
  );
}
