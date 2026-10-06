// Mylo meets the minds, phase 7: what Mylo is told about tokens before he says a word about one. He reports and never
// advises; the rules ride in his instructions whenever Agent Minds is on, and what a call may cost counts every tool.
import { describe, it, expect, vi } from "vitest";
import { MINDS_NOTE, MYLO_SYSTEM, requestBytes } from "@/lib/myloChat";
import { myloToolDefs, MINDS_TOOL_DEFS } from "@/lib/myloTools";

describe("what Mylo is told about tokens", () => {
  it("is told to report and never to advise, predict or act for anyone", () => {
    for (const rule of [
      /Never say whether to buy, sell or hold a token/,
      /Never predict a price, a market cap, or what a mind will do next/,
      /Never say a burn, a buyback, a reward or any setting will raise a price/,
      /Nothing locked at launch can be changed/,
      /Never say the supply shrinks, drops or is reduced/,
      /Never guess why a mind is stopped, paused or quiet/,
      /Describe, don't praise/,
      /never ask whether they are and never ask for an address: call it/,
      /You never sign, launch, claim, buy or send anything for anyone/,
      /A mind's thoughts are its own words/,
      /Give how many holders a token has, never who they are/,
      /Any token can go to zero/,
    ]) expect(MINDS_NOTE).toMatch(rule);
    // the rules come last, after everything he is told he can do
    expect(MINDS_NOTE.indexOf("Rules for anything about tokens")).toBeGreaterThan(MINDS_NOTE.indexOf("token_details reads one token"));
  });

  it("is told how to use each of the tools that read tokens, and how to set a launch up", () => {
    for (const d of MINDS_TOOL_DEFS) expect(MINDS_NOTE).toContain(d.name);
    expect(MINDS_NOTE).toMatch(/one\s+or two questions at a time/);
    expect(MINDS_NOTE).toMatch(/never tell them\s+which numbers are best/);
    expect(MINDS_NOTE).toMatch(/A mind on their own server cannot be set from here/);
  });

  it("says nothing in his instructions that reads as written by a machine", () => {
    expect(MINDS_NOTE).not.toMatch(/—/);
  });

  it("counts every tool that is sent when working out what a call may cost", () => {
    vi.stubEnv("AGENT_MINDS", "off");
    const without = requestBytes(MYLO_SYSTEM, []);
    vi.stubEnv("AGENT_MINDS", "on");
    const withMinds = requestBytes(MYLO_SYSTEM, []);
    expect(withMinds).toBeGreaterThan(without);
    expect(withMinds - without).toBeGreaterThan(JSON.stringify(MINDS_TOOL_DEFS).length);
    expect(myloToolDefs().map((t) => t.name as string)).toContain("my_tokens");
  });
});
