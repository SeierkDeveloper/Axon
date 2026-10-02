// The gated fixer: every repair is applied on its own, proven by the type check
// and the test suite, and put back when the proof fails.
//
// Nothing here runs the real proof or the real npm. Both are injected, and every
// file lives in a temporary directory passed as the root, so a test that goes
// wrong cannot edit the repository it is testing.

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import {
  applyFixes,
  isInternalRoute,
  documentedPaths,
  apiRoutes,
  openApiEntry,
  removeSpecPath,
  addSpecEntries,
  routeSummary,
  routeMethods,
  relinkTarget,
} from "../../scripts/autonomy.mjs";

const roots: string[] = [];
function tempRoot(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "axon-fix-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const at = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const pass = () => ({ ok: true });
const fail = (reason = "the test suite failed: Tests  1 failed | 10 passed (11)") => () => ({ ok: false, reason });
const deExport = (file: string, symbol: string) => ({
  severity: "warn",
  what: "",
  why: "",
  where: [file],
  fix: { kind: "de-export", file, symbol },
});
const noNpm = () => {
  throw new Error("npm must not run in this test");
};

describe("the gate", () => {
  it("keeps a fix when the type check and the tests pass", () => {
    const root = tempRoot({ "src/lib/a.ts": "export function onlyHere() {}\nonlyHere();\n" });
    const prove = vi.fn(pass);
    const changes = applyFixes([{ findings: [deExport("src/lib/a.ts", "onlyHere")] }], { root, prove, npm: noNpm });
    expect(prove).toHaveBeenCalledTimes(1);
    expect(prove).toHaveBeenCalledWith(root);
    expect(changes).toEqual([
      { what: "dropped the export from onlyHere()", where: "src/lib/a.ts", files: ["src/lib/a.ts"], status: "applied" },
    ]);
    expect(at(root, "src/lib/a.ts")).toBe("function onlyHere() {}\nonlyHere();\n");
  });

  it("puts the file back exactly when the proof fails, and says why", () => {
    const before = "export async function onlyHere() {}\n";
    const root = tempRoot({ "src/lib/a.ts": before });
    const changes = applyFixes([{ findings: [deExport("src/lib/a.ts", "onlyHere")] }], { root, prove: fail(), npm: noNpm });
    expect(at(root, "src/lib/a.ts")).toBe(before);
    expect(changes).toHaveLength(1);
    expect(changes[0].status).toBe("reverted");
    expect(changes[0].what).toBe("tried to drop the export from onlyHere(), put it back");
    expect(changes[0].reason).toContain("the test suite failed");
  });

  it("proves each fix on its own, so one bad fix cannot sink the others", () => {
    const root = tempRoot({ "src/lib/a.ts": "export function first() {}\n", "src/lib/b.ts": "export function second() {}\n" });
    // fails the first proof, passes the second
    const prove = vi.fn().mockReturnValueOnce({ ok: false, reason: "the type check failed: error TS2304" }).mockReturnValueOnce({ ok: true });
    const changes = applyFixes(
      [{ findings: [deExport("src/lib/a.ts", "first"), deExport("src/lib/b.ts", "second")] }],
      { root, prove, npm: noNpm },
    );
    expect(prove).toHaveBeenCalledTimes(2);
    expect(changes.map((c) => c.status)).toEqual(["reverted", "applied"]);
    expect(at(root, "src/lib/a.ts")).toBe("export function first() {}\n");
    expect(at(root, "src/lib/b.ts")).toBe("function second() {}\n");
  });

  it("does not run the proof for a stale finding, or under --dry", () => {
    const root = tempRoot({ "src/lib/a.ts": "function already() {}\n" });
    const prove = vi.fn(pass);
    expect(applyFixes([{ findings: [deExport("src/lib/a.ts", "already")] }], { root, prove, npm: noNpm })).toEqual([]);
    const root2 = tempRoot({ "src/lib/a.ts": "export function later() {}\n" });
    const would = applyFixes([{ findings: [deExport("src/lib/a.ts", "later")] }], { root: root2, prove, npm: noNpm, write: false });
    expect(would).toEqual([{ what: "would drop the export from later()", where: "src/lib/a.ts" }]);
    expect(at(root2, "src/lib/a.ts")).toBe("export function later() {}\n");
    expect(prove).not.toHaveBeenCalled();
  });
});

describe("package fixes", () => {
  const pkg = (deps: Record<string, string>) => `${JSON.stringify({ name: "x", dependencies: deps }, null, 2)}\n`;
  const lock = (deps: Record<string, string>) =>
    `${JSON.stringify({ lockfileVersion: 3, packages: Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }])) }, null, 2)}\n`;

  /** A stand-in npm that edits the files the way the real one would, and records every call. */
  function fakeNpm(root: string) {
    const calls: string[][] = [];
    const npm = (args: string[], cwd: string) => {
      expect(cwd).toBe(root);
      calls.push(args);
      if (args[0] === "uninstall") {
        const p = JSON.parse(at(root, "package.json"));
        delete p.dependencies[args[1]];
        writeFileSync(join(root, "package.json"), `${JSON.stringify(p, null, 2)}\n`);
        const l = JSON.parse(at(root, "package-lock.json"));
        delete l.packages[`node_modules/${args[1]}`];
        writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(l, null, 2)}\n`);
      }
      if (args[0] === "audit") {
        const l = JSON.parse(at(root, "package-lock.json"));
        l.packages["node_modules/holey"].version = "1.0.9";
        writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(l, null, 2)}\n`);
      }
      return "";
    };
    return { npm, calls };
  }
  const unused = (name: string) => ({ severity: "warn", what: "", why: "", where: ["package.json"], fix: { kind: "uninstall", package: name } });
  const audit = { severity: "warn", what: "", why: "", where: ["package-lock.json"], fix: { kind: "audit-fix" } };

  it("uninstalls an unused package and keeps it when the proof passes", () => {
    const root = tempRoot({ "package.json": pkg({ used: "1.0.0", idle: "2.0.0" }), "package-lock.json": lock({ used: "1.0.0", idle: "2.0.0" }) });
    const { npm, calls } = fakeNpm(root);
    const changes = applyFixes([{ findings: [unused("idle")] }], { root, prove: pass, npm });
    expect(calls).toEqual([["uninstall", "idle", "--no-audit", "--no-fund"]]);
    expect(changes[0]).toMatchObject({ status: "applied", what: "removed the unused package idle", files: ["package.json", "package-lock.json"] });
    expect(JSON.parse(at(root, "package.json")).dependencies).toEqual({ used: "1.0.0" });
  });

  it("restores package.json and the lockfile and re-installs when the proof fails", () => {
    const beforePkg = pkg({ used: "1.0.0", idle: "2.0.0" });
    const beforeLock = lock({ used: "1.0.0", idle: "2.0.0" });
    const root = tempRoot({ "package.json": beforePkg, "package-lock.json": beforeLock });
    const { npm, calls } = fakeNpm(root);
    const changes = applyFixes([{ findings: [unused("idle")] }], { root, prove: fail("the type check failed: error TS2307: Cannot find module 'idle'"), npm });
    expect(at(root, "package.json")).toBe(beforePkg);
    expect(at(root, "package-lock.json")).toBe(beforeLock);
    // node_modules is brought back in line with the restored files
    expect(calls).toEqual([["uninstall", "idle", "--no-audit", "--no-fund"], ["install", "--no-audit", "--no-fund"]]);
    expect(changes[0]).toMatchObject({ status: "reverted", reason: "the type check failed: error TS2307: Cannot find module 'idle'" });
  });

  it("skips a package that is no longer installed", () => {
    const root = tempRoot({ "package.json": pkg({ used: "1.0.0" }), "package-lock.json": lock({ used: "1.0.0" }) });
    const { npm, calls } = fakeNpm(root);
    expect(applyFixes([{ findings: [unused("gone")] }], { root, prove: pass, npm })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("runs npm audit fix on the lockfile without --force, then syncs node_modules", () => {
    const root = tempRoot({ "package.json": pkg({ holey: "^1.0.0" }), "package-lock.json": lock({ holey: "1.0.1" }) });
    const { npm, calls } = fakeNpm(root);
    const changes = applyFixes([{ findings: [audit] }], { root, prove: pass, npm });
    expect(calls[0]).toEqual(["audit", "fix", "--omit=dev", "--package-lock-only", "--no-fund"]);
    expect(calls.flat()).not.toContain("--force");
    expect(calls[1]).toEqual(["install", "--no-audit", "--no-fund"]);
    expect(changes[0]).toMatchObject({ status: "applied" });
    expect(changes[0].what).toContain("updated 1 locked package to patched versions");
  });

  it("records nothing and proves nothing when audit fix changes nothing", () => {
    const root = tempRoot({ "package.json": pkg({ fine: "^1.0.0" }), "package-lock.json": lock({ fine: "1.0.0" }) });
    const calls: string[][] = [];
    const prove = vi.fn(pass);
    const changes = applyFixes([{ findings: [audit] }], { root, prove, npm: (args: string[]) => { calls.push(args); return ""; } });
    expect(changes).toEqual([]);
    expect(prove).not.toHaveBeenCalled();
    expect(calls).toEqual([["audit", "fix", "--omit=dev", "--package-lock-only", "--no-fund"]]);
  });
});

describe("API reference fixes", () => {
  const SPEC = "src/app/api/openapi/route.ts";
  const spec = [
    "const SPEC = {",
    '  openapi: "3.1.0",',
    "  paths: {",
    '    "/agents": {',
    '      get: { summary: "List agents" },',
    "    },",
    "",
    '    "/gone/{id}": {',
    '      parameters: [{ name: "id", in: "path", required: true }],',
    "      get: {",
    '        summary: "Nothing serves this any more",',
    "      },",
    "    },",
    "  },",
    "};",
    "",
  ].join("\n");
  const widgetRoute = [
    'import { NextResponse } from "next/server";',
    "",
    "// GET /api/widgets/[widgetId] — one widget, as stored.",
    "export async function GET() {",
    "  return NextResponse.json({});",
    "}",
    "",
    "// DELETE /api/widgets/[widgetId] — remove a widget you own.",
    "export async function DELETE(req: Request) {",
    "  const auth = requireApiKey(req);",
    "  return NextResponse.json({ auth });",
    "}",
    "",
  ].join("\n");
  const plainRoute = "export async function GET() {\n  return new Response(\"ok\");\n}\n";

  it("removes a path no route serves, and adds an entry for an undocumented public route", () => {
    const root = tempRoot({
      [SPEC]: spec,
      "src/app/api/widgets/[widgetId]/route.ts": widgetRoute,
      "src/app/api/world/epoch/route.ts": plainRoute,
      "src/app/api/cron/burn/route.ts": plainRoute,
    });
    const findings = [
      { severity: "error", what: "", why: "", where: [SPEC], fix: { kind: "api-reference-remove", path: "/gone/{id}" } },
      // internal routes passed in on purpose: the fixer must refuse them whatever the finding says
      { severity: "warn", what: "", why: "", where: [SPEC], fix: { kind: "api-reference-add", routes: ["/widgets/[widgetId]", "/world/epoch", "/cron/burn"] } },
    ];
    const changes = applyFixes([{ findings }], { root, prove: pass, npm: noNpm });
    expect(changes.map((c) => c.status)).toEqual(["applied", "applied"]);
    expect(changes[1].what).toBe("added 1 public route to the API reference, written from their route files");

    const out = at(root, SPEC);
    expect(documentedPaths(out)).toEqual(["/agents", "/widgets/{widgetId}"]);
    expect(out).not.toContain("Nothing serves this");
    expect(out).toContain('parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "string" } }],');
    // read from the route's own comments, the dash turned into plain punctuation
    expect(out).toContain('get: { summary: "One widget, as stored", tags: ["Widgets"], security: [] },');
    // the handler that asks for a key inherits the spec's default instead of claiming to be open
    expect(out).toContain('delete: { summary: "Remove a widget you own", tags: ["Widgets"] },');
    expect(out).not.toMatch(/world|cron/);
    expect(out).not.toContain("—");
    // still a well-formed object literal
    expect(() => new Function(`${out.replace("const SPEC =", "return")}`)()).not.toThrow();
  });

  it("puts the reference back when the proof fails", () => {
    const root = tempRoot({ [SPEC]: spec, "src/app/api/widgets/[widgetId]/route.ts": widgetRoute });
    const changes = applyFixes(
      [{ findings: [{ severity: "warn", what: "", why: "", where: [SPEC], fix: { kind: "api-reference-add", routes: ["/widgets/[widgetId]"] } }] }],
      { root, prove: fail(), npm: noNpm },
    );
    expect(changes[0].status).toBe("reverted");
    expect(at(root, SPEC)).toBe(spec);
  });

  it("removes exactly one entry and leaves its neighbours whole", () => {
    const out = removeSpecPath(spec, "/gone/{id}")!;
    expect(out).toContain('"/agents": {\n      get: { summary: "List agents" },\n    },\n  },\n};');
    expect(removeSpecPath(spec, "/not-there")).toBeNull();
    expect(addSpecEntries(spec, [])).toBeNull();
  });

  it("writes only the methods a route exports, and never an operator-gated one", () => {
    expect(routeMethods('export { POST } from "../verify/route";\n')).toEqual(["POST"]);
    expect(routeMethods("export const GET = handler;\nexport async function DELETE() {}\n")).toEqual(["GET", "DELETE"]);
    const reproduce = "export async function GET() {}\nexport async function POST() {}\n";
    const entry = openApiEntry("/receipts/[taskId]/reproduce", reproduce)!;
    expect(entry).toContain("get:");
    expect(entry).not.toContain("post:");
  });

  it("leaves the summary out rather than guessing one", () => {
    expect(routeSummary("export async function GET() {}\n", "GET", { single: true })).toBeNull();
    expect(routeSummary("// Body: { task: string }\nexport async function POST() {}\n", "POST", { single: true })).toBeNull();
  });
});

describe("internal routes never reach the public reference", () => {
  it("names every operational, demo and UI-only family as internal", () => {
    for (const r of [
      "/cron/burn", "/cron/demo-activity", "/admin/autonomy", "/worker-metrics", "/seed/daily", "/debug/x", "/demo/x",
      "/network-activity", "/network-feed", "/telegram/hook", "/og/agent", "/metrics", "/failures", "/analytics",
      "/burn", "/burn/history", "/auth/me", "/auth/verify", "/tier", "/handles", "/agent-launch/[agentId]",
      "/launches/[token]/request", "/agents/[agentId]/test", "/grow/setup", "/build", "/world/epoch", "/openapi",
    ]) {
      expect(isInternalRoute(r), r).toBe(true);
    }
  });

  it("leaves developer routes public", () => {
    for (const r of ["/agents", "/agents/[agentId]/reputation", "/tasks/[taskId]/complete", "/auth/keys", "/mcp/servers", "/tools/call"]) {
      expect(isInternalRoute(r), r).toBe(false);
    }
  });

  it("holds for the live reference: nothing it documents is internal", () => {
    const documented = documentedPaths(readFileSync(join(process.cwd(), "src/app/api/openapi/route.ts"), "utf8"));
    expect(documented.length).toBeGreaterThan(0);
    const leaked = documented.filter((d: string) => isInternalRoute(d.replace(/\{([^}]+)\}/g, "[$1]")));
    expect(leaked).toEqual([]);
    // and every internal pattern still matches a route that exists, or it is a stale exemption
    expect(apiRoutes().some((r: string) => isInternalRoute(r))).toBe(true);
  });
});

describe("relinking", () => {
  it("rewrites only when exactly one page can be meant", () => {
    expect(relinkTarget("/guides/autonomy", ["/autonomy", "/docs"])).toBe("/autonomy");
    expect(relinkTarget("/old/sdk", ["/docs/sdk", "/learn/sdk"])).toBeNull();
    expect(relinkTarget("/nowhere", ["/docs"])).toBeNull();
  });

  it("applies the rewrite through the gate", () => {
    const root = tempRoot({ "src/components/Nav.tsx": '<a href="/guides/autonomy">a</a> <a href="/guides/autonomy/">b</a>\n' });
    const changes = applyFixes(
      [{ findings: [{ severity: "error", what: "", why: "", where: [], fix: { kind: "relink", from: "/guides/autonomy", to: "/autonomy", files: ["src/components/Nav.tsx"] } }] }],
      { root, prove: pass, npm: noNpm },
    );
    expect(changes[0]).toMatchObject({ status: "applied", what: "pointed links to /guides/autonomy at /autonomy" });
    expect(at(root, "src/components/Nav.tsx")).toBe('<a href="/autonomy">a</a> <a href="/autonomy">b</a>\n');
    expect(existsSync(join(root, "src/components/Nav.tsx"))).toBe(true);
  });
});
