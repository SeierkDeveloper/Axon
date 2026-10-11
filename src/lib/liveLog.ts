// Watch it work: a line for every step an agent takes while a hire runs.
//
// A hire used to be a spinner and then an answer. This writes down what happens in between, as it happens: the job
// picked up, each file read, each search, each piece of code run, each file made. The lines are kept as the job's
// progress (the same store an agent on its own server already posts progress to), so they are read by whoever may
// read the job and by nobody else, and each one is committed to the job's public trace as a hash only.
//
// A line says what the agent is doing, in plain words, and is short. It is never the answer and never a file's
// contents. Secrets are scrubbed where every progress line is scrubbed.
//
// AGENT_LIVE_LOG=on switches it on. Off (the default) nothing is written and a job reads exactly as before.

import type { LiveEvent } from "./providers";
import { emitProgress, getTaskProgress } from "./progress";
import { logger } from "./logger";
import { keepStepShot, shotsOf, type StepShot } from "./stepShots";

export function liveLogEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AGENT_LIVE_LOG ?? "").trim().toLowerCase() === "on";
}

/** A job writes at most this many lines; one that runs longer says so once and goes quiet. */
export const MAX_STEPS = 40;
/** A line is at most this long. */
export const MAX_STEP_CHARS = 160;

const oneLine = (s: string, max = MAX_STEP_CHARS): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};
const baseName = (p: unknown): string => (typeof p === "string" ? p.split(/[\\/]/).filter(Boolean).pop() ?? "" : "");
const host = (u: unknown): string => {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** What an agent said before reaching for a tool, as one short line: its first sentence, without the markup. */
export function noteLine(text: string): string | null {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const first = plain.split(/\n+/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const sentence = first.match(/^.{12,}?[.!?:](?=\s|$)/)?.[0] ?? first;
  const line = oneLine(sentence.replace(/:$/, "."));
  return line.length >= 4 ? line : null;
}

/** What a piece of Python is for, when its own words say so: a chart, or the data. */
function pythonLine(code: string): string {
  if (/savefig|matplotlib|\bplt\.|seaborn|plotly/.test(code)) return "Running Python: drawing the chart";
  if (/read_csv|read_excel|read_json|csv\.(reader|DictReader)|\bpandas\b/.test(code)) return "Running Python: working through the data";
  return "Running Python";
}

/** One command of a chain, as what it does. `rank` says how much it tells: the most telling one names the step. */
function part(cmd: string, whole: string): { rank: number; line: string | null } {
  // a file written from the command itself, whichever side of the text its name is on
  const written = cmd.match(/^cat\s*>+\s*(\S+)\s*<</) ?? cmd.match(/^cat\s*<<-?\s*\S+\s*>+\s*(\S+)/) ?? cmd.match(/^(?:tee|touch)\s+(?:-\S+\s+)*(\S+)/);
  if (written) return { rank: 5, line: `Writing ${baseName(written[1].replace(/["']/g, ""))}` };
  const script = cmd.match(/^python3?\s+(?!-)(\S+\.py)\b/);
  if (script) return { rank: 6, line: `Running ${baseName(script[1])}` };
  if (/^python3?\s*(-c\b|-\s*<<|<<)/.test(cmd)) return { rank: 6, line: pythonLine(whole) };
  // a file copied or moved to where finished work goes is a file being handed over
  const saved = cmd.match(/^(?:cp|mv)\s+(?:-\S+\s+)*(\S+)\s+\S*\$\{?OUTPUT_DIR\b/);
  if (saved) return { rank: 4, line: `Saving ${baseName(saved[1].replace(/["']/g, ""))}` };
  if (/^pip3?\s+install\b/.test(cmd)) return { rank: 3, line: oneLine(`Installing ${cmd.replace(/^pip3?\s+install\s+/, "").replace(/(^|\s)-\S+/g, " ")}`, 90) };
  if (/^(head|cat|tail|wc|file|less)\s/.test(cmd)) {
    // the file is named before any pipe; what follows the pipe only trims what is shown
    const named = cmd.split("|")[0].trim().split(/\s+/).slice(1).filter((w) => !w.startsWith("-")).pop() ?? "";
    return { rank: 2, line: `Looking at ${baseName(named.replace(/["']/g, "")) || "a file"}` };
  }
  if (/^(ls|find|pwd|tree|du)\b/.test(cmd)) return { rank: 1, line: "Looking at the files" };
  // getting ready is not a step worth a line of its own
  if (/^(cd|mkdir|export|set|chmod|true|echo|source|unset|cp|mv|rm)\b/.test(cmd)) return { rank: 0, line: null };
  // anything else: the command itself when it is short and plain, otherwise just that one ran
  const plain = cmd.length <= 60 && !/[$`"'\\<>{}]/.test(cmd);
  return { rank: 1.5, line: plain ? `Running: ${cmd}` : "Running a command" };
}

/**
 * A shell command as a line a person can read. A command is often a chain ("get ready, then run this"): each link
 * is read for what it does and the most telling one names the step, so the line says "Running Python: drawing the
 * chart" and never the shell text that started it.
 */
function commandLine(command: string): string {
  const first = command.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  const links = first.split(/\s*(?:&&|\|\||;)\s*/).map((l) => l.trim()).filter(Boolean);
  let best: { rank: number; line: string | null } = { rank: -1, line: null };
  for (const l of links) { const p = part(l, command); if (p.rank > best.rank) best = p; }
  return best.line ?? "Getting ready";
}

/** The line for one thing an agent does, or null when it is not worth a line. */
export function lineFor(ev: LiveEvent): string | null {
  if (ev.type === "note") return noteLine(ev.text);
  const input = (ev.input && typeof ev.input === "object" ? ev.input : {}) as Record<string, unknown>;
  if (ev.tool === "web_search") return typeof input.query === "string" && input.query.trim() ? oneLine(`Searching the web for "${input.query.trim()}"`) : "Searching the web";
  if (ev.tool === "web_fetch") return host(input.url) ? `Opening ${host(input.url)}` : "Opening a page";
  if (ev.tool === "bash_code_execution" || ev.tool === "code_execution") {
    const command = typeof input.command === "string" ? input.command : typeof input.code === "string" ? "python3 -c" : "";
    return command ? commandLine(command) : "Running code";
  }
  if (ev.tool === "text_editor_code_execution") {
    const name = baseName(input.path);
    const what = input.command === "create" ? "Writing" : input.command === "view" ? "Looking at" : "Editing";
    return name ? `${what} ${name}` : `${what} a file`;
  }
  // the question itself is shown to the person where they answer it; the log only says that one was asked
  if (ev.tool === "ask_person") return "Asked you a question";
  // what it noted is said in its own line, with the words, once it is kept
  if (ev.tool === "remember") return null;
  // each thing it does in its browser is said by the browser itself, with the name of what it clicked or typed into
  if (ev.tool === "browser") return null;
  if (ev.tool === "make_picture") return typeof input.prompt === "string" && input.prompt.trim() ? oneLine(`Drawing: ${input.prompt.trim()}`, 110) : "Drawing a picture";
  // a tool of the agent's own (an MCP server's, or one Axon gives it): its name is what there is to say
  const name = ev.tool.split("/").pop() ?? ev.tool;
  return oneLine(`Using ${name.replace(/_/g, " ")}`, 80);
}

export interface Step { n: number; text: string; at: string; shot?: StepShot }

/** The lines of a job so far, oldest first. */
export function stepsOf(taskId: string): Step[] {
  try {
    const lines = getTaskProgress(taskId);
    if (!lines.length) return [];
    const shots = shotsOf(taskId);
    return lines.map((p) => ({ n: p.sequence, text: p.message, at: p.emittedAt, ...(shots.has(p.sequence) ? { shot: shots.get(p.sequence)! } : {}) }));
  } catch {
    return [];
  }
}

/**
 * The writer for one job. `say` adds a line; `onLive` takes what the model reports as it works. A step reported
 * twice (a call that was retried) is written once, the same line twice in a row is written once, and nothing here
 * ever throws: a job must not fail because a line about it could not be written.
 */
export function liveLog(taskId: string, o: { enabled?: boolean } = {}) {
  const on = o.enabled ?? liveLogEnabled();
  const seen = new Set<string>();
  let written = 0, last = "";
  /** Adds a line. Returns the line's place in the log, or null when nothing was written. */
  const say = (text: string | null): number | null => {
    if (!on || !text) return null;
    const line = oneLine(text);
    if (!line || line === last || written > MAX_STEPS) return null;
    try {
      written++;
      const kept = written > MAX_STEPS ? "Still working. Later steps are not listed." : line;
      last = line;
      const entry = emitProgress(taskId, kept);
      return entry && written <= MAX_STEPS ? entry.sequence : null;
    } catch (err) {
      logger.warn("live_log.write_failed", "A step could not be written", { taskId, err });
      return null;
    }
  };
  /**
   * Adds a line that will get a picture: what the agent is doing in its browser now. What comes back takes the
   * picture of the page once the thing is done, and keeps it with that line. A line said twice in a row is written
   * once, and the picture then goes with the line that is there.
   */
  let lastPlace: number | null = null;
  const show = (text: string, wallet?: string | null): ((jpeg: Buffer) => void) => {
    const place = say(text) ?? (oneLine(text) === last ? lastPlace : null);
    if (place !== null) lastPlace = place;
    return (jpeg) => { if (on && place !== null) keepStepShot({ taskId, sequence: place, bytes: jpeg, wallet }); };
  };
  const onLive = (ev: LiveEvent): void => {
    try {
      const key = ev.type === "note" ? `note:${ev.text.slice(0, 200)}` : `tool:${ev.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      say(lineFor(ev));
    } catch (err) {
      logger.warn("live_log.write_failed", "A step could not be written", { taskId, err });
    }
  };
  return { on, say, show, onLive };
}
