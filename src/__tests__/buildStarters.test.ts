// Agents that build, phase 10: starter jobs. An agent that builds is offered building jobs to tap, beside the
// starters it had; each one is worded so the hire really is given the build tool.

import { describe, it, expect } from "vitest";
import { startersFor, STARTERS } from "@/lib/starterJobs";
import { asksToBuild, mayBuild } from "@/lib/buildTool";

const on = { AGENT_STARTERS: "on" };
const all = (caps: string[], can: Parameters<typeof startersFor>[1]) => startersFor({ capabilities: caps }, can, on);
const building = (caps: string[], can: Parameters<typeof startersFor>[1]) => all(caps, can).filter((s) => s.builds).map((s) => s.id);
const builder = { builds: true, forms: true, files: true };

// between them these agents are offered every building job there is
const AGENTS: string[][] = [["analysis"], ["data analysis"], ["research"], ["scheduling"], ["writing"], ["coding"], ["translation"], []];

describe("building starter jobs", () => {
  it("an agent that does not build is offered none, and keeps the starters it had", () => {
    const before = all(["research", "writing"], { files: true });
    expect(before.some((s) => s.builds)).toBe(false);
    const after = all(["research", "writing"], { files: true, builds: true, forms: true });
    expect(after.filter((s) => !s.builds)).toEqual(before);
  });

  it("an agent that builds is offered a few, after its other starters", () => {
    const got = all(["research", "writing"], { ...builder });
    const first = got.findIndex((s) => s.builds);
    expect(first).toBeGreaterThan(0);
    expect(got.slice(first).every((s) => s.builds)).toBe(true);
    expect(got.filter((s) => s.builds)).toHaveLength(STARTERS.building);
    expect(got.filter((s) => !s.builds).length).toBeLessThanOrEqual(STARTERS.most);
  });

  it("the ones that fit the agent stand first, and every agent that builds gets a landing page", () => {
    expect(building(["analysis"], builder)).toEqual(["build-dashboard", "build-calculator", "build-landing"]);
    expect(building(["analysis"], { builds: true, forms: true })).toEqual(["build-calculator", "build-landing", "build-rsvp"]);
    expect(building(["coding"], builder)).toEqual(["build-game", "build-landing", "build-rsvp"]);
    expect(building(["translation"], builder)).toEqual(["build-landing", "build-rsvp"]);
    // an agent that lists nothing still builds
    expect(building([], builder)).toEqual(["build-landing", "build-rsvp"]);
    expect(all([], builder)[0].id).toBe("show");
  });

  it("a form is only offered where a built page can collect answers, a spreadsheet only where the agent reads files", () => {
    expect(building(["translation"], { builds: true })).toEqual(["build-landing"]);
    expect(building(["data analysis"], { builds: true, forms: true })).not.toContain("build-dashboard");
    const dash = all(["data analysis"], builder).find((s) => s.id === "build-dashboard")!;
    expect(dash.sample?.path).toBe("/starters/sales.csv");
  });

  it("none while starters are off", () => {
    expect(startersFor({ capabilities: ["coding"] }, builder, { AGENT_STARTERS: "off" })).toEqual([]);
  });

  it("every building job is one the hire is given the build tool for, in plain words", () => {
    const seen = new Map<string, string>();
    for (const caps of AGENTS) for (const s of all(caps, builder).filter((x) => x.builds)) seen.set(s.id, s.task);
    expect([...seen.keys()].sort()).toEqual(["build-calculator", "build-countdown", "build-dashboard", "build-game", "build-landing", "build-prices", "build-quiz", "build-rsvp"]);
    for (const [id, task] of seen) {
      expect(asksToBuild(task), id).toBe(true);
      // whatever the agent lists: the job's own words are enough
      expect(mayBuild({ provider: "anthropic", capabilities: ["translation"] }, task, { env: { AGENT_SITES: "on" } }), id).toBe(true);
      expect(task, id).not.toMatch(/—|\[|\]|TODO|\.\.\./);
      // a built page keeps nothing between two visits, so no job asks it to
      expect(task, id).not.toMatch(/remember|save|reload|log ?in|password/i);
    }
    // and no label is used twice on one agent's page
    for (const caps of AGENTS) { const labels = all(caps, builder).map((s) => s.label); expect(new Set(labels).size).toBe(labels.length); }
  });
});
