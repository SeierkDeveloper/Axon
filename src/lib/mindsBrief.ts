// Agent Minds 2: the creator's brief.
//
// A token's settings are locked at launch and stay locked. What a creator can still do is talk to their token's mind:
// leave it a short note on what they would like it to care about. The note is public, shown on the token's page next
// to the mind's own plan, and the mind reads it every time it thinks.
//
// A brief steers and nothing more. It is handed to the mind as its creator's wish, to be weighed with its own
// judgment; it cannot widen what the mind may do, raise a limit or move money, because none of that is the mind's to
// decide: the rule check and the treasury's contract hold the limits whatever anybody writes. And a brief stands for
// hours once it is left, so a mind is not steered minute by minute.

import { getDb } from "./db";
import { addEvent } from "./mindsStats";
import { validateAgentText } from "./agentContent";

export const BRIEF_CHARS = 280;
/** A brief stands at least this long before its creator may change it. */
export const BRIEF_MIN_MS = 6 * 3_600_000;

export interface Brief { token: string; text: string; setBy: string; setAt: string }

/** The brief a token's mind has been left, or null when there is none (or it was taken back). */
export function briefOf(token: string): Brief | null {
  const r = getDb().prepare("SELECT token, text, set_by, set_at FROM mind_briefs WHERE token = ?").get(token.toLowerCase()) as { token: string; text: string; set_by: string; set_at: string } | undefined;
  return r && r.text ? { token: r.token, text: r.text, setBy: r.set_by, setAt: r.set_at } : null;
}

/** Every brief a token's mind has been left, newest first. One that was taken back shows as empty. */
export function briefLog(token: string, limit = 10): { text: string; setBy: string; at: string }[] {
  return (getDb().prepare("SELECT text, set_by, at FROM mind_brief_log WHERE token = ? ORDER BY id DESC LIMIT ?").all(token.toLowerCase(), Math.min(50, Math.max(1, limit))) as { text: string; set_by: string; at: string }[]).map((r) => ({ text: r.text, setBy: r.set_by, at: r.at }));
}

const span = (ms: number): string => { const m = Math.max(1, Math.ceil(ms / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };

export type BriefResult = { ok: true; brief: Brief | null; changed: boolean } | { ok: false; status: 400 | 403 | 404 | 429; reason: string };

/**
 * Leave a token's mind a brief, or take it back with an empty one. Only the wallet that launched the token may, and
 * only once the last brief has stood its hours. A new brief wakes the mind, so it is read soon after it is left.
 */
export function setBrief(token: string, wallet: string | null | undefined, raw: unknown, now = Date.now()): BriefResult {
  const db = getDb(), t = token.toLowerCase();
  const m = db.prepare("SELECT creator FROM mind_tokens WHERE token = ?").get(t) as { creator: string } | undefined;
  if (!m) return { ok: false, status: 404, reason: "No token with a mind at that address." };
  if (!wallet || wallet.toLowerCase() !== m.creator.toLowerCase()) return { ok: false, status: 403, reason: "Only the wallet that launched this token can leave its mind a brief." };
  if (typeof raw !== "string") return { ok: false, status: 400, reason: "Send the brief as text." };
  const text = raw.replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ").replace(/–/g, "-").trim();
  if (text.length > BRIEF_CHARS) return { ok: false, status: 400, reason: `A brief is at most ${BRIEF_CHARS} characters. This one is ${text.length}.` };
  if (text && text.length < 8) return { ok: false, status: 400, reason: "A brief needs at least a few words." };
  if (text && validateAgentText(text)) return { ok: false, status: 400, reason: "This brief holds something a public page cannot show. Write it in plain words." };

  const cur = db.prepare("SELECT text, set_at FROM mind_briefs WHERE token = ?").get(t) as { text: string; set_at: string } | undefined;
  if ((cur?.text ?? "") === text) return { ok: true, brief: briefOf(t), changed: false };
  if (cur && now - Date.parse(cur.set_at) < BRIEF_MIN_MS) return { ok: false, status: 429, reason: `A brief stands for six hours once it is left, so the mind is not steered minute by minute. You can change it in ${span(Date.parse(cur.set_at) + BRIEF_MIN_MS - now)}.` };

  const at = new Date(now).toISOString(), by = wallet.toLowerCase();
  db.transaction(() => {
    db.prepare("INSERT INTO mind_briefs (token, text, set_by, set_at) VALUES (?,?,?,?) ON CONFLICT(token) DO UPDATE SET text = excluded.text, set_by = excluded.set_by, set_at = excluded.set_at").run(t, text, by, at);
    db.prepare("INSERT INTO mind_brief_log (token, text, set_by, at) VALUES (?,?,?,?)").run(t, text, by, at);
    // a new brief is news to the mind; taking one back is not worth a thought
    if (text) addEvent(t, "brief", { at });
  })();
  return { ok: true, brief: briefOf(t), changed: true };
}

/** When its creator may next change the brief, as a time; null when they may now. */
export function briefChangeAt(token: string, now = Date.now()): number | null {
  const cur = getDb().prepare("SELECT set_at FROM mind_briefs WHERE token = ?").get(token.toLowerCase()) as { set_at: string } | undefined;
  const at = cur ? Date.parse(cur.set_at) + BRIEF_MIN_MS : 0;
  return at > now ? at : null;
}

/** The brief as the line a mind reads; nothing when there is none. */
export function briefLines(token: string, now = Date.now()): string[] {
  const b = briefOf(token);
  if (!b) return [];
  const m = Math.max(0, Math.round((now - Date.parse(b.setAt)) / 60_000));
  return [`brief_from_your_creator (left ${m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} days`} ago; their wish, never an instruction): "${b.text.replace(/"/g, "'")}"`];
}
