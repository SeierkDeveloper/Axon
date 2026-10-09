// Agents make pictures: an illustration, a logo, a mockup, when words or a chart will not do.
//
// An agent Axon runs is given one more tool, make_picture. It describes the picture; a picture model draws it; the
// file is kept with the job like any other file the agent hands back, so it shows with the answer, can be
// downloaded, and its hash is in the receipt.
//
// A picture costs money every time, so it is held three ways: only a hire that is about a picture gets the tool at
// all, one hire makes at most a few, and the whole network at most so many a day. Past any of those the agent is
// told so in words and carries on with the job.
//
// AGENT_PICTURES=on switches it on, and only while files are on. Off (the default) no agent has the tool.

import type { Agent } from "@/sdk/types";
import type { LocalTool, ResolvedTools } from "./agentTools";
import { filesEnabled, keepOutput, sniff, type FileView } from "./agentFiles";
import { checkRateLimit } from "./rateLimit";
import { logger } from "./logger";

type Env = Record<string, string | undefined>;

export function picturesEnabled(env: Env = process.env): boolean {
  return filesEnabled(env) && (env.AGENT_PICTURES ?? "").trim().toLowerCase() === "on";
}

/** The picture model. A name starting with "grok" is drawn by xAI; anything else by OpenAI. */
export const pictureModel = (env: Env = process.env): string => env.AGENT_PICTURE_MODEL?.trim() || "gpt-image-1-mini";
export type Quality = "low" | "medium" | "high";
export const pictureQuality = (env: Env = process.env): Quality => {
  const q = (env.AGENT_PICTURE_QUALITY ?? "").trim().toLowerCase();
  return q === "low" || q === "high" ? q : "medium";
};
/** Pictures one hire may make: a free hire is paid for by the project, a paid one by a price fixed in advance. */
export const PICTURES_PER_HIRE = { free: 1, paid: 3 } as const;
/** Pictures the whole network may make in a day, whoever asks. */
export const dailyPictures = (env: Env = process.env): number => {
  const n = Number(env.AGENT_PICTURES_DAILY_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200;
};

export type Shape = "square" | "wide" | "tall";
const SIZES: Record<Shape, string> = { square: "1024x1024", wide: "1536x1024", tall: "1024x1536" };

/** What one picture costs, in dollars, where the price is known. For the log, so the spend can be added up. */
export function pictureCostUsd(model: string, quality: Quality, shape: Shape): number | null {
  const large = shape !== "square";
  if (model.startsWith("gpt-image-1-mini")) return { low: large ? 0.006 : 0.005, medium: large ? 0.015 : 0.011, high: large ? 0.052 : 0.036 }[quality];
  if (model.startsWith("gpt-image-1")) return { low: large ? 0.016 : 0.011, medium: large ? 0.063 : 0.042, high: large ? 0.25 : 0.167 }[quality];
  return null;
}

/** Words in a job that mean the person wants a picture made. */
const ASKS = /\b(pictures?|images?|illustrat(e|ed|ion|ions)|logos?|posters?|banners?|mock-?ups?|icons?|drawings?|draw (me|us|a|an|the)|sketch(es)?|artwork|wallpapers?|thumbnails?|avatars?|cover art|memes?)\b/i;
/** Skills that mean making pictures is the agent's job. */
const DRAWS = /image[- _]?generation|illustration|graphic[- ]?design|logo|visual design|art\b/i;

/**
 * Whether this hire gets the picture tool: an agent Axon runs on Claude (the loop that runs tools), and a hire that is
 * about a picture, either because making pictures is what the agent is for or because the job asks for one. Every
 * other hire runs exactly as it did before.
 */
export function mayDraw(agent: Pick<Agent, "provider" | "orchestrator" | "capabilities">, job: string, o: { viaMcp?: boolean; env?: Env } = {}): boolean {
  if (!picturesEnabled(o.env) || o.viaMcp || agent.orchestrator) return false;
  if ((agent.provider ?? "anthropic") !== "anthropic") return false;
  return (agent.capabilities ?? []).some((c) => DRAWS.test(c)) || ASKS.test(job);
}

export type Draw = (input: { prompt: string; shape: Shape }) => Promise<Buffer>;

/** Ask the picture model for one picture. Throws with a reason in plain words; never returns something that is not a picture. */
export const drawPicture: Draw = async ({ prompt, shape }) => {
  const env = process.env, model = pictureModel(env), xai = model.startsWith("grok");
  const key = xai ? env.XAI_API_KEY : env.OPENAI_API_KEY;
  if (!key) throw new Error("Pictures cannot be made right now.");
  const body = xai
    ? { model, prompt, n: 1, response_format: "b64_json" }
    : { model, prompt, n: 1, size: SIZES[shape], quality: pictureQuality(env), output_format: "png" };
  let res: Response;
  try {
    res = await fetch(xai ? "https://api.x.ai/v1/images/generations" : "https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(170_000),
    });
  } catch (err) {
    logger.warn("pictures.request_failed", "The picture model could not be reached", { model, err });
    throw new Error("The picture model did not answer in time. Try once more, or go on without the picture.");
  }
  const json = (await res.json().catch(() => null)) as { data?: { b64_json?: string }[]; error?: { message?: string; code?: string; type?: string } } | null;
  if (!res.ok) {
    const code = `${json?.error?.code ?? ""} ${json?.error?.type ?? ""}`;
    logger.warn("pictures.refused", "The picture model refused a request", { model, status: res.status, code: code.trim(), message: json?.error?.message?.slice(0, 300) });
    if (/moderation|content_policy|safety/i.test(code + (json?.error?.message ?? ""))) throw new Error("The picture model would not draw that. Describe it differently, or go on without the picture.");
    if (res.status === 429) throw new Error("The picture model is busy. Go on without the picture.");
    throw new Error("The picture could not be made. Go on without it.");
  }
  const b64 = json?.data?.[0]?.b64_json;
  const bytes = b64 ? Buffer.from(b64, "base64") : null;
  if (!bytes || sniff(bytes)?.kind !== "image") throw new Error("The picture model returned nothing usable. Go on without the picture.");
  return bytes;
};

const slug = (s: string): string => s.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

/**
 * The tool as one hire holds it. It counts what this hire has made, asks the network's daily count, draws, and keeps
 * the picture with the job. Whatever goes wrong comes back to the agent as a sentence it can act on.
 */
export function pictureTool(ctx: { taskId: string; wallet: string | null; paid: boolean; onMade?: (file: FileView) => void; draw?: Draw; env?: Env }): LocalTool {
  const limit = ctx.paid ? PICTURES_PER_HIRE.paid : PICTURES_PER_HIRE.free;
  const draw = ctx.draw ?? drawPicture;
  let made = 0;
  return {
    name: "make_picture",
    label: "make_picture",
    description:
      `Make a picture from a description: an illustration, a logo, a poster, a mockup, an icon. Use it only when the person asks for a picture or the job cannot be done without one. Never for a chart of data: compute and draw those in code. Describe the picture completely in the prompt (subject, style, colours, composition, any text that must appear, spelled exactly), because the model that draws it sees nothing else. At most ${limit} ${limit === 1 ? "picture" : "pictures"} in this job. The person receives the file with your answer, so refer to it by the name this returns and do not describe how to open it.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The complete description of the picture" },
        shape: { type: "string", enum: ["square", "wide", "tall"], description: "square (default), wide for banners and headers, tall for posters and phone screens" },
        name: { type: "string", description: "A short file name without an extension, for example launch-poster" },
      },
      required: ["prompt"],
    },
    async run(args) {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (prompt.length < 8) throw new Error("Describe the picture in a full sentence or more.");
      if (prompt.length > 4000) throw new Error("The description is too long. Keep it under 4,000 characters.");
      if (made >= limit) throw new Error(`This job has made its ${limit === 1 ? "one picture" : `${limit} pictures`}. Go on with what you have.`);
      const shape: Shape = args.shape === "wide" || args.shape === "tall" ? args.shape : "square";
      const env = ctx.env ?? process.env, cap = dailyPictures(env);
      if (cap === 0 || !checkRateLimit("pictures:day", cap, 86_400_000).allowed) throw new Error("No more pictures can be made today. Go on without one and say so.");
      made++; // counted before the draw: a picture that fails still cost the attempt
      const startedAt = Date.now();
      const bytes = await draw({ prompt, shape });
      const ext = sniff(bytes)?.ext ?? "png";
      const kept = keepOutput({ taskId: ctx.taskId, bytes, name: `${slug(typeof args.name === "string" ? args.name : "") || slug(prompt.split(/\s+/).slice(0, 6).join(" ")) || "picture"}.${ext}`, wallet: ctx.wallet });
      const model = pictureModel(env);
      logger.info("pictures.made", "An agent made a picture", { taskId: ctx.taskId, model, shape, bytes: bytes.length, ms: Date.now() - startedAt, costUsd: pictureCostUsd(model, pictureQuality(env), shape) });
      if (kept === null) return "That exact picture is already with this job.";
      if (!kept.ok) throw new Error("The picture was made but could not be saved. Go on without it.");
      ctx.onMade?.(kept.file);
      const left = limit - made;
      return `Saved as ${kept.file.name}. The person receives it with your answer. ${left > 0 ? `You can make ${left} more in this job.` : "That was the last picture this job can make."}`;
    },
  };
}

export const canDraw = (t: ResolvedTools | null | undefined): boolean => Boolean(t?.localTools.some((x) => x.name === "make_picture"));
/** The same tools with the picture tool added, if it is not there already. */
export function withPictures(t: ResolvedTools | null | undefined, tool: LocalTool): ResolvedTools {
  const base: ResolvedTools = t ?? { serverTools: [], localTools: [], grants: [] };
  return canDraw(base) ? base : { ...base, localTools: [...base.localTools, tool], grants: [...base.grants, "make_picture"] };
}
