// Agents that build, phase 0: the seal a built page is shown under. What the frame may do, what the document may
// load, and that the policy is the first thing in it. scripts/seal-selftest.mjs proves the same in a real browser.
import { describe, it, expect } from "vitest";
import { seal, SEAL_FRAME, SEAL_HOLDER_POLICY, SEAL_POLICY, SEAL_SANDBOX } from "@/lib/siteSeal";

describe("the seal", () => {
  it("lets the frame run its own script and nothing else", () => {
    expect(SEAL_SANDBOX).toBe("allow-scripts");
    for (const never of ["allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation", "allow-modals", "allow-downloads", "allow-pointer-lock"]) expect(SEAL_SANDBOX).not.toContain(never);
    expect(SEAL_FRAME).toMatchObject({ sandbox: "allow-scripts", referrerPolicy: "no-referrer" });
  });

  it("lets the document load only what is inside it", () => {
    const rules = Object.fromEntries(SEAL_POLICY.split("; ").map((r) => [r.split(" ")[0], r.split(" ").slice(1).join(" ")]));
    expect(rules["default-src"]).toBe("'none'");
    expect(rules["connect-src"]).toBe("'none'");
    expect(rules["form-action"]).toBe("'none'");
    expect(rules["base-uri"]).toBe("'none'");
    expect(rules["frame-src"]).toBe("'none'");
    expect(rules["worker-src"]).toBe("'none'");
    expect(rules["object-src"]).toBe("'none'");
    expect(rules["script-src"]).toBe("'unsafe-inline'");
    expect(rules["img-src"]).toBe("data: blob:");
    // nothing over the network anywhere, and no way to run text as code
    expect(SEAL_POLICY).not.toMatch(/https?:|\*|'self'|unsafe-eval|wss?:/);
  });

  it("asks the page that holds the frame to let nothing be loaded into a frame, so a built page cannot send itself elsewhere", () => {
    expect(SEAL_HOLDER_POLICY).toBe("frame-src 'none'");
  });

  it("puts the policy first, before anything the agent wrote", () => {
    const out = seal("<!DOCTYPE html>\n<html><head><title>Tips</title></head><body><h1>Tips</h1></body></html>");
    expect(out.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${SEAL_POLICY}">`)).toBe(true);
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<html>"));
    expect(out.match(/<!doctype/gi)).toHaveLength(1);
    expect(out).toContain("<h1>Tips</h1>");
  });

  it("is first whatever the page begins with: a byte-order mark, spaces, no doctype, a script", () => {
    for (const html of ["﻿<!doctype html><p>a</p>", "   \n<!DocType HTML PUBLIC \"x\"><p>a</p>", "<p>a</p>", "<script>alert(1)</script><p>a</p>", ""]) {
      const out = seal(html);
      expect(out.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
      expect(out).not.toContain("﻿");
    }
    // a page's own policy tag cannot come before ours
    const sneaky = seal('<meta http-equiv="Content-Security-Policy" content="default-src *"><script src="https://evil.example/x.js"></script>');
    expect(sneaky.indexOf(SEAL_POLICY)).toBeLessThan(sneaky.indexOf("default-src *"));
  });
});
