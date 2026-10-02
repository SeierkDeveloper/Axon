// Axon's maintenance pass over itself.
//
//   node scripts/autonomy.mjs            # check, write the log
//   node scripts/autonomy.mjs --dry      # check and print, touch nothing
//   node scripts/autonomy.mjs --fix      # check, then repair what it can, each repair proven
//   node scripts/autonomy.mjs --only=links
//
// Each check answers one question about whether the project still tells the
// truth about itself, and every run is appended to autonomy/history.jsonl and
// committed. The log lives in git on purpose: a claim that the project maintains
// itself is only worth anything if you can diff it, so the receipt for a run is
// a commit rather than a number on a dashboard.
//
// Two tiers. Without --fix the pass only reports, and every run records
// `changed: false`. With --fix it also repairs: dropping `export` from a
// function only its own file uses, pointing a link at the one page it can only
// have meant, bringing the API reference in line with the public routes,
// uninstalling a shipped package nothing imports, and `npm audit fix` without
// --force. The SDK, example and migration checks only ever report.
//
// The line between them matters. The moment a pass writes code, "it found
// nothing" and "it broke nothing" stop being the same statement. So every fix
// is applied to the working tree on its own and then proven: the type check
// (`tsc --noEmit`) and the full test suite (`vitest run`) must both pass, or that
// one fix is put back and recorded as tried and reverted, with the reason. The
// thing making the change is not the thing certifying it. The deploy script
// (scripts/deploy-local.sh) runs this with --fix and commits the kept repairs
// in a commit of their own, ahead of the log. Nothing opens a pull request.

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { join, resolve, relative } from "path";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LOG_DIR = join(ROOT, "autonomy");
const DRY = process.argv.includes("--dry");
const FIX = process.argv.includes("--fix");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

// ── file walking ─────────────────────────────────────────────────────────────
const SKIP = new Set(["node_modules", ".next", ".git", ".claude", "dist", "coverage"]);
// Skipped by path, not by name. Excluding every directory called "autonomy"
// also hid src/app/autonomy from the route scan, so the link check reported the
// page it was written to serve as missing — which is how this pass found it.
const SKIP_PATHS = new Set([join(ROOT, "autonomy")]);
function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (SKIP_PATHS.has(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, "utf8");

/**
 * Every npm package named by an install command in `text`.
 *
 * Fiddlier than it looks, and wrong twice before it was right. One command names
 * several packages, so taking only the first left a typo in any but the head
 * unchecked. Widening it then over-reached in two ways at once: `\s` spans
 * newlines, so the match ran past the command into the prose beneath it, and
 * nothing stopped at `#`, so shell comments became package names. Between them
 * they reported "Run", "Score" and "TypeScript" as missing packages — a check
 * that cries wolf like that gets muted, and a muted check is worse than none.
 */
export function npmPackagesIn(text) {
  const out = [];
  // `[^\S\r\n]` is whitespace that is not a newline: stay on this line.
  for (const m of text.matchAll(/npm (?:install|i)((?:[^\S\r\n]+[^\s`'"&|;]+)+)/g)) {
    for (const raw of m[1].trim().split(/[^\S\r\n]+/)) {
      // A shell comment or continuation ends the package list.
      if (raw.startsWith("#") || /^(&&|\|\||;)/.test(raw)) break;
      if (raw.startsWith("-")) continue;                        // a flag
      if (raw.startsWith(".") || raw.startsWith("/")) continue;  // a path
      if (/^[a-z+]+:/.test(raw) || raw.includes("+")) continue;  // a URL
      const name = raw.startsWith("@")
        ? raw.split("@").slice(0, 2).join("@").replace(/^@@/, "@") // @scope/name from @scope/name@1.2.3
        : raw.split("@")[0];
      if (!name || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) continue;
      out.push(name);
    }
  }
  return out;
}

/**
 * Every PyPI package named by an install command in `text`.
 *
 * The same shape as `npmPackagesIn`, and it had the same two faults for the same
 * reason — it was written first and never revisited when the npm side was fixed.
 * It took only the head of `pip install requests numpy pandas`, and its leading
 * `\s+` crossed newlines, so `pip install` at the end of a block captured the
 * first word of the next paragraph. It would also have asked PyPI whether "#"
 * exists, given `pip install   # Install dependencies`.
 */
export function pipPackagesIn(text) {
  const out = [];
  // Quotes are part of a token here, not a boundary: the documented extras form
  // is `pip install "axonsdk[signing] @ git+…"`, and excluding `"` from the
  // token meant that line matched nothing and went unchecked.
  for (const m of text.matchAll(/pip install((?:[^\S\r\n]+[^\s`&|;]+)+)/g)) {
    const toks = m[1].trim().split(/[^\S\r\n]+/);
    // PEP 508 direct reference: `name[extra] @ git+https://...` installs from the
    // URL, not from PyPI, so the registry has nothing to say about it. Checking
    // anyway reported Axon's own documented from-source line as a missing
    // package, which is the check being wrong rather than the docs.
    if (toks.some((tk, i) => tk === "@" && /^[a-z+]+:|\+/.test(toks[i + 1] ?? ""))) continue;
    for (const raw of toks) {
      if (raw.startsWith("#") || /^(&&|\|\||;)/.test(raw)) break;
      if (raw.startsWith("-")) continue;                        // -r, -e take a path
      if (raw.startsWith(".") || raw.startsWith("/")) continue;  // a path
      if (/^[a-z+]+:/.test(raw) || raw.includes("+")) continue;  // a VCS URL
      // "axonsdk[signing]" and the PEP 508 form both name the package first.
      const name = raw.replace(/^["']+/, "").replace(/["']+$/, "").split("[")[0];
      if (!name || !/^[A-Za-z][\w.-]*$/.test(name)) continue;
      out.push(name);
    }
  }
  return out;
}

// ── check: every install command in the docs actually resolves ───────────────
// The repo told people to `npm install @axon/sdk` for months. That package does
// not exist — the real name is @axonprotocol/sdk — and it sat on the front page
// of the repo until somebody happened to read it. A machine should have caught
// that the day it was written.
export async function checkInstallCommands() {
  const files = [...walk(join(ROOT, "src", "app"), [".tsx", ".ts"]), ...walk(ROOT, [".md"])];
  const found = new Map(); // "npm:name" | "pypi:name" -> Set(files)

  for (const f of files) {
    const body = read(f);
    // Every package on the line, not just the first. One install command
    // routinely names several — `npm install @axonprotocol/sdk @solana/web3.js
    // @solana/spl-token` is the documented line for paying on-chain — and
    // capturing only the head meant a typo in any package but the first was
    // never checked at all.
    for (const name of npmPackagesIn(body)) {
      found.set(`npm:${name}`, (found.get(`npm:${name}`) ?? new Set()).add(rel(f)));
    }
    for (const m of body.matchAll(/npx (?:--yes )?((?:@[\w.-]+\/)?[\w.-]+)/g)) {
      found.set(`npm:${m[1]}`, (found.get(`npm:${m[1]}`) ?? new Set()).add(rel(f)));
    }
    for (const name of pipPackagesIn(body)) {
      found.set(`pypi:${name}`, (found.get(`pypi:${name}`) ?? new Set()).add(rel(f)));
    }
  }

  // Packages this repo publishes are checked against the registry too — being
  // the author is not evidence that a release actually went out.
  //
  // "Missing" and "could not ask" are different answers and must not collapse.
  // npm returns E404 for a package that is not there and something else entirely
  // when the registry is unreachable; treating both as missing would file a false
  // error — and, through the workflow, open an issue claiming the docs are wrong
  // — every time a runner had a bad minute. A check that cries wolf on a network
  // blip is one people stop reading.
  const findings = [];
  let unverified = 0;
  // A registry that is down is down for every lookup, and each one costs its
  // whole timeout: measured against a dead registry this check took 240s instead
  // of 9, which in CI is a job that gets killed rather than a result. After two
  // consecutive failures, stop asking that registry and mark the rest unverified.
  const OUT_OF_REACH = 2;
  const consecutive = { npm: 0, pypi: 0 };
  for (const [key, where] of [...found].sort()) {
    const [registry, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (consecutive[registry] >= OUT_OF_REACH) {
      unverified++;
      continue;
    }
    let state; // "present" | "missing" | "unknown"
    if (registry === "npm") {
      try {
        execFileSync("npm", ["view", name, "version"], { encoding: "utf8", stdio: "pipe", timeout: 15000 });
        state = "present";
      } catch (err) {
        const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        state = /E404|404 Not Found/.test(out) ? "missing" : "unknown";
      }
    } else {
      try {
        const res = await fetch(`https://pypi.org/pypi/${name}/json`, { signal: AbortSignal.timeout(15000) });
        state = res.ok ? "present" : res.status === 404 ? "missing" : "unknown";
      } catch {
        state = "unknown";
      }
    }

    if (state === "unknown") {
      consecutive[registry] += 1;
      unverified++;
      continue;
    }
    consecutive[registry] = 0;
    if (state === "missing") {
      findings.push({
        severity: "error",
        what: `${registry === "npm" ? "npm" : "PyPI"} package "${name}" does not resolve`,
        why: "the docs tell people to install something that isn't published under that name",
        where: [...where].sort(),
      });
    }
  }
  // Said out loud rather than swallowed: a pass that could not reach a registry
  // proves less than one that could, and the log should show the difference.
  if (unverified > 0) {
    findings.push({
      severity: "warn",
      what: `${unverified} package${unverified === 1 ? "" : "s"} could not be checked`,
      why: "the registry was unreachable, so this pass proves less than a clean one",
      where: [],
    });
  }
  return { checked: found.size, findings };
}

// ── check: internal links point at pages that exist ──────────────────────────
// Docs rot quietly. A link to a page that was renamed still looks like a link.
export function checkInternalLinks() {
  // Both page.tsx and route.ts serve a path — /mcp is a route handler, and a
  // link to it is not broken just because it renders no page.
  const routes = new Set(
    walk(join(ROOT, "src", "app"), ["page.tsx", "route.ts"]).map((p) =>
      rel(p).replace(/^src\/app/, "").replace(/\/(page\.tsx|route\.ts)$/, "") || "/",
    ),
  );
  // Dynamic segments match anything in that position.
  const dynamic = [...routes].filter((r) => r.includes("["));
  const matches = (href) => {
    if (routes.has(href)) return true;
    const parts = href.split("/");
    return dynamic.some((r) => {
      const rp = r.split("/");
      return rp.length === parts.length && rp.every((seg, i) => seg.startsWith("[") || seg === parts[i]);
    });
  };

  // Links live in components as well as pages, and the ones in components are
  // the most-clicked on the site: the nav and the footer sit in SiteNav, which a
  // scan of src/app alone never opens. Test files are excluded — an href in a
  // fixture is a string, not a link somebody can follow.
  const files = [
    ...walk(join(ROOT, "src", "app"), [".tsx"]),
    ...walk(join(ROOT, "src", "components"), [".tsx"]),
  ].filter((f) => !rel(f).includes("__tests__"));
  const findings = [];
  let checked = 0;
  for (const f of files) {
    for (const m of read(f).matchAll(/href="(\/[^"#?]*)"/g)) {
      const href = m[1].replace(/\/$/, "") || "/";
      // Route handlers and static assets aren't pages.
      if (href.startsWith("/api/") || /\.[a-z0-9]{2,4}$/i.test(href)) continue;
      checked++;
      if (!matches(href)) {
        findings.push({
          severity: "error",
          what: `link to ${href} has no page`,
          why: "a reader following it gets a 404",
          where: [rel(f)],
        });
      }
    }
  }
  // Same link from many files is one problem, not twenty.
  const merged = new Map();
  for (const f of findings) {
    const prev = merged.get(f.what);
    if (prev) prev.where = [...new Set([...prev.where, ...f.where])].sort();
    else merged.set(f.what, f);
  }
  // A link is repaired only when exactly one page could be what it meant: a page
  // whose last segment is the broken link's last segment (a page that moved).
  // Two candidates, or none, and the finding stays a report for a person.
  const pages = [...routes].filter((r) => !r.includes("[") && !r.startsWith("/api"));
  for (const f of merged.values()) {
    const href = f.what.match(/^link to (\S+) has no page$/)?.[1];
    const target = href && relinkTarget(href, pages);
    if (target) f.fix = { kind: "relink", from: href, to: target, files: f.where };
  }
  return { checked, findings: [...merged.values()] };
}

/** The one page `href` must have meant, or null when it is not exactly one. */
export function relinkTarget(href, pages) {
  const last = href.split("/").pop();
  if (!last) return null;
  const candidates = pages.filter((p) => p !== href && p.split("/").pop() === last);
  return candidates.length === 1 ? candidates[0] : null;
}

// ── check: exports nothing imports ───────────────────────────────────────────
// Dead exports are the residue of features that moved. They cost nothing to run
// and everything to read, because the next person cannot tell them from the
// code that matters.
/**
 * Source with comments and quoted text removed, one line at a time.
 *
 * Doing it over the whole file seems tidier and is a trap: a single unbalanced
 * quote — an apostrophe in prose, a backtick in a template — makes one match span
 * the rest of the file and silently deletes real code. Measured on
 * commerce.test.ts, whole-file stripping took three genuine uses of toMinor down
 * to zero and would have reported a live function as dead. A line cannot swallow
 * its neighbours.
 */
export const codeOf = (src) =>
  src
    .split("\n")
    .map((line) =>
      line
        .replace(/\/\/.*$/, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/"[^"]*"/g, " ")
        .replace(/'[^']*'/g, " "),
    )
    .join("\n");

export function checkDeadExports() {
  const libFiles = walk(join(ROOT, "src", "lib"), [".ts"]).filter((f) => !f.endsWith(".test.ts"));
  const all = [...walk(join(ROOT, "src"), [".ts", ".tsx"]), ...walk(join(ROOT, "scripts"), [".mjs", ".ts"])];

  const stripped = new Map(all.map((f) => [f, codeOf(read(f))]));

  const findings = [];
  let checked = 0;
  for (const f of libFiles) {
    for (const m of read(f).matchAll(/^export (?:async )?function ([A-Za-z_]\w*)/gm)) {
      const name = m[1];
      // A leading underscore is this codebase's mark for a deliberate test hook.
      if (name.startsWith("_")) continue;
      checked++;
      const word = new RegExp(`\\b${name}\\b`);
      const usedElsewhere = all.some((other) => other !== f && word.test(stripped.get(other)));
      if (usedElsewhere) continue;

      // Used inside its own file is a different problem from used nowhere: the
      // first is an export that should not be one, the second is dead code.
      const own = stripped.get(f) ?? "";
      const timesHere = (own.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
      findings.push(
        timesHere > 1
          ? {
              severity: "warn",
              what: `${name}() is exported but only used inside its own file`,
              why: "the export widens the surface without a caller to justify it",
              where: [rel(f)],
              // Safe to apply: dropping `export` from a symbol nothing outside
              // the file references is a change the compiler can prove.
              fix: { kind: "de-export", file: rel(f), symbol: name },
            }
          : {
              severity: "warn",
              what: `${name}() is exported and never used`,
              why: "dead code reads exactly like live code",
              where: [rel(f)],
            },
      );
    }
  }
  return { checked, findings };
}

// ── applying fixes, each one proven ──────────────────────────────────────────
// A fix is a group: the files it may touch, how to make the edit, and how to say
// what it did. Groups go one at a time. Each is applied to the working tree, then
// the type check and the whole test suite run; if either fails, exactly that
// group's files are put back (and node_modules re-synced when it changed
// packages) and the attempt is recorded as tried and reverted. One bad fix costs
// its own edit, never the others.
//
// Every planner re-reads what it is about to change and gives up when the
// finding no longer matches the file, so a stale finding cannot rewrite the
// wrong line.

const PKG_FILES = ["package.json", "package-lock.json"];

/** Run npm in `root`. Returns its output; throws on a non-zero exit, like execFileSync. */
function runNpm(args, root) {
  return execFileSync("npm", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
}

/** The first line of a failed command's output that says what went wrong. */
function firstClue(out) {
  const lines = String(out ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /error TS\d+/.test(l)) ?? lines.find((l) => /^Tests?\s+.*\bfailed\b/.test(l)) ?? lines.find((l) => /\bfailed\b|^FAIL\b|Error:/.test(l)) ?? lines[lines.length - 1] ?? "no output";
  return hit.replace(/[\u2014\u2013]/g, "-").slice(0, 200);
}

/**
 * The proof a fix has to pass: the type check, then the full test suite.
 *
 * Telegram is blanked for the run: the suite runs on whatever machine deploys,
 * and a laptop with the live token in its environment must never post from a
 * test.
 */
export function runProof(root = ROOT) {
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: "", CI: "1" };
  const steps = [
    { name: "the type check", args: ["tsc", "--noEmit"] },
    { name: "the test suite", args: ["vitest", "run"] },
  ];
  for (const step of steps) {
    try {
      execFileSync("npx", step.args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30 * 60_000, maxBuffer: 256 * 1024 * 1024 });
    } catch (err) {
      return { ok: false, reason: `${step.name} failed: ${firstClue(`${err.stdout ?? ""}\n${err.stderr ?? ""}` || err.message)}` };
    }
  }
  return { ok: true };
}

/** How many entries in a lockfile changed version between two copies of it. */
function lockChanges(before, after) {
  try {
    const a = JSON.parse(before).packages ?? {};
    const b = JSON.parse(after).packages ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((k) => k && a[k]?.version !== b[k]?.version).length;
  } catch {
    return 0;
  }
}

/**
 * Each fix kind: from a finding's `fix`, a plan (or null when the finding has
 * gone stale). A plan names the files it may touch, says what it will do and
 * what it did, and `apply` makes the edit, returning whether anything changed.
 */
const PLANNERS = {
  // dropping `export` from a function only its own file uses
  "de-export": (fix, { root }) => {
    const path = join(root, fix.file);
    let before;
    try { before = read(path); } catch { return null; }
    const decl = new RegExp(`^export (async )?function ${fix.symbol}\\b`, "m");
    if (!decl.test(before)) return null; // the file moved on; leave it to the next pass
    return {
      files: [fix.file],
      where: fix.file,
      verb: `drop the export from ${fix.symbol}()`,
      done: `dropped the export from ${fix.symbol}()`,
      apply: () => {
        const after = before.replace(decl, (_m, isAsync) => `${isAsync ?? ""}function ${fix.symbol}`);
        if (after === before) return false;
        writeFileSync(path, after);
        return true;
      },
    };
  },

  // a link to a page that moved, pointed at the one page it can only have meant
  relink: (fix, { root }) => {
    const from = new RegExp(`href="${fix.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?"`, "g");
    const files = fix.files.filter((f) => { try { return from.test(read(join(root, f))); } catch { return false; } finally { from.lastIndex = 0; } });
    if (!files.length) return null;
    return {
      files,
      where: files.join(", "),
      verb: `point links to ${fix.from} at ${fix.to}`,
      done: `pointed links to ${fix.from} at ${fix.to}`,
      apply: () => {
        for (const f of files) writeFileSync(join(root, f), read(join(root, f)).replace(from, `href="${fix.to}"`));
        return true;
      },
    };
  },

  // a path in the reference that no route serves
  "api-reference-remove": (fix, { root }) => {
    const path = join(root, SPEC_FILE);
    const after = removeSpecPath(read(path), fix.path);
    if (after == null) return null;
    return {
      files: [SPEC_FILE],
      where: SPEC_FILE,
      verb: `remove /api${fix.path} from the API reference`,
      done: `removed /api${fix.path} from the API reference, since no route serves it`,
      apply: () => { writeFileSync(path, after); return true; },
    };
  },

  // public routes the reference does not list, each written from its route file
  "api-reference-add": (fix, { root }) => {
    const path = join(root, SPEC_FILE);
    const spec = read(path);
    // Re-asked, not trusted: the finding may be stale, and an internal route
    // must never reach the public reference whatever a finding says.
    const still = undocumentedRoutes(documentedPaths(spec), fix.routes).filter((r) => !isInternalRoute(r));
    const entries = [];
    for (const r of still) {
      let src;
      try { src = read(join(root, "src", "app", "api", r, "route.ts")); } catch { continue; }
      const entry = openApiEntry(r, src);
      if (entry) entries.push(entry);
    }
    const after = addSpecEntries(spec, entries);
    if (after == null) return null;
    const n = entries.length;
    return {
      files: [SPEC_FILE],
      where: SPEC_FILE,
      verb: `add ${n} public route${n === 1 ? "" : "s"} to the API reference`,
      done: `added ${n} public route${n === 1 ? "" : "s"} to the API reference, written from their route files`,
      apply: () => { writeFileSync(path, after); return true; },
    };
  },

  // a shipped package nothing imports
  uninstall: (fix, { root, npm }) => {
    let pkg;
    try { pkg = JSON.parse(read(join(root, "package.json"))); } catch { return null; }
    if (!pkg.dependencies?.[fix.package]) return null;
    return {
      files: PKG_FILES,
      packages: true,
      where: "package.json",
      verb: `remove the unused package ${fix.package}`,
      done: `removed the unused package ${fix.package}`,
      apply: () => { npm(["uninstall", fix.package, "--no-audit", "--no-fund"], root); return true; },
    };
  },

  // known holes in shipped packages, patched within the ranges already allowed
  "audit-fix": (_fix, { root, npm }) => {
    const lockPath = join(root, "package-lock.json");
    let before;
    try { before = read(lockPath); } catch { return null; }
    let n = 0;
    return {
      files: PKG_FILES,
      packages: true,
      where: "package-lock.json",
      verb: "patch known holes in shipped packages with npm audit fix",
      get done() { return `updated ${n} locked package${n === 1 ? "" : "s"} to patched versions with npm audit fix (no major-version bumps)`; },
      apply: () => {
        // Never --force: that is the flag that takes a major version, and a major
        // version is a decision, not a repair. The lockfile is fixed first and
        // node_modules brought to match it after, because `audit fix --omit=dev`
        // on node_modules itself also strips the dev tools the proof runs on.
        try {
          npm(["audit", "fix", "--omit=dev", "--package-lock-only", "--no-fund"], root);
        } catch {
          /* exits non-zero while holes remain that it could not fix; the lockfile says what it did */
        }
        const after = read(lockPath);
        n = lockChanges(before, after);
        if (after === before) return false;
        npm(["install", "--no-audit", "--no-fund"], root);
        return true;
      },
    };
  },
};

/** The current contents of `files` under `root`, null for one that does not exist. */
function snapshot(files, root) {
  return files.map((f) => {
    try { return [f, readFileSync(join(root, f), "utf8")]; } catch { return [f, null]; }
  });
}

/** Put `files` back exactly as `snapshot` found them. */
function restore(snap, root) {
  for (const [f, body] of snap) {
    if (body == null) rmSync(join(root, f), { force: true });
    else writeFileSync(join(root, f), body);
  }
}

/**
 * Apply every fix the findings carry, one group at a time, keeping only what
 * passes the proof.
 *
 * `write: false` plans and reports without touching anything, so --dry means
 * what it says even alongside --fix: a flag that promises to touch nothing and
 * then edits source is worse than no flag. `prove`, `npm` and `root` exist so the
 * gate can be tested without running the real suite or the real npm.
 *
 * Returns one change per group tried: `status` is "applied" when the proof
 * passed and the edit was kept, "reverted" (with `reason`) when it was put back.
 */
export function applyFixes(results, { write = true, prove = runProof, npm = runNpm, root = ROOT, log = () => {} } = {}) {
  const changes = [];
  for (const f of results.flatMap((r) => r.findings)) {
    const planner = f.fix && PLANNERS[f.fix.kind];
    if (!planner) continue;
    const plan = planner(f.fix, { root, npm });
    if (!plan) continue;
    if (!write) {
      changes.push({ what: `would ${plan.verb}`, where: plan.where });
      continue;
    }
    log(`      trying: ${plan.verb}`);
    const snap = snapshot(plan.files, root);
    const putBack = () => {
      restore(snap, root);
      if (plan.packages) {
        try { npm(["install", "--no-audit", "--no-fund"], root); } catch { /* the files are back; the next install settles node_modules */ }
      }
    };
    let changed;
    try {
      changed = plan.apply();
    } catch (err) {
      putBack();
      changes.push({ what: `tried to ${plan.verb}, put it back`, where: plan.where, files: plan.files, status: "reverted", reason: `it could not be applied: ${firstClue(err.stderr || err.message)}` });
      log(`        put back: it could not be applied`);
      continue;
    }
    if (!changed) {
      restore(snap, root);
      log(`        nothing to change`);
      continue;
    }
    const proof = prove(root);
    if (proof.ok) {
      changes.push({ what: plan.done, where: plan.where, files: plan.files, status: "applied" });
      log(`        kept: the type check and the test suite pass`);
    } else {
      putBack();
      changes.push({ what: `tried to ${plan.verb}, put it back`, where: plan.where, files: plan.files, status: "reverted", reason: proof.reason });
      log(`        put back: ${proof.reason}`);
    }
  }
  return changes;
}

// ── the API, the SDK and the examples ───────────────────────────────────────

/** Every path the app serves under /api, as written in the route tree ("/agents/[agentId]"). */
export function apiRoutes() {
  return walk(join(ROOT, "src", "app", "api"), ["route.ts"]).map((p) =>
    rel(p).replace(/^src\/app\/api/, "").replace(/\/route\.ts$/, "") || "/",
  );
}

/** Whether `path` ("/agents/abc", "/agents/{agentId}", "/agents/${id}") is served by one of `routes`. */
export function servedBy(path, routes) {
  const parts = path.replace(/\/$/, "").split("/");
  return routes.some((r) => {
    const rp = r.split("/");
    if (rp.length !== parts.length && !rp.some((s) => s.startsWith("[..."))) return false;
    return rp.every((seg, i) => seg.startsWith("[") || seg === parts[i] || /^[{$]/.test(parts[i] ?? ""));
  });
}

/**
 * Routes nobody outside Axon calls, so the reference has no reason to list them.
 *
 * The reference is public, and listing a route there is a statement that a
 * developer may build on it. So the bar runs the other way from the fixer's: a
 * route only gets documented when it is plainly a developer's tool, and anything
 * operational, UI-only or in doubt is named here instead. Each pattern says why.
 */
const INTERNAL_ROUTES = [
  // scheduled jobs, the operator's own tools, the worker, seeding, tests, debugging,
  // demo and network-activity traffic, Telegram, and share images
  /^\/(cron|admin|worker|seed|internal|test|debug|demo|network-activity|telegram|og)(\/|$)/,
  // the reference itself: documenting the document is noise
  /^\/openapi$/,
  // the site's own wallet sign-in session; developers authenticate with API keys (/auth/keys is documented)
  /^\/auth\/(challenge|login|logout|me|verify)$/,
  // the burn pot and the site's headline figures: money flows the site shows, not an interface
  /^\/(burn|analytics)(\/|$)/,
  // operational health and volume: the network feed, worker timings, Prometheus scrapes, the failure monitor
  /^\/(network-feed|worker-metrics|metrics|failures)$/,
  // the $AXON holder pages: tiers, handles and the token launch board, all driven by the site's wallet UI
  /^\/(tier|handles)$/,
  /^\/(agent-launch|launches)\//,
  // the site's "try this agent" box: three free calls per visitor, a demo rather than an API
  /^\/agents\/\[[^\]]+\]\/test$/,
  // the grow experiment and its missions page: operator-guarded setup and a UI built on top
  /^\/grow(\/|$)/,
  // Axon Build, the site's game builder: a product page, not an interface
  /^\/build(\/|$)/,
  // the Open World game: avatars, arcade, inventory and the city model the 3D page draws
  /^\/world(\/|$)/,
];

/** Methods a route exports that the reference must still not list, by route. */
const INTERNAL_METHODS = {
  // re-running a receipt spends model tokens and is operator-gated; reading one stays public
  "/receipts/[taskId]/reproduce": ["POST"],
};

/** Whether `route` ("/world/epoch") is one the reference never lists. */
export const isInternalRoute = (route) => INTERNAL_ROUTES.some((re) => re.test(route));

const SPEC_FILE = join("src", "app", "api", "openapi", "route.ts");

/** The paths the reference documents, as written in the spec ("/agents/{agentId}"). */
export function documentedPaths(spec) {
  const pathsAt = spec.indexOf("paths:");
  return pathsAt < 0 ? [] : [...spec.slice(pathsAt).matchAll(/^ {4}"(\/[^"]*)":\s*\{/gm)].map((m) => m[1]);
}

/** Public routes in `routes` that no documented path covers. */
export function undocumentedRoutes(documented, routes) {
  return routes.filter((r) => !isInternalRoute(r) && !documented.some((d) => servedBy(d.replace(/\{[^}]+\}/g, "x"), [r]) || servedBy(r.replace(/\[[^\]]+\]/g, "{x}"), [d.replace(/\{[^}]+\}/g, "[x]")])));
}

export function checkApiReference() {
  const spec = read(join(ROOT, SPEC_FILE));
  const documented = documentedPaths(spec);
  const routes = apiRoutes();
  const findings = [];
  for (const d of documented) {
    if (!servedBy(d, routes)) findings.push({ severity: "error", what: `the API reference lists /api${d}, which no route serves`, why: "a developer following the reference gets a 404", where: [SPEC_FILE], fix: { kind: "api-reference-remove", path: d } });
  }
  const undocumented = undocumentedRoutes(documented, routes);
  if (undocumented.length) {
    findings.push({ severity: "warn", what: `${undocumented.length} public routes are not in the API reference, e.g. ${undocumented.slice(0, 3).map((r) => `/api${r}`).join(", ")}`, why: "a route nobody can find is a route nobody uses", where: [SPEC_FILE], fix: { kind: "api-reference-add", routes: undocumented } });
  }
  return { checked: documented.length + routes.length, findings };
}

// ── writing the reference ───────────────────────────────────────────────────
// An entry is written only from what the route file says: the methods it
// exports, the parameters in its path, a summary from its own comment, and
// whether the handler asks for a key. No request or response shapes are guessed:
// a reference that invents a field is worse than one that is short.

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** The HTTP methods a route file exports, in a stable order. */
export function routeMethods(src) {
  const found = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) found.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (HTTP_METHODS.includes(name)) found.add(name);
    }
  }
  return HTTP_METHODS.filter((m) => found.has(m));
}

/** Comment text on one line, or null when the line is code. */
const commentText = (line) => {
  const m = line.match(/^\s*(?:\/\/+|\/\*+|\*+(?!\/))\s?(.*?)\s*(?:\*\/)?\s*$/);
  return m ? m[1].trim() : null;
};

/** A comment fragment cut down to a short plain summary, or null. */
function tidySummary(text) {
  let s = text.replace(/\s*[—–]\s*/g, ", ").replace(/`/g, "").replace(/\s+/g, " ").trim();
  // the first clause: up to a sentence end, a colon, or an aside in brackets
  s = s.split(/(?<=[a-z0-9)\]'"])[.:;](?:\s|$)|\s\(/i)[0].replace(/[,.\s]+$/, "").trim();
  if (s.length < 4) return null;
  if (s.length > 100) {
    const comma = s.lastIndexOf(",", 100);
    s = comma > 30 ? s.slice(0, comma) : s.slice(0, 100).replace(/\s+\S*$/, "");
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const METHOD_LINE = /^(GET|POST|PUT|PATCH|DELETE)\s/;
/** A heading such as "Body: {...}" or "SSE event types:", which describes a shape rather than the route. */
const LABEL_LINE = /^[A-Za-z][\w -]{0,24}:(\s|$)/;

/** Comment text from line `i` on, joined until a blank comment line, a new method line or code. */
function proseFrom(lines, i, first) {
  const parts = [first];
  for (let j = i + 1; j < lines.length; j++) {
    const c = commentText(lines[j]);
    if (!c || METHOD_LINE.test(c) || /^→/.test(c)) break;
    // a capital after an unfinished line is a new sentence, not the rest of this one
    if (/^[A-Z]/.test(c) && !/[,(]$/.test(parts[parts.length - 1])) break;
    parts.push(c);
  }
  return parts.join(" ");
}

/**
 * A summary for `method` taken from the route's own comments, or null.
 *
 * Four forms, most specific first: `GET /api/x, what it does` on one line; for
 * a route that serves one method, the comment the file opens with; a bare
 * `GET /api/x` with the prose on the following comment lines; and the comment
 * directly above the handler. Nothing found means no summary: a blank is
 * honest, a guess is not.
 */
export function routeSummary(src, method, { single = false } = {}) {
  const lines = src.split("\n");
  const head = new RegExp(`^${method}\\s+/api/\\S+`);
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const c = commentText(lines[i]);
    if (c == null || !head.test(c)) continue;
    const rest = c.replace(head, "").trim();
    const inline = rest.match(/^[—–-]+\s*(.+)$/);
    if (inline) return tidySummary(proseFrom(lines, i, inline[1]));
    heads.push(i);
  }
  if (single) {
    // the file's own opening comment, before any import or code
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    for (; i < lines.length && commentText(lines[i]) != null; i++) {
      const c = commentText(lines[i]);
      if (!c || /^(GET|POST|PUT|PATCH|DELETE)\s/.test(c) || LABEL_LINE.test(c)) continue;
      return tidySummary(proseFrom(lines, i, c));
    }
  }
  for (const i of heads) {
    for (let j = i + 1; j < lines.length; j++) {
      const next = commentText(lines[j]);
      if (next == null || METHOD_LINE.test(next)) break;
      if (!next || LABEL_LINE.test(next)) continue;
      const arrow = next.match(/^→\s*(.+)$/);
      return tidySummary(proseFrom(lines, j, arrow ? arrow[1] : next));
    }
  }
  if (!single) return null;
  const at = lines.findIndex((l) => new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(l));
  if (at < 0) return null;
  let top = at;
  while (top > 0 && commentText(lines[top - 1]) != null) top--;
  for (let j = top; j < at; j++) {
    const c = commentText(lines[j]);
    if (c && !METHOD_LINE.test(c) && !LABEL_LINE.test(c)) return tidySummary(proseFrom(lines, j, c));
  }
  return null;
}

const AUTH_MARK = /require(ApiKey|AgentOwner)\(|authorization|x-api-key/i;

/** The source of one exported handler, so auth is judged per method. */
function handlerSource(src, method) {
  const at = src.search(new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${method}\\b`));
  if (at < 0) return src; // re-exported from elsewhere: judge on the whole file
  const next = src.slice(at + 1).search(/\nexport\s/);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
}

/**
 * Whether `method` asks the caller for a key, in its own body or through a
 * helper in the same file. Either way the answer leans to "yes": a reference
 * that says a key is needed when it is not costs a caller a header, one that
 * says the opposite costs them a 401 and an afternoon.
 */
function handlerNeedsKey(src, method) {
  const body = handlerSource(src, method);
  if (AUTH_MARK.test(body)) return true;
  for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)\s*\([\s\S]*?^\}/gm)) {
    if (AUTH_MARK.test(m[0]) && new RegExp(`\\b${m[1]}\\(`).test(body)) return true;
  }
  for (const m of src.matchAll(/^const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>[\s\S]*?;\s*$/gm)) {
    if (AUTH_MARK.test(m[0]) && new RegExp(`\\b${m[1]}\\(`).test(body)) return true;
  }
  return false;
}

const TAGS = { agents: "Agents", tasks: "Tasks", receipts: "Receipts", webhooks: "Webhooks", commerce: "Commerce", auth: "Auth", mcp: "MCP", mpp: "MPP" };

/** One `paths` entry for `route`, as source text in the spec's own style. */
export function openApiEntry(route, src) {
  const internal = INTERNAL_METHODS[route] ?? [];
  const methods = routeMethods(src).filter((m) => !internal.includes(m));
  if (!methods.length) return null;
  const params = [...route.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((m) => m[1]);
  const path = route.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, "{$1}");
  const seg = route.split("/")[1] ?? "";
  const tag = TAGS[seg] ?? seg.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const out = [`    ${JSON.stringify(path)}: {`];
  if (params.length) {
    out.push(`      parameters: [${params.map((p) => `{ name: ${JSON.stringify(p)}, in: "path", required: true, schema: { type: "string" } }`).join(", ")}],`);
  }
  for (const m of methods) {
    const summary = routeSummary(src, m, { single: methods.length === 1 });
    // The spec's default is a key. A handler that never asks for one is open,
    // and saying so stops the reference telling people to send a key for nothing.
    const open = !handlerNeedsKey(src, m);
    const fields = [summary ? `summary: ${JSON.stringify(summary)}` : null, `tags: [${JSON.stringify(tag)}]`, open ? "security: []" : null].filter(Boolean);
    out.push(`      ${m.toLowerCase()}: { ${fields.join(", ")} },`);
  }
  out.push("    },");
  return out.join("\n");
}

/** `spec` with the entry for `path` taken out, or null when it is not there in the expected shape. */
export function removeSpecPath(spec, path) {
  const start = spec.search(new RegExp(`^ {4}${JSON.stringify(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*\\{`, "m"));
  if (start < 0) return null;
  const close = spec.slice(start).search(/\n {4}\},?[ \t]*(\n|$)/);
  if (close < 0) return null;
  let from = start;
  let end = start + close + spec.slice(start + close).match(/\n {4}\},?[ \t]*/)[0].length;
  if (spec[end] === "\n") end++; // its own line break
  // and one blank line that separated it, before it if there is one, else after
  if (spec.slice(from - 2, from) === "\n\n") from--;
  else if (spec[end] === "\n") end++;
  return spec.slice(0, from) + spec.slice(end);
}

/** `spec` with `entries` appended to the end of `paths`, or null when `paths` cannot be found. */
export function addSpecEntries(spec, entries) {
  const pathsAt = spec.indexOf("paths:");
  if (pathsAt < 0 || !entries.length) return null;
  const close = spec.slice(pathsAt).search(/\n {2}\},?[ \t]*\n/);
  if (close < 0) return null;
  const at = pathsAt + close;
  return `${spec.slice(0, at)}\n\n${entries.join("\n\n")}${spec.slice(at)}`;
}

export function checkSdkRoutes() {
  const routes = apiRoutes();
  const files = walk(join(ROOT, "packages", "sdk", "src"), [".ts"]).filter((f) => !rel(f).includes("__tests__"));
  const findings = [];
  let checked = 0;
  for (const f of files) {
    for (const m of read(f).matchAll(/["'`]\/api(\/[^"'`\s?]*)/g)) {
      // a template part like ${pathPart(id)} is one segment, whatever it calls
      const path = m[1]
        .replace(/\$\{[^}]*\}/g, "${x}")
        .replace(/\$\{[^}]*$/, "") // a query string built inside the template: not part of the path
        .replace(/([^/])\$\{x\}/g, "$1") // nor is one glued to the end of a segment
        .replace(/\/$/, "");
      if (!path) continue;
      checked++;
      if (!servedBy(path.replace(/\$\{x\}$/, "") || "/", routes) && !servedBy(path, routes)) {
        findings.push({ severity: "error", what: `the SDK calls /api${path}, which no route serves`, why: "every SDK user hits a 404 there", where: [rel(f)] });
      }
    }
  }
  return { checked, findings };
}

/** Names the SDK exports, from its sources. */
export function sdkExports() {
  const names = new Set();
  for (const f of walk(join(ROOT, "packages", "sdk", "src"), [".ts"])) {
    const src = read(f);
    for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "").trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

export function checkExamples() {
  const exported = sdkExports();
  const files = [
    ...walk(join(ROOT, "examples"), [".ts", ".js", ".mjs", ".md"]),
    ...walk(join(ROOT, "src", "app", "docs"), [".tsx"]),
    ...walk(join(ROOT, "packages", "sdk"), [".md"]),
  ];
  const findings = [];
  let checked = 0;
  for (const f of files) {
    for (const m of read(f).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@axonprotocol\/sdk["']/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        checked++;
        if (!exported.has(name)) findings.push({ severity: "error", what: `an example imports ${name} from the SDK, which does not export it`, why: "the example fails the moment someone copies it", where: [rel(f)] });
      }
    }
  }
  return { checked, findings };
}

// ── packages and the database ───────────────────────────────────────────────

/** Packages the build needs without any file importing them by name. */
const IMPLIED = /^(@types\/|eslint|typescript$|next$|react$|react-dom$|tailwindcss$|@tailwindcss\/|postcss$|autoprefixer$|vitest$|@vitejs\/|vite-tsconfig-paths$|tsx$|prettier)/;

export function checkPackages() {
  const pkg = JSON.parse(read(join(ROOT, "package.json")));
  // only what ships: a dev tool is often run by name from a script rather than imported
  const deps = Object.keys(pkg.dependencies ?? {});
  // a package another installed package needs (a peer dependency) is used even if nothing imports it by name
  const peers = new Set();
  for (const d of deps) {
    try {
      for (const p of Object.keys(JSON.parse(read(join(ROOT, "node_modules", d, "package.json"))).peerDependencies ?? {})) peers.add(p);
    } catch { /* not installed here: judged on imports alone */ }
  }
  // Wide on purpose, now that this finding can uninstall: a package named only in
  // the Dockerfile, a root file such as instrumentation.ts, or one of the
  // packages/ that resolve through this node_modules is in use, and missing it
  // here would delete something production needs. The gate would likely catch
  // that, but a check should not lean on the gate to be right.
  const haystack = [
    ...walk(join(ROOT, "src"), [".ts", ".tsx", ".css", ".mjs", ".js"]),
    ...walk(join(ROOT, "scripts"), [".ts", ".mjs", ".js", ".sh"]),
    ...walk(join(ROOT, "packages"), [".ts", ".tsx", ".mjs", ".js", ".cjs"]),
    ...readdirSync(ROOT).filter((f) => /\.(config\.|rc)/.test(f) || /^(next|vitest|tailwind|postcss|eslint)\./.test(f) || /\.(ts|mts|mjs|js|cjs)$/.test(f) || /^Dockerfile/.test(f)).map((f) => join(ROOT, f)),
  ].filter((f) => statSync(f).isFile()).map(read).join("\n") + JSON.stringify(pkg.scripts ?? {});
  const findings = [];
  for (const d of deps) {
    if (IMPLIED.test(d) || peers.has(d)) continue;
    if (!haystack.includes(`"${d}"`) && !haystack.includes(`'${d}'`) && !haystack.includes(`"${d}/`) && !haystack.includes(`'${d}/`) && !haystack.includes(` ${d} `)) {
      findings.push({ severity: "warn", what: `${d} is installed and nothing in Axon imports it`, why: "an unused package is install time and attack surface for nothing", where: ["package.json"], fix: { kind: "uninstall", package: d } });
    }
  }
  // known vulnerabilities in what ships (not dev tools); the audit needs the registry, so a failure says so
  let audited = 0;
  try {
    const out = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
    audited = 1;
    const v = JSON.parse(out).metadata?.vulnerabilities ?? {};
    if ((v.high ?? 0) + (v.critical ?? 0) > 0) findings.push({ severity: "warn", what: `${v.critical ?? 0} critical and ${v.high ?? 0} high vulnerabilities in shipped packages`, why: "known holes in what runs in production", where: ["package-lock.json"], fix: { kind: "audit-fix" } });
  } catch (err) {
    // npm audit exits non-zero when it finds something: its output is still the report
    const out = err?.stdout;
    if (typeof out === "string" && out.trim().startsWith("{")) {
      audited = 1;
      const v = JSON.parse(out).metadata?.vulnerabilities ?? {};
      if ((v.high ?? 0) + (v.critical ?? 0) > 0) findings.push({ severity: "warn", what: `${v.critical ?? 0} critical and ${v.high ?? 0} high vulnerabilities in shipped packages`, why: "known holes in what runs in production", where: ["package-lock.json"], fix: { kind: "audit-fix" } });
    }
  }
  return { checked: deps.length + audited, findings };
}

/** Migrations numbered once each, in order, with nothing skipped: a gap or a twin is a schema someone cannot rebuild. */
export function migrationProblems(files) {
  const nums = files.map((f) => Number(f.split("_")[0])).filter((n) => Number.isInteger(n));
  const problems = [];
  const seen = new Set();
  for (const n of nums) {
    if (seen.has(n)) problems.push(`two migrations are numbered ${String(n).padStart(3, "0")}`);
    seen.add(n);
  }
  const sorted = [...seen].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) problems.push(`no migration ${String(sorted[i - 1] + 1).padStart(3, "0")} between ${sorted[i - 1]} and ${sorted[i]}`);
  return problems;
}

export function checkMigrations() {
  const files = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql"));
  const findings = migrationProblems(files).map((what) => ({ severity: "error", what, why: "the database cannot be rebuilt the same way twice", where: ["migrations/"] }));
  return { checked: files.length, findings };
}

// ── runner ───────────────────────────────────────────────────────────────────
// Wrapped so the module can be imported without running a pass. The checks above
// edit source when asked, and until this guard existed they could not be tested
// at all — importing the file *was* running it. Something that rewrites code
// should be the best-covered part of this, not the only untested one.
export async function main() {
  const CHECKS = [
    { id: "install-commands", title: "Install commands resolve", run: checkInstallCommands },
    { id: "links", title: "Internal links point at real pages", run: checkInternalLinks },
    { id: "dead-exports", title: "Exports are used", run: checkDeadExports },
    { id: "api-reference", title: "The API reference matches the routes", run: checkApiReference },
    { id: "sdk-routes", title: "The SDK calls routes that exist", run: checkSdkRoutes },
    { id: "examples", title: "Examples import what the SDK exports", run: checkExamples },
    { id: "packages", title: "Packages are used and free of known holes", run: checkPackages },
    { id: "migrations", title: "Migrations are complete and in order", run: checkMigrations },
  ];

  const runChecks = async () => {
    const results = [];
    for (const check of CHECKS) {
      if (ONLY && ONLY !== check.id) continue;
      process.stdout.write(`  ${check.id} … `);
      const t0 = Date.now();
      try {
        const { checked, findings } = await check.run();
        results.push({ id: check.id, title: check.title, ok: findings.filter((f) => f.severity === "error").length === 0, checked, findings, ms: Date.now() - t0 });
        console.log(`${checked} checked, ${findings.length} finding(s), ${Date.now() - t0}ms`);
        for (const f of findings) console.log(`      ${f.severity === "error" ? "ERROR" : "warn "} ${f.what}  [${f.where.join(", ")}]`);
      } catch (err) {
        results.push({ id: check.id, title: check.title, ok: false, checked: 0, findings: [{ severity: "error", what: `the check itself failed: ${err.message}`, why: "a check that cannot run proves nothing", where: [] }], ms: Date.now() - t0 });
        console.log(`FAILED: ${err.message}`);
      }
    }
    return results;
  };

  const startedAt = new Date().toISOString();
  let results = await runChecks();

  const changes = FIX ? applyFixes(results, { write: !DRY, log: console.log }) : [];
  const kept = changes.filter((c) => c.status === "applied");
  if (FIX) {
    const reverted = changes.filter((c) => c.status === "reverted");
    console.log(DRY ? `\nwould try ${changes.length} fix(es):` : `\nkept ${kept.length} fix(es), put back ${reverted.length}:`);
    for (const c of changes) console.log(`      ${c.status === "reverted" ? "put back" : c.status === "applied" ? "kept    " : ""} ${c.what}  [${c.where}]${c.reason ? `  (${c.reason})` : ""}`);
  }
  // What was found is recorded about the tree as it is left, not as it was
  // found: a log that lists a problem next to the change that fixed it says
  // two contradictory things at once.
  if (kept.length) {
    console.log("\nchecking again after the kept fixes:");
    results = await runChecks();
  }

  const errors = results.flatMap((r) => r.findings).filter((f) => f.severity === "error").length;
  const warnings = results.flatMap((r) => r.findings).filter((f) => f.severity === "warn").length;
  const run = {
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return null; } })(),
    checks: results,
    errors,
    warnings,
    // Recorded explicitly rather than inferred, so a reader can always tell a pass
    // that looked from a pass that also edited.
    changed: kept.length > 0,
    changes,
  };

  console.log(`\n${errors} error(s), ${warnings} warning(s) across ${results.length} check(s).`);

  if (!DRY) {
    mkdirSync(LOG_DIR, { recursive: true });
    // `fix` is how the runner applies a repair; the log records what was applied,
    // so strip it rather than publishing an instruction set.
    const forLog = JSON.parse(JSON.stringify(run, (k, v) => (k === "fix" ? undefined : v)));
    writeFileSync(join(LOG_DIR, "latest.json"), `${JSON.stringify(forLog, null, 2)}\n`);

    // History carries the shape of each pass, not its full text. A complete entry
    // is ~2.7KB, the page only ever shows a previous pass's date and counts, and
    // this file is read whole on every render — so the findings would be paid for
    // on every page load and never displayed. The detail is not lost: latest.json
    // is committed each run, so `git log autonomy/latest.json` still has all of it.
    const summary = {
      ...forLog,
      checks: forLog.checks.map(({ findings: _findings, ...rest }) => ({ ...rest, findings: [] })),
      // Emptied, not counted. Turning this into a number would make history entries
      // disagree with the type every reader of the log is handed, and the page
      // shows a previous pass's date and totals — never its individual changes.
      changes: [],
    };
    appendFileSync(join(LOG_DIR, "history.jsonl"), `${JSON.stringify(summary)}\n`);

    // Keep the file bounded. Git holds every past version, so trimming the working
    // copy costs nothing an auditor can't recover with `git log`.
    const KEEP = 200;
    const lines = readFileSync(join(LOG_DIR, "history.jsonl"), "utf8").split("\n").filter(Boolean);
    if (lines.length > KEEP) {
      writeFileSync(join(LOG_DIR, "history.jsonl"), `${lines.slice(-KEEP).join("\n")}\n`);
    }
    console.log(`wrote autonomy/latest.json and appended to autonomy/history.jsonl`);
  }

  // Findings are the point of the run, not a reason to fail it — a red build every
  // time the docs drift would just get muted, and a muted check is worse than none.
  // The workflow opens an issue instead. Only a check that could not execute fails.
  const broken = results.some((r) => r.findings.some((f) => f.what.startsWith("the check itself failed")));
  process.exit(broken ? 1 : 0);

}

// Only when invoked directly, never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
