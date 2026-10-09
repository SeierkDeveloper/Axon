// Voice: say the job out loud, and hear the answer.
//
// Two small things, each a call to a speech model. Listening turns a short recording into the words of a job, which
// the person sees and can change before hiring. Speaking reads a finished job's answer aloud. Neither changes what a
// job is: the agent is still hired with text and still answers with text, so receipts, hashes and prices are untouched.
//
// Both cost money per use, so both are held: a recording has a size limit, an address a number of uses a day, the
// whole network a number a day, and an answer is spoken once and kept, so hearing it again costs nothing. Speaking
// only ever reads the answer of a job the listener may read, never text they send in.
//
// AGENT_VOICE=on switches it on. Off (the default) every voice route answers as if it did not exist, and the site
// keeps refusing the microphone to every page.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getDbPath } from "./db";
import { logger } from "./logger";

type Env = Record<string, string | undefined>;

export function voiceEnabled(env: Env = process.env): boolean {
  return (env.AGENT_VOICE ?? "").trim().toLowerCase() === "on";
}

export const listenModel = (env: Env = process.env): string => env.AGENT_VOICE_LISTEN_MODEL?.trim() || "gpt-4o-mini-transcribe";
// The quick one on purpose: somebody who presses Listen is waiting. Measured on the same answer, this starts a
// half-minute reading in about four seconds where the newer model took fifteen.
export const speakModel = (env: Env = process.env): string => env.AGENT_VOICE_SPEAK_MODEL?.trim() || "tts-1";
export const speakVoice = (env: Env = process.env): string => env.AGENT_VOICE_NAME?.trim() || "alloy";
const count = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/** What one recording may be, and how often an address and the whole network may send one. */
export const LISTEN = { maxBytes: 2 * 1024 * 1024, maxSeconds: 60, perMinute: 6, perDay: 40 } as const;
export const dailyListens = (env: Env = process.env): number => count(env.AGENT_VOICE_DAILY_LISTENS, 2000);
/** How much of an answer is read aloud, and how often an address and the whole network may ask for a new reading. */
export const SPEAK = { maxChars: 1200, perMinute: 6, perDay: 20 } as const;
export const dailySpeaks = (env: Env = process.env): number => count(env.AGENT_VOICE_DAILY_SPEAKS, 300);

// ── Listening ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Heard { mime: string; ext: string }

/** What kind of recording these bytes are, from the bytes alone. Null for anything that is not one a browser records. */
export function sniffAudio(b: Buffer): Heard | null {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: "audio/webm", ext: "webm" };
  if (b.toString("latin1", 4, 8) === "ftyp") return { mime: "audio/mp4", ext: "m4a" };
  if (b.toString("latin1", 0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg", ext: "mp3" };
  return null;
}

/** The words in a recording. Throws with a reason in plain words. An empty string means nothing was said. */
export async function transcribe(bytes: Buffer, kind: Heard, o: { env?: Env } = {}): Promise<string> {
  const env = o.env ?? process.env, key = env.OPENAI_API_KEY;
  if (!key) throw new Error("Voice is not available right now.");
  const form = new FormData();
  form.append("model", listenModel(env));
  form.append("file", new Blob([new Uint8Array(bytes)], { type: kind.mime }), `speech.${kind.ext}`);
  form.append("response_format", "json");
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    logger.warn("voice.listen_failed", "The speech model could not be reached", { err });
    throw new Error("That could not be written down. Try again, or type it.");
  }
  const json = (await res.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
  if (!res.ok) {
    logger.warn("voice.listen_refused", "The speech model refused a recording", { status: res.status, message: json?.error?.message?.slice(0, 300) });
    throw new Error(res.status === 429 ? "Voice is busy right now. Try again in a moment, or type it." : "That recording could not be read. Try again, or type it.");
  }
  return (json?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 8000);
}

// ── Speaking ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An answer as it is read aloud: the words without the markup. Code and tables are not read out (they are named
 * instead), links are read as their text, and a long answer stops at the end of a sentence with the rest left to
 * the page. `cut` says whether anything was left out for length.
 */
export function speakable(markdown: string, maxChars: number = SPEAK.maxChars): { text: string; cut: boolean } {
  let t = markdown
    .replace(/```[\s\S]*?```/g, " There is code here, which is on the page. ")
    .replace(/^\s*\|.*\|\s*$/gm, "\u0000")
    .replace(/(\u0000\s*)+/g, " There is a table here, which is on the page. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/gm, "$1.")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ")
    .replace(/[*_~`]+/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.\s*\./g, ".")
    .trim();
  if (t.length <= maxChars) return { text: t, cut: false };
  const head = t.slice(0, maxChars);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  t = (stop > maxChars * 0.5 ? head.slice(0, stop + 1) : head.replace(/\s+\S*$/, "")).trim();
  return { text: `${t} The rest is on the page.`, cut: true };
}

/** Where spoken answers are kept, beside the database. */
export function voiceDir(env: Env = process.env): string {
  return env.AXON_VOICE_DIR ?? path.join(path.dirname(getDbPath()), "voice");
}
const cachePath = (text: string, env: Env): string =>
  path.join(voiceDir(env), `${createHash("sha256").update(`${speakModel(env)}\n${speakVoice(env)}\n${text}`, "utf8").digest("hex")}.mp3`);

/** A reading that was made before, if it is still kept. */
export function spokenBefore(text: string, o: { env?: Env } = {}): Buffer | null {
  try {
    return fs.readFileSync(cachePath(text, o.env ?? process.env));
  } catch {
    return null;
  }
}

/** Read text aloud: MP3 bytes. Kept, so the same words are never paid for twice. Throws with a reason in plain words. */
export async function speak(text: string, o: { env?: Env } = {}): Promise<Buffer> {
  const env = o.env ?? process.env, key = env.OPENAI_API_KEY;
  if (!key) throw new Error("Voice is not available right now.");
  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: speakModel(env), voice: speakVoice(env), input: text, response_format: "mp3" }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    logger.warn("voice.speak_failed", "The speech model could not be reached", { err });
    throw new Error("The answer could not be read aloud. Try again.");
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    logger.warn("voice.speak_refused", "The speech model refused a reading", { status: res.status, message: json?.error?.message?.slice(0, 300) });
    throw new Error(res.status === 429 ? "Voice is busy right now. Try again in a moment." : "The answer could not be read aloud.");
  }
  let bytes: Buffer;
  try {
    // the sound arrives as it is made; a reading that stalls part way is a failed reading, said plainly
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn("voice.speak_failed", "A reading stopped part way", { err });
    throw new Error("The answer could not be read aloud. Try again.");
  }
  if (sniffAudio(bytes)?.ext !== "mp3") throw new Error("The answer could not be read aloud.");
  try {
    const target = cachePath(text, env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.part`, bytes);
    fs.renameSync(`${target}.part`, target);
  } catch (err) {
    logger.warn("voice.cache_failed", "A reading could not be kept", { err }); // it is still played
  }
  logger.info("voice.spoke", "An answer was read aloud", { chars: text.length, bytes: bytes.length, model: speakModel(env) });
  return bytes;
}

/** Clear readings older than a week. Returns how many went. */
export function purgeSpoken(now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000, env: Env = process.env): number {
  let gone = 0;
  try {
    const dir = voiceDir(env);
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.unlinkSync(file); gone++; }
    }
  } catch {
    /* nothing kept yet */
  }
  return gone;
}
