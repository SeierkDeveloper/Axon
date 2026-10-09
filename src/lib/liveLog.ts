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

/** A shell command as a line: what it does where that is plain, else its first line. */
function commandLine(command: string): string {
  const firstRaw = command.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
  // where it runs is not what it does: "cd /tmp && python3 x.py" is the Python
  const first = firstRaw.replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, "");
  // a file written from the command itself, whichever side of the text its name is on
  const written = first.match(/^cat\s*>+\s*(\S+)\s*<</) ?? first.match(/^cat\s*<<-?\s*\S+\s*>+\s*(\S+)/) ?? first.match(/^(?:tee|touch)\s+(?:-\S+\s+)*(\S+)/);
  if (written) return `Writing ${baseName(written[1])}`;
  const script = first.match(/^python3?\s+(?!-)(\S+\.py)\b/);
  if (script) return `Running ${baseName(script[1])}`;
  if (/^python3?\s*(-c\b|-\s*<<|<<)/.test(first)) return pythonLine(command);
  if (/^pip3?\s+install\b/.test(first)) return oneLine(`Installing ${first.replace(/^pip3?\s+install\s+/, "").replace(/(^|\s)-\S+/g, " ")}`, 90);
  if (/^(ls|find|pwd|tree)\b/.test(first)) return "Looking at the files";
  if (/^(head|cat|tail|wc|file)\s/.test(first)) return `Looking at ${baseName(first.split(/\s+/).filter((w) => !w.startsWith("-")).pop())}`;
  // a file copied or moved to where finished work goes is a file being handed over
  const saved = first.match(/^(cp|mv)\s+(?:-\S+\s+)*(\S+)\s+\S*\$\{?OUTPUT_DIR\b/);
  if (saved) return `Saving ${baseName(saved[2].replace(/["']/g, ""))}`;
  return oneLine(`Running: ${first}`, 110);
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
  if (ev.tool === "make_picture") return typeof input.prompt === "string" && input.prompt.trim() ? oneLine(`Drawing: ${input.prompt.trim()}`, 110) : "Drawing a picture";
  // a tool of the agent's own (an MCP server's, or one Axon gives it): its name is what there is to say
  const name = ev.tool.split("/").pop() ?? ev.tool;
  return oneLine(`Using ${name.replace(/_/g, " ")}`, 80);
}

export interface Step { n: number; text: string; at: string }

/** The lines of a job so far, oldest first. */
export function stepsOf(taskId: string): Step[] {
  try {
    return getTaskProgress(taskId).map((p) => ({ n: p.sequence, text: p.message, at: p.emittedAt }));
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
  const say = (text: string | null): void => {
    if (!on || !text) return;
    const line = oneLine(text);
    if (!line || line === last || written > MAX_STEPS) return;
    try {
      written++;
      const kept = written > MAX_STEPS ? "Still working. Later steps are not listed." : line;
      last = line;
      emitProgress(taskId, kept);
    } catch (err) {
      logger.warn("live_log.write_failed", "A step could not be written", { taskId, err });
    }
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
  return { on, say, onLive };
}
