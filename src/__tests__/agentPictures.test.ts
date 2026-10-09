// Files for agents, phase 8: agents make pictures. Which hires get the tool, what it does with a picture, and the
// three limits that hold the spend. No picture model is called: the drawing is a stand-in, or a mocked fetch.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "@/lib/db";
import { createTask } from "@/lib/tasks";
import { filesOfTask, sha256Of } from "@/lib/agentFiles";
import {
  picturesEnabled, pictureModel, pictureQuality, dailyPictures, pictureCostUsd, mayDraw, pictureTool, withPictures, canDraw, drawPicture,
  PICTURES_PER_HIRE, type Draw,
} from "@/lib/agentPictures";
import { lineFor } from "@/lib/liveLog";
import { hasTools } from "@/lib/agentTools";

const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, fill)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 3)]);
let dir = "";
const saved = { ...process.env };
const claude = { provider: "anthropic" as const, capabilities: ["research"] };
const job = () => createTask({ fromAgent: "buyer", toAgent: "artist", task: "Draw a poster", initialStatus: "running", startedBy: "worker" }).taskId;

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-pictures-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FILES: "on", AGENT_PICTURES: "on", AXON_FILES_DIR: dir, OPENAI_API_KEY: "test-openai", XAI_API_KEY: "test-xai" });
  for (const k of ["AGENT_PICTURE_MODEL", "AGENT_PICTURE_QUALITY", "AGENT_PICTURES_DAILY_MAX"]) delete process.env[k];
  getDb().exec("DELETE FROM task_files; DELETE FROM rate_limit_windows; DELETE FROM tasks;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the switch and the settings", () => {
  it("is on only inside files, and has sane defaults", () => {
    expect(picturesEnabled({})).toBe(false);
    expect(picturesEnabled({ AGENT_PICTURES: "on" })).toBe(false);
    expect(picturesEnabled({ AGENT_FILES: "on", AGENT_PICTURES: "on" })).toBe(true);
    expect(pictureModel({})).toBe("gpt-image-1-mini");
    expect(pictureModel({ AGENT_PICTURE_MODEL: " grok-imagine-image " })).toBe("grok-imagine-image");
    expect(pictureQuality({})).toBe("medium");
    expect(pictureQuality({ AGENT_PICTURE_QUALITY: "HIGH" })).toBe("high");
    expect(pictureQuality({ AGENT_PICTURE_QUALITY: "ultra" })).toBe("medium");
    expect(dailyPictures({})).toBe(200);
    expect(dailyPictures({ AGENT_PICTURES_DAILY_MAX: "0" })).toBe(0);
    expect(dailyPictures({ AGENT_PICTURES_DAILY_MAX: "nope" })).toBe(200);
    expect(pictureCostUsd("gpt-image-1-mini", "medium", "square")).toBe(0.011);
    expect(pictureCostUsd("gpt-image-1-mini", "medium", "wide")).toBe(0.015);
    expect(pictureCostUsd("some-other-model", "medium", "square")).toBeNull();
  });
});

describe("which hires get the picture tool", () => {
  it("a hire that asks for a picture, or an agent whose job is pictures, on an agent Axon runs on Claude", () => {
    expect(mayDraw(claude, "Design a logo for my coffee shop")).toBe(true);
    expect(mayDraw(claude, "Make me an image of a fox in a forest")).toBe(true);
    expect(mayDraw(claude, "Draw a poster for the launch")).toBe(true);
    expect(mayDraw({ provider: "anthropic" as const, capabilities: ["image generation", "design feedback"] }, "Something for the homepage")).toBe(true);
    expect(mayDraw({ provider: "anthropic" as const, capabilities: [] }, "an illustration of a robot")).toBe(true);
  });

  it("and no other hire: plain jobs, other models, agents that hand work on, agents on their own server, or while it is off", () => {
    expect(mayDraw(claude, "Summarise this contract and list the risks")).toBe(false);
    expect(mayDraw(claude, "What does the big picture look like for ETH?")).toBe(true); // the word is there: one picture at most, and only if the agent chooses to
    expect(mayDraw(claude, "Imagine the best pricing for my app")).toBe(false);
    expect(mayDraw({ provider: "openai" as const, capabilities: ["image generation"] }, "Draw a logo")).toBe(false);
    expect(mayDraw({ ...claude, orchestrator: true }, "Draw a logo")).toBe(false);
    expect(mayDraw(claude, "Draw a logo", { viaMcp: true })).toBe(false);
    expect(mayDraw(claude, "Draw a logo", { env: { AGENT_FILES: "on" } })).toBe(false);
    expect(mayDraw(claude, "Draw a logo", { env: { AGENT_PICTURES: "on" } })).toBe(false);
  });

  it("is added to an agent's tools once, beside whatever it already has", () => {
    const tool = pictureTool({ taskId: "t", wallet: null, paid: false });
    const one = withPictures(null, tool);
    expect(hasTools(one)).toBe(true);
    expect(canDraw(one)).toBe(true);
    expect(one.grants).toEqual(["make_picture"]);
    expect(withPictures(one, tool)).toBe(one);
    expect(canDraw(null)).toBe(false);
    expect(tool.inputSchema).toMatchObject({ required: ["prompt"] });
  });
});

describe("making a picture", () => {
  it("draws it, keeps it with the job under a name from the request, and tells the agent what the file is called", async () => {
    const taskId = job();
    const asked: unknown[] = [], madeNames: string[] = [];
    const draw: Draw = async (input) => { asked.push(input); return png(1); };
    const tool = pictureTool({ taskId, wallet: null, paid: true, draw, onMade: (f) => madeNames.push(f.name) });
    const said = await tool.run({ prompt: "A red fox reading a newspaper, flat vector style", shape: "wide", name: "Fox Poster.PNG" });
    expect(asked).toEqual([{ prompt: "A red fox reading a newspaper, flat vector style", shape: "wide" }]);
    expect(said).toBe("Saved as fox-poster.png. The person receives it with your answer. You can make 2 more in this job.");
    const out = filesOfTask(taskId, "out");
    expect(out.map((f) => [f.name, f.mime, f.sha256])).toEqual([["fox-poster.png", "image/png", sha256Of(png(1))]]);
    expect(madeNames).toEqual(["fox-poster.png"]);
    // with no name given, the name comes from the description; a JPEG is kept as a JPEG; an odd shape is square
    const draw2: Draw = async (input) => { asked.push(input); return JPEG; };
    const second = pictureTool({ taskId, wallet: null, paid: true, draw: draw2 });
    expect(await second.run({ prompt: "Mountains at dawn, oil painting, wide brush strokes", shape: "hexagon" })).toMatch(/^Saved as mountains-at-dawn-oil-painting-wide\.jpg\./);
    expect(asked.at(-1)).toMatchObject({ shape: "square" });
  });

  it("holds a hire to its count: one on a free hire, three on a paid one", async () => {
    const draw: Draw = vi.fn(async () => png(Math.floor(Math.random() * 200) + 10));
    const free = pictureTool({ taskId: job(), wallet: null, paid: false, draw });
    expect(await free.run({ prompt: "A lighthouse in a storm, woodcut" })).toMatch(/That was the last picture this job can make\.$/);
    await expect(free.run({ prompt: "Another lighthouse, in sunshine" })).rejects.toThrow("This job has made its one picture. Go on with what you have.");
    const paid = pictureTool({ taskId: job(), wallet: null, paid: true, draw });
    for (let i = 0; i < PICTURES_PER_HIRE.paid; i++) await paid.run({ prompt: `Lighthouse number ${i}, woodcut` });
    await expect(paid.run({ prompt: "One lighthouse too many" })).rejects.toThrow("This job has made its 3 pictures.");
    expect(draw).toHaveBeenCalledTimes(1 + PICTURES_PER_HIRE.paid);
  });

  it("holds the whole network to its day, and a failed drawing still counts against the hire", async () => {
    process.env.AGENT_PICTURES_DAILY_MAX = "2";
    const draw: Draw = vi.fn(async () => png(Math.floor(Math.random() * 200) + 10));
    await pictureTool({ taskId: job(), wallet: null, paid: false, draw }).run({ prompt: "First picture of the day" });
    await pictureTool({ taskId: job(), wallet: null, paid: false, draw }).run({ prompt: "Second picture of the day" });
    await expect(pictureTool({ taskId: job(), wallet: null, paid: false, draw }).run({ prompt: "Third picture of the day" })).rejects.toThrow("No more pictures can be made today.");
    expect(draw).toHaveBeenCalledTimes(2);
    process.env.AGENT_PICTURES_DAILY_MAX = "0";
    await expect(pictureTool({ taskId: job(), wallet: null, paid: true, draw }).run({ prompt: "None today at all" })).rejects.toThrow("No more pictures can be made today.");

    delete process.env.AGENT_PICTURES_DAILY_MAX;
    getDb().exec("DELETE FROM rate_limit_windows;");
    const broken: Draw = async () => { throw new Error("The picture model would not draw that. Describe it differently, or go on without the picture."); };
    const tool = pictureTool({ taskId: job(), wallet: null, paid: false, draw: broken });
    await expect(tool.run({ prompt: "Something it refuses to draw" })).rejects.toThrow("would not draw that");
    await expect(tool.run({ prompt: "Something harmless instead" })).rejects.toThrow("This job has made its one picture.");
  });

  it("asks for a real description", async () => {
    const tool = pictureTool({ taskId: job(), wallet: null, paid: true, draw: async () => png(4) });
    await expect(tool.run({ prompt: "fox" })).rejects.toThrow("Describe the picture in a full sentence or more.");
    await expect(tool.run({})).rejects.toThrow("Describe the picture");
    await expect(tool.run({ prompt: "x".repeat(4001) })).rejects.toThrow("too long");
  });

  it("reads as a step in the live log", () => {
    expect(lineFor({ type: "tool", id: "t1", tool: "make_picture", input: { prompt: "A red fox reading a newspaper" } })).toBe("Drawing: A red fox reading a newspaper");
    expect(lineFor({ type: "tool", id: "t2", tool: "make_picture", input: {} })).toBe("Drawing a picture");
  });
});

describe("the picture model", () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("is asked for one picture in the shape wanted, and what comes back must be a picture", async () => {
    const f = answer(200, { data: [{ b64_json: png(8).toString("base64") }] });
    vi.stubGlobal("fetch", f);
    expect((await drawPicture({ prompt: "A fox", shape: "tall" })).equals(png(8))).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init.headers.authorization).toBe("Bearer test-openai");
    expect(JSON.parse(init.body)).toEqual({ model: "gpt-image-1-mini", prompt: "A fox", n: 1, size: "1024x1536", quality: "medium", output_format: "png" });

    vi.stubGlobal("fetch", answer(200, { data: [{ b64_json: Buffer.from("not a picture").toString("base64") }] }));
    await expect(drawPicture({ prompt: "A fox", shape: "square" })).rejects.toThrow("returned nothing usable");
    vi.stubGlobal("fetch", answer(200, { data: [] }));
    await expect(drawPicture({ prompt: "A fox", shape: "square" })).rejects.toThrow("returned nothing usable");
  });

  it("can be another maker's model, and says no in words the agent can act on", async () => {
    process.env.AGENT_PICTURE_MODEL = "grok-imagine-image";
    const f = answer(200, { data: [{ b64_json: JPEG.toString("base64") }] });
    vi.stubGlobal("fetch", f);
    expect((await drawPicture({ prompt: "A fox", shape: "square" })).equals(JPEG)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.x.ai/v1/images/generations");
    expect(init.headers.authorization).toBe("Bearer test-xai");
    expect(JSON.parse(init.body)).toEqual({ model: "grok-imagine-image", prompt: "A fox", n: 1, response_format: "b64_json" });
    delete process.env.AGENT_PICTURE_MODEL;

    vi.stubGlobal("fetch", answer(400, { error: { code: "moderation_blocked", message: "Your request was rejected by the safety system." } }));
    await expect(drawPicture({ prompt: "A fox", shape: "square" })).rejects.toThrow("The picture model would not draw that.");
    vi.stubGlobal("fetch", answer(429, { error: { message: "Rate limit" } }));
    await expect(drawPicture({ prompt: "A fox", shape: "square" })).rejects.toThrow("The picture model is busy.");
    vi.stubGlobal("fetch", answer(500, { error: { message: "sk-live-secret-should-not-leak" } }));
    await expect(drawPicture({ prompt: "A fox", shape: "square" })).rejects.toThrow(/^The picture could not be made\. Go on without it\.$/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    await expect(drawPicture({ prompt: "A fox", shape: "square" })).rejects.toThrow("did not answer in time");
    delete process.env.OPENAI_API_KEY;
    await expect(drawPicture({ prompt: "A fox", shape: "square" })).rejects.toThrow("Pictures cannot be made right now.");
  });
});
