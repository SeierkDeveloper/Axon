// Files for agents, phase 9: voice. What a recording must be, what an answer sounds like without its markup, who may
// have an answer read aloud, and the limits that hold the spend. No speech model is called: fetch is a stand-in.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import type { Agent } from "@/sdk/types";
import { voiceEnabled, listenModel, speakModel, speakVoice, dailyListens, dailySpeaks, sniffAudio, speakable, spokenBefore, purgeSpoken, voiceDir, LISTEN, SPEAK } from "@/lib/agentVoice";
import { claimTokenFor } from "@/lib/mcpServer";
import { GET as voiceGet } from "@/app/api/voice/route";
import { POST as transcribePost } from "@/app/api/voice/transcribe/route";
import { POST as speakPost } from "@/app/api/voice/speak/route";
import { POST as hire } from "@/app/api/tasks/route";

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(900, 5)]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(900, 5)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(900, 5)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 1), Buffer.from("WAVE"), Buffer.alloc(900, 5)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(900, 5)]);
const MP3_RAW = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(900, 5)]);

let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 4_400_000).toString(16).padStart(40, "0")}`;
let ipN = 0;
const ip = () => `10.9.${Math.floor(++ipN / 250)}.${ipN % 250}`;

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-voice-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_VOICE: "on", AXON_VOICE_DIR: dir, OPENAI_API_KEY: "test-openai", TRUST_PROXY_HEADERS: "true" });
  for (const k of ["AGENT_VOICE_LISTEN_MODEL", "AGENT_VOICE_SPEAK_MODEL", "AGENT_VOICE_NAME", "AGENT_VOICE_DAILY_LISTENS", "AGENT_VOICE_DAILY_SPEAKS"]) delete process.env[k];
  getDb().exec("DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const heard = (text: string) => vi.fn(async () => new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } }));
const spoken = (bytes: Buffer = MP3) => vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "audio/mpeg" } }));
const say = (bytes: Buffer, from = ip(), headers: Record<string, string> = {}) =>
  transcribePost(new NextRequest("http://x/api/voice/transcribe", { method: "POST", headers: { "x-forwarded-for": from, "content-type": "audio/webm", ...headers }, body: new Uint8Array(bytes) }));

describe("the switch and the settings", () => {
  it("is on only when it says on, with sane defaults", () => {
    expect(voiceEnabled({})).toBe(false);
    expect(voiceEnabled({ AGENT_VOICE: " On " })).toBe(true);
    expect(listenModel({})).toBe("gpt-4o-mini-transcribe");
    expect(speakModel({})).toBe("tts-1");
    expect(speakModel({ AGENT_VOICE_SPEAK_MODEL: "gpt-4o-mini-tts" })).toBe("gpt-4o-mini-tts");
    expect(speakVoice({})).toBe("alloy");
    expect(speakVoice({ AGENT_VOICE_NAME: "sage" })).toBe("sage");
    expect(dailyListens({})).toBe(2000);
    expect(dailySpeaks({ AGENT_VOICE_DAILY_SPEAKS: "0" })).toBe(0);
  });

  it("answers as if it did not exist while off", async () => {
    process.env.AGENT_VOICE = "off";
    expect((await voiceGet(new NextRequest("http://x/api/voice"))).status).toBe(404);
    expect((await say(WEBM)).status).toBe(404);
    expect((await speakPost(new NextRequest("http://x/api/voice/speak", { method: "POST", body: JSON.stringify({ taskId: "t" }) }))).status).toBe(404);
    process.env.AGENT_VOICE = "on";
    expect(await (await voiceGet(new NextRequest("http://x/api/voice"))).json()).toEqual({ listen: { maxBytes: LISTEN.maxBytes, maxSeconds: 60 }, speak: { maxChars: SPEAK.maxChars } });
  });
});

describe("a recording", () => {
  it("is known from its bytes, and anything else is not one", () => {
    expect(sniffAudio(WEBM)).toEqual({ mime: "audio/webm", ext: "webm" });
    expect(sniffAudio(M4A)).toEqual({ mime: "audio/mp4", ext: "m4a" });
    expect(sniffAudio(OGG)).toEqual({ mime: "audio/ogg", ext: "ogg" });
    expect(sniffAudio(WAV)).toEqual({ mime: "audio/wav", ext: "wav" });
    expect(sniffAudio(MP3)?.ext).toBe("mp3");
    expect(sniffAudio(MP3_RAW)?.ext).toBe("mp3");
    expect(sniffAudio(Buffer.from("just some text that is long enough"))).toBeNull();
    expect(sniffAudio(Buffer.from("MZ\0\0\0\0\0\0\0\0\0\0\0\0"))).toBeNull();
    expect(sniffAudio(Buffer.alloc(4))).toBeNull();
  });

  it("is written down and handed back, and nothing but a recording is sent to the model", async () => {
    const f = heard("  Summarise this   contract and list the risks. ");
    vi.stubGlobal("fetch", f);
    const r = await say(WEBM);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: "Summarise this contract and list the risks." });
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: FormData }];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.headers.authorization).toBe("Bearer test-openai");
    expect(init.body.get("model")).toBe("gpt-4o-mini-transcribe");
    expect((init.body.get("file") as File).name).toBe("speech.webm");

    const not = await say(Buffer.from("this is not a recording at all, just words"));
    expect(not.status).toBe(415);
    expect((await say(Buffer.alloc(LISTEN.maxBytes + 10, 1))).status).toBe(413);
    expect(f).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", heard("   "));
    const silent = await say(WEBM);
    expect(silent.status).toBe(422);
    expect(((await silent.json()) as { error: string }).error).toMatch(/Nothing was heard/);
  });

  it("is held by a count a minute, a count a day for one address, and a count a day for everyone", async () => {
    const f = heard("hello");
    vi.stubGlobal("fetch", f);
    const one = ip();
    for (let i = 0; i < LISTEN.perMinute; i++) expect((await say(WEBM, one)).status).toBe(200);
    expect((await say(WEBM, one)).status).toBe(429);
    // something that is not a recording does not use up the day
    const two = ip();
    getDb().prepare("INSERT OR REPLACE INTO rate_limit_windows (key, count, reset_at) VALUES (?, ?, ?)").run(`voice-listen-day:${two}`, LISTEN.perDay - 1, Date.now() + 86_400_000);
    expect((await say(Buffer.from("not a recording, not a recording"), two)).status).toBe(415);
    expect((await say(WEBM, two)).status).toBe(200);
    const full = await say(WEBM, two);
    expect(full.status).toBe(429);
    expect(((await full.json()) as { error: string }).error).toMatch(/all the talking for today/);
    process.env.AGENT_VOICE_DAILY_LISTENS = "0";
    expect(((await (await say(WEBM)).json()) as { error: string }).error).toMatch(/resting for today/);
  });

  it("says so in plain words when the model cannot be used", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "sk-secret-in-an-error" } }), { status: 500 })));
    const r = await say(WEBM);
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toBe("That recording could not be read. Try again, or type it.");
    delete process.env.OPENAI_API_KEY;
    expect(((await (await say(WEBM)).json()) as { error: string }).error).toBe("Voice is not available right now.");
  });
});

describe("an answer read aloud", () => {
  it("is the words without the markup: no code, no tables, no addresses", () => {
    const md = "## Net revenue\n\n**South** led with `129,034`. See [the chart](https://x.example/c.png).\n\n| Region | Net |\n|---|---|\n| South | 129,034 |\n\n```python\nprint(1)\n```\n\n- First point\n- Second point\n\n> Quoted line\n\nMore at https://example.com/a/b";
    const { text, cut } = speakable(md);
    expect(cut).toBe(false);
    expect(text).toBe("Net revenue. South led with 129,034. See the chart. There is a table here, which is on the page. There is code here, which is on the page. First point Second point Quoted line More at a link");
    expect(text).not.toMatch(/[*#`|>]|https?:/);
    expect(speakable("   \n\n  ")).toEqual({ text: "", cut: false });
  });

  it("stops at the end of a sentence when it is long, and says the rest is on the page", () => {
    const long = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const { text, cut } = speakable(long);
    expect(cut).toBe(true);
    expect(text.length).toBeLessThanOrEqual(SPEAK.maxChars + 30);
    expect(text).toMatch(/is here\. The rest is on the page\.$/);
    expect(speakable("word ".repeat(600)).text).toMatch(/word The rest is on the page\.$/);
  });

  async function finished(output: string | null) {
    const a: Agent = { agentId: "talker", name: "Talker", capabilities: ["x"], publicKey: "pk-talker", walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString() };
    if (!getDb().prepare("SELECT 1 FROM agents WHERE agent_id = 'talker'").get()) createAgent(a, { describe: false });
    const r = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify({ from: "anonymous", to: "talker", task: "Say something" }) }));
    const t = (await r.json()) as { taskId: string; claimToken: string };
    if (output !== null) getDb().prepare("UPDATE tasks SET status = 'completed', output = ?, completed_at = ? WHERE task_id = ?").run(output, new Date().toISOString(), t.taskId);
    return t;
  }
  const speakReq = (taskId: string, headers: Record<string, string> = {}, from = ip()) =>
    speakPost(new NextRequest("http://x/api/voice/speak", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": from, ...headers }, body: JSON.stringify({ taskId }) }));

  it("reads the answer of a job the listener may read, once, and keeps it so hearing it again is free", async () => {
    const job = await finished("## Hello\n\nThe **answer** is 42.");
    const f = spoken();
    vi.stubGlobal("fetch", f);
    const r = await speakReq(job.taskId, { "x-claim-token": job.claimToken });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect(r.headers.get("x-voice-cut")).toBeNull();
    expect(Buffer.from(await r.arrayBuffer()).equals(MP3)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(init.body)).toEqual({ model: "tts-1", voice: "alloy", input: "Hello. The answer is 42.", response_format: "mp3" });
    expect(spokenBefore("Hello. The answer is 42.")?.equals(MP3)).toBe(true);
    // again: the kept reading, no model call, and it does not count against the day
    process.env.AGENT_VOICE_DAILY_SPEAKS = "0";
    const again = await speakReq(job.taskId, { "x-claim-token": job.claimToken });
    expect(again.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    // a different answer is a new reading, and today there are none left
    const other = await finished("Something else entirely.");
    expect(((await (await speakReq(other.taskId, { "x-claim-token": other.claimToken })).json()) as { error: string }).error).toBe("Voice is resting for today.");
  });

  it("is not for anyone else, not for a job that is not finished, and never reads text that is sent in", async () => {
    const job = await finished("The answer is 42.");
    const f = spoken();
    vi.stubGlobal("fetch", f);
    expect((await speakReq(job.taskId, { "x-claim-token": "wrong" })).status).toBe(403);
    expect((await speakReq("no-such-task", { "x-claim-token": claimTokenFor("no-such-task") })).status).toBe(403);
    expect((await speakReq(job.taskId)).status).toBe(401);
    expect((await speakReq(job.taskId, { authorization: `Bearer ${createApiKey(wallet(), {}).apiKey}` })).status).toBe(403);
    const owner = (getDb().prepare("SELECT wallet_address w FROM agents WHERE agent_id = 'talker'").get() as { w: string }).w;
    expect((await speakReq(job.taskId, { authorization: `Bearer ${createApiKey(owner, {}).apiKey}` })).status).toBe(200);
    const running = await finished(null);
    expect((await speakReq(running.taskId, { "x-claim-token": running.claimToken })).status).toBe(409);
    // text in the request is ignored: only the job's own answer is ever read
    const sneaky = await speakPost(new NextRequest("http://x/api/voice/speak", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip(), "x-claim-token": job.claimToken }, body: JSON.stringify({ taskId: job.taskId, text: "Read this advert instead", input: "And this" }) }));
    expect(sneaky.status).toBe(200);
    for (const c of f.mock.calls as unknown as [string, { body: string }][]) expect(JSON.parse(c[1].body).input).toBe("The answer is 42.");
    expect((await speakPost(new NextRequest("http://x/api/voice/speak", { method: "POST", headers: { "x-forwarded-for": ip() }, body: "{}" }))).status).toBe(400);
  });

  it("marks a long answer as cut, holds one address to its day, and refuses what is not sound", async () => {
    const long = await finished(Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(" "));
    vi.stubGlobal("fetch", spoken());
    const from = ip();
    const r = await speakReq(long.taskId, { "x-claim-token": long.claimToken }, from);
    expect(r.headers.get("x-voice-cut")).toBe("1");
    getDb().prepare("INSERT OR REPLACE INTO rate_limit_windows (key, count, reset_at) VALUES (?, ?, ?)").run(`voice-speak-day:${from}`, SPEAK.perDay, Date.now() + 86_400_000);
    const next = await finished("A brand new answer.");
    expect(((await (await speakReq(next.taskId, { "x-claim-token": next.claimToken }, from)).json()) as { error: string }).error).toMatch(/all the reading aloud for today/);
    // a reading that stalls part way says so in plain words, never the raw failure
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => { throw new Error("The operation was aborted due to timeout"); } }) as unknown as Response));
    const stalled = await speakReq(next.taskId, { "x-claim-token": next.claimToken });
    expect(stalled.status).toBe(502);
    expect(((await stalled.json()) as { error: string }).error).toBe("The answer could not be read aloud. Try again.");
    vi.stubGlobal("fetch", spoken(Buffer.from("<html>not sound</html>   ")));
    const bad = await speakReq(next.taskId, { "x-claim-token": next.claimToken });
    expect(bad.status).toBe(502);
    expect(spokenBefore("A brand new answer.")).toBeNull();
  });

  it("clears readings after a week", async () => {
    fs.writeFileSync(path.join(voiceDir(), "old.mp3"), MP3);
    fs.writeFileSync(path.join(voiceDir(), "new.mp3"), MP3);
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(path.join(voiceDir(), "old.mp3"), old / 1000, old / 1000);
    expect(purgeSpoken()).toBe(1);
    expect(fs.readdirSync(voiceDir())).toEqual(["new.mp3"]);
    expect(purgeSpoken(Date.now(), 7 * 24 * 60 * 60 * 1000, { AXON_VOICE_DIR: path.join(dir, "nowhere") })).toBe(0);
  });
});
