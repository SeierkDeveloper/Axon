// Agents that build: the tool an agent builds with.
//
// An agent Axon runs is given one more tool, build_page. It writes the files of a small site (the page that opens,
// and if it likes a style sheet, a script, a drawing); the store checks them and keeps them as the site's next
// version (./agentSites); the person opens what was built. Calling it again in the same job changes what was built:
// the files it gives take the place of the ones with the same names, the rest stay.
//
// Building is the dearest thing an agent writes (a page is long), so it is held three ways: only a hire that is
// about something to build gets the tool at all, one hire builds at most a few versions, and the whole network at
// most so many a day. Past any of those the agent is told so in words and carries on with the job.
//
// AGENT_SITES=on switches it on (the switch is the store's: ./agentSites). Off, no agent has the tool.

import type { Agent } from "@/sdk/types";
import type { LocalTool, ResolvedTools } from "./agentTools";
import { addVersion, agentBuilds, createSite, filesOf, getSite, siteLimits, sitesEnabled, SITE, type Site, type SiteFileIn } from "./agentSites";
import { checkRateLimit } from "./rateLimit";
import { logger } from "./logger";

type Env = Record<string, string | undefined>;

/**
 * How much an agent may write in one step when it builds. Its usual limit is sized for an answer in words; the files
 * of a page are far longer than that, and a step cut off in the middle of a file builds nothing.
 */
export const BUILD_MAX_TOKENS = 16_000;
/** Rounds a building job needs at the least: the build, a correction or two, and the answer. */
export const BUILD_STEPS = 6;
/** Versions one hire may build: a free hire is paid for by the project, a paid one by a price fixed in advance. */
export const BUILDS_PER_HIRE = { free: 3, paid: 6 } as const;
/** Versions the whole network may build in a day, whoever asks. */
export const dailyBuilds = (env: Env = process.env): number => {
  const n = Number(env.AGENT_SITES_DAILY_MAX);
  return env.AGENT_SITES_DAILY_MAX?.trim() && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200;
};

// Words in a job that mean the person wants a working thing built. Two ways to say it: a thing that is only ever
// built ("a landing page", "a calculator"), or a verb of making beside a thing that could also be a document.
const THINGS = /\b(landing pages?|web ?pages?|web ?sites?|web ?apps?|one[- ]pagers?|calculators?|dashboards?|quiz(zes)?|countdowns?|timers?|stopwatch(es)?|converters?|trackers?|to-?do (list|app)s?|flash ?cards?|mini[- ]?apps?|widgets?|configurators?|price (table|page)s?|link in bio|portfolio (site|page)s?)\b/i;
const MAKES = /\b(build|code|program|develop|create|make|design|put together|spin up)\b[^.?!\n]{0,60}\b(pages?|sites?|apps?|tools?|games?|forms?|surveys?|polls?|menus?|invitations?|generators?|pickers?|planners?|checklists?|simulators?|visuali[sz]ations?|charts? (page|app)|interactive)\b/i;
/** Skills that mean building pages is the agent's job. */
const BUILDS = /web[- _]?(dev|development|design)|front[- ]?end|landing[- ]?page|website|ui[- _]?(design|build)|app[- _]?build/i;

/** Whether a job, in its own words, asks for something to be built. */
export const asksToBuild = (job: string): boolean => THINGS.test(job) || MAKES.test(job);

/**
 * Whether this hire gets the build tool: an agent Axon runs on Claude (the loop that runs tools), and a hire that is
 * about something to build, either because building pages is what the agent is for or because the job asks for one.
 * Every other hire runs exactly as it did before.
 */
export function mayBuild(agent: Pick<Agent, "provider" | "orchestrator" | "capabilities" | "endpoint">, job: string, o: { viaMcp?: boolean; env?: Env } = {}): boolean {
  if (!agentBuilds(agent, o)) return false;
  return (agent.capabilities ?? []).some((c) => BUILDS.test(c)) || asksToBuild(job);
}

export interface Built { site: Site; version: number; files: number; bytes: number; sha256: string }

const kb = (n: number): string => (n < 1024 ? `${n} bytes` : `${Math.round(n / 102.4) / 10} KB`);

/**
 * The tool, for one job. `ownerMark` is whose the site will be (the mark of whoever hired the agent); `continueSite`
 * is a site an earlier turn of the same conversation built, which this job then changes instead of starting another.
 */
export function buildTool(ctx: { taskId: string; agentId: string; ownerMark: string | null; paid: boolean; continueSite?: string | null; onBuilt?: (b: Built) => void; env?: Env }): LocalTool {
  const limit = ctx.paid ? BUILDS_PER_HIRE.paid : BUILDS_PER_HIRE.free;
  let siteId: string | null = ctx.continueSite && getSite(ctx.continueSite)?.status === "live" ? ctx.continueSite : null;
  let built = 0, tries = 0;
  return {
    name: "build_page",
    label: "build_page",
    description:
      "Build a working web page or small app that the person opens at a link: a landing page, a calculator, a tracker, a quiz, a dashboard, a small tool. Use it when the person asks for something to be built. Not for an answer in words, a document or a picture.\n" +
      `Give the files whole, as you want them kept. ${SITE.entry} is the page that opens; it may use other files of the site by their plain names (style.css, app.js, logo.svg). File names are lowercase.\n` +
      "The page is shown sealed, so everything must be inside its files: no script, style, font or picture loaded from another site, no call over the network, no frame. Pictures are inline SVG or data: addresses. It has no storage: localStorage and cookies are not there, so keep what it needs in memory while it is open. Ordinary links to other sites are fine.\n" +
      "It never asks for a password, a recovery phrase, a private key or a card, never connects a wallet, and never poses as another company's sign-in. Such a page is refused.\n" +
      "Make it finished, not a sketch: real words instead of placeholder text, clear type and spacing, built for a phone first and good on a wide screen, every button doing what it says, sensible answers for empty or wrong input.\n" +
      `Calling it again changes what you built: give only the files you are changing (and the names of any to remove), the others stay as they are. This job can build ${limit} versions, so get it right rather than in many small steps. The person receives the link with your answer: do not paste the code into the answer.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What was built, in a few words, as the person will see it named: Tip calculator" },
        files: {
          type: "array",
          description: `The files, each whole. The first build must include ${SITE.entry}.`,
          items: { type: "object", properties: { path: { type: "string", description: "The file's name, lowercase: index.html, style.css, js/app.js" }, content: { type: "string", description: "The whole file" } }, required: ["path", "content"] },
        },
        remove: { type: "array", items: { type: "string" }, description: "Names of files from the earlier version that should no longer be part of it" },
        note: { type: "string", description: "What this version is or changes, in a few words" },
      },
      required: ["title", "files"],
    },
    async run(args) {
      const env = ctx.env ?? process.env;
      if (!sitesEnabled(env)) throw new Error("Nothing can be built right now. Go on without it and say so.");
      const given = Array.isArray(args.files) ? (args.files as unknown[]).filter((f): f is { path: unknown; content: unknown } => !!f && typeof f === "object") : [];
      if (!given.length) throw new Error(`Give the files to build, each whole, starting with ${SITE.entry}.`);
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (title.length < 2) throw new Error("Give what you are building a title of a few words.");
      if (built >= limit) throw new Error(`This job has built its ${limit} versions. Go on with what is built.`);
      // a build that is refused costs a try too: an agent that cannot get it right stops rather than going round
      if (++tries > limit * 2) throw new Error("Too many builds were refused in this job. Go on without building and say what went wrong.");
      const cap = dailyBuilds(env);
      if (cap === 0 || !checkRateLimit("sites:day", cap, 86_400_000).allowed) throw new Error("Nothing more can be built today. Go on without it and say so.");

      const limits = siteLimits(env);
      // the files given take the place of the ones with the same names; the rest of the version shown stay
      const next = new Map<string, SiteFileIn>();
      if (siteId) for (const f of filesOf(siteId)) next.set(f.path, { path: f.path, content: f.content });
      for (const name of Array.isArray(args.remove) ? args.remove : []) if (typeof name === "string") next.delete(name.trim().replace(/^\.?\/+/, ""));
      const strange: SiteFileIn[] = [];
      for (const f of given) {
        const path = typeof f.path === "string" ? f.path.trim().replace(/^\.?\/+/, "") : "";
        const file = { path, content: typeof f.content === "string" ? f.content : "" };
        // a name the store will refuse is still handed to it, so the agent hears why in the store's own words
        if (next.has(path) || /^[a-z0-9]/.test(path)) next.set(path, file); else strange.push(file);
      }
      const files = [...next.values(), ...strange];

      if (!siteId) {
        const made = createSite({ taskId: ctx.taskId, agentId: ctx.agentId, ownerMark: ctx.ownerMark, title }, limits);
        if (!made.ok) throw new Error(`Not built: ${made.why}`);
        siteId = made.site.siteId;
      }
      const kept = addVersion(siteId, files, { taskId: ctx.taskId, note: typeof args.note === "string" ? args.note : undefined, title }, limits);
      if (!kept.ok) {
        logger.info("sites.build_refused", "A build was refused", { taskId: ctx.taskId, problems: kept.problems.slice(0, 5) });
        throw new Error(`Not built. Put these right and build again:\n${kept.problems.map((p) => `- ${p}`).join("\n")}`);
      }
      built++;
      const site = getSite(siteId)!;
      logger.info("sites.built", "An agent built a page", { taskId: ctx.taskId, siteId, version: kept.version, files: kept.files, bytes: kept.bytes });
      ctx.onBuilt?.({ site, version: kept.version, files: kept.files, bytes: kept.bytes, sha256: kept.sha256 });
      const left = limit - built;
      return `Built "${site.title}": version ${kept.version}, ${kept.files} ${kept.files === 1 ? "file" : "files"}, ${kb(kept.bytes)}. The person gets the link to open it with your answer. Tell them in a sentence or two what it is and how to use it, without the code. ${left > 0 ? `You can change it ${left} more ${left === 1 ? "time" : "times"} in this job.` : "That was the last version this job can build."}`;
    },
  };
}

/** How much of a built site an agent is shown when it is asked to change it. Past this a file is named, not shown. */
export const SHOWN_CHARS = 80_000;

/**
 * What a follow-up is told about the page the conversation built: its files as they are now, so that a change is made
 * to what is really there and not to what the agent remembers writing. Pictures are named, not shown. Empty when the
 * site has nothing to show.
 */
export function builtSoFar(siteId: string): string {
  const site = getSite(siteId), files = filesOf(siteId);
  if (!site || !files.length) return "";
  let room = SHOWN_CHARS;
  const parts: string[] = [];
  // the page that opens first, then the rest by name
  for (const f of [...files].sort((a, b) => (a.path === SITE.entry ? -1 : b.path === SITE.entry ? 1 : a.path < b.path ? -1 : 1))) {
    const text = f.mime.startsWith("image/") && f.mime !== "image/svg+xml" ? null : f.content.toString("utf8");
    if (text === null) { parts.push(`=== ${f.path} === (a picture, ${kb(f.bytes)}: not shown)`); continue; }
    if (text.length > room) { parts.push(`=== ${f.path} === (${kb(f.bytes)}: too long to show here. Change it only by giving the whole file again.)`); continue; }
    room -= text.length;
    parts.push(`=== ${f.path} ===\n${text}`);
  }
  return `\n\n---\nTHE PAGE BUILT EARLIER IN THIS CONVERSATION: "${site.title}", version ${site.version}, open at its link now. These are its files as they are:\n\n${parts.join("\n\n")}\n\n---\n` +
    "If the person asks for a change to it, call build_page with only the files you change, each given whole; the files you leave out stay as they are. The link stays the same and shows the new version. If they ask for something else, leave the page alone.";
}

export const canBuild = (t: ResolvedTools | null | undefined): boolean => Boolean(t?.localTools.some((x) => x.name === "build_page"));
/** The same tools with the build tool added, if it is not there already. */
export function withBuild(t: ResolvedTools | null | undefined, tool: LocalTool): ResolvedTools {
  const base: ResolvedTools = t ?? { serverTools: [], localTools: [], grants: [] };
  return canBuild(base) ? base : { ...base, localTools: [...base.localTools, tool], grants: [...base.grants, "build_page"] };
}

/** How a build reads as a step in the live log. */
export const builtLine = (b: Built): string => (b.version === 1 ? `Built ${b.site.title}` : `Changed ${b.site.title}: version ${b.version}`);
