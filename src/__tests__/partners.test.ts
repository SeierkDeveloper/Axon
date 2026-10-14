// The partners on the homepage: each has its mark in /public, real links, and words that only say what is true.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { partners } from "@/lib/partners";

describe("partners on the homepage", () => {
  it("each one has a name, a mark that is really there, and its site and X account", () => {
    expect(partners.map((p) => p.name)).toEqual(["AUREON", "HEY Research Lab", "NockAI"]);
    for (const p of partners) {
      expect(fs.existsSync(path.join(process.cwd(), "public", p.mark)), p.mark).toBe(true);
      expect(p.site.href).toMatch(/^https:\/\/[a-z0-9.-]+$/);
      expect(p.site.href).toContain(p.site.label);
      expect(p.x.href).toBe(`https://x.com/${p.x.handle.slice(1)}`);
      expect(p.x.handle).toMatch(/^@\w+$/);
      expect(p.more.href).toMatch(/^(\/|https:\/\/)/);
    }
  });

  it("says what each one does in plain words: no em dash, nothing longer than a short paragraph", () => {
    for (const p of partners) {
      expect(p.how).not.toMatch(/—|–/);
      expect(p.how.length).toBeLessThanOrEqual(220);
      expect(p.role.split(" ").length).toBeLessThanOrEqual(3);
    }
  });

  it("describes HEY by what it does, not as a deal: they track and rate on their own terms", () => {
    const hey = partners.find((p) => p.name === "HEY Research Lab")!;
    expect(hey.how).not.toMatch(/partner|collab|sponsor/i);
    expect(hey.how).toMatch(/independent/i);
  });
});
