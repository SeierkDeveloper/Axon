// Files for agents, phase 3: pictures made ready for a model to look at, and pictures given to GPT and Grok agents.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import sharp from "sharp";

const sent = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[], answers: [] as { status: number; body: unknown }[] }));
vi.mock("@/lib/urlSecurity", async (orig) => ({
  ...(await orig<typeof import("@/lib/urlSecurity")>()),
  publicHttpFetch: async (_url: string, init: { body: string }) => {
    sent.bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const a = sent.answers.shift() ?? { status: 200, body: { choices: [{ message: { content: "It is a bar chart." } }] } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  },
}));

import { forModel, canScale, MAX_SIDE, PASS_BYTES } from "@/lib/agentImages";
import { getProvider } from "@/lib/providers";
import type { Agent } from "@/sdk/types";

const saved = { ...process.env };
beforeEach(() => { sent.bodies.length = 0; sent.answers.length = 0; });
afterAll(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

const noise = (w: number, h: number, channels: 3 | 4 = 3) => {
  const raw = Buffer.alloc(w * h * channels);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24; // busy enough not to compress to nothing
  return sharp(raw, { raw: { width: w, height: h, channels } });
};

describe("a picture, made ready for a model", () => {
  it("can scale pictures here", async () => {
    expect(await canScale()).toBe(true);
  });

  it("goes through untouched when it already fits", async () => {
    const small = await noise(800, 600).png().toBuffer();
    const r = await forModel(small, "image/png");
    expect(r.scaled).toBe(false);
    expect(r.data).toBe(small);
    expect(r).toMatchObject({ mime: "image/png", width: 800, height: 600 });
  });

  it("is brought down to the size a model looks at when it is larger, keeping its shape", async () => {
    const photo = await noise(4000, 3000).jpeg({ quality: 95 }).toBuffer();
    const r = await forModel(photo, "image/jpeg");
    expect(r.scaled).toBe(true);
    expect(r.mime).toBe("image/jpeg");
    expect(r.width).toBe(MAX_SIDE);
    expect(r.height).toBe(Math.round((3000 / 4000) * MAX_SIDE));
    expect(r.data.length).toBeLessThan(photo.length);
    const tall = await forModel(await noise(1000, 5000).jpeg().toBuffer(), "image/jpeg");
    expect(tall).toMatchObject({ scaled: true, height: MAX_SIDE, width: Math.round((1000 / 5000) * MAX_SIDE) });
  });

  it("keeps transparency as PNG, and re-encodes a heavy picture that is small in pixels", async () => {
    const logo = await noise(3000, 3000, 4).png().toBuffer();
    const r = await forModel(logo, "image/png");
    expect(r).toMatchObject({ scaled: true, mime: "image/png", width: MAX_SIDE, height: MAX_SIDE });
    const heavy = await noise(1500, 1500).png({ compressionLevel: 0 }).toBuffer();
    expect(heavy.length).toBeGreaterThan(PASS_BYTES);
    const h = await forModel(heavy, "image/png");
    expect(h).toMatchObject({ scaled: true, mime: "image/jpeg", width: 1500, height: 1500 });
    expect(h.data.length).toBeLessThan(heavy.length);
  });

  it("hands over what it cannot read exactly as it came, and never throws", async () => {
    const junk = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
    const r = await forModel(junk, "image/png");
    expect(r).toEqual({ data: junk, mime: "image/png", scaled: false, width: null, height: null });
  });
});

describe("pictures for an agent on GPT or Grok", () => {
  const agent = (provider: "openai" | "grok"): Agent => ({ agentId: "a", name: "a", capabilities: [], publicKey: "pk", provider, createdAt: new Date().toISOString() });
  const pictures = [{ kind: "image" as const, mime: "image/png", name: "chart.png", data: "UE5H" }];

  it("go in as parts of the user turn, after the words", async () => {
    process.env.OPENAI_API_KEY = "test";
    const out = await getProvider(agent("openai")).complete("You read charts.", "What does this show?", 500, undefined, pictures);
    expect(out).toBe("It is a bar chart.");
    const messages = sent.bodies[0].messages as { role: string; content: unknown }[];
    expect(messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "What does this show?" }, { type: "image_url", image_url: { url: "data:image/png;base64,UE5H" } }] });
    // with no pictures the request is what it always was
    await getProvider(agent("openai")).complete("s", "plain words", 500);
    expect((sent.bodies[1].messages as { content: unknown }[])[1].content).toBe("plain words");
  });

  it("a PDF is never sent to these models, only pictures", async () => {
    process.env.XAI_API_KEY = "test";
    await getProvider(agent("grok")).complete("s", "Read both", 500, undefined, [{ kind: "pdf", mime: "application/pdf", name: "a.pdf", data: "UERG" }, ...pictures]);
    const content = (sent.bodies[0].messages as { content: { type: string }[] }[])[1].content;
    expect(content.map((c) => c.type)).toEqual(["text", "image_url"]);
  });

  it("a model that will not take pictures still answers, from the words, and is told why", async () => {
    process.env.OPENAI_API_KEY = "test";
    sent.answers.push({ status: 400, body: { error: { message: "image input is not supported by this model" } } });
    sent.answers.push({ status: 200, body: { choices: [{ message: { content: "I cannot see the picture." } }] } });
    const out = await getProvider(agent("openai")).complete("s", "What does this show?", 500, undefined, pictures);
    expect(out).toBe("I cannot see the picture.");
    expect(sent.bodies).toHaveLength(2);
    const second = (sent.bodies[1].messages as { content: unknown }[])[1].content;
    expect(typeof second).toBe("string");
    expect(second).toContain("The attached pictures could not be shown to you");
    // any other failure is not swallowed
    sent.answers.push({ status: 401, body: { error: { message: "bad key" } } });
    await expect(getProvider(agent("openai")).complete("s", "x", 500, undefined, pictures)).rejects.toThrow(/401/);
  });
});
