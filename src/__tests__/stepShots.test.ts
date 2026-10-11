// Agents that use the internet, phase 3: watch it live. A step an agent takes in its browser carries a picture of
// the page: where the picture is kept, who can read it, what it is never mistaken for, and the line of the live
// log it goes with. No browser and no model here: the pictures are stand-ins.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getDb } from "@/lib/db";
import { createTask } from "@/lib/tasks";
import { filesOfTask, receiptFiles, getFile, fileTokenValid, mayRead, purgeExpiredFiles, keepOutput, KEEP_MS } from "@/lib/agentFiles";
import { keepStepShot, shotsOf, MAX_SHOTS_PER_JOB, MAX_SHOT_BYTES } from "@/lib/stepShots";
import { liveLog, stepsOf } from "@/lib/liveLog";
import { emitProgress } from "@/lib/progress";

const jpeg = (fill: number, size = 400) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 1)]);
let dir = "";
const saved = { ...process.env };
const job = () => createTask({ fromAgent: "buyer", toAgent: "browser-agent", task: "Open example.com", initialStatus: "running", startedBy: "worker" }).taskId;

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-shots-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FILES: "on", AGENT_LIVE_LOG: "on", AXON_FILES_DIR: dir });
  getDb().exec("DELETE FROM task_files; DELETE FROM task_step_shots; DELETE FROM task_progress; DELETE FROM tasks;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("a step's picture", () => {
  it("is kept with its line and handed to the job's reader with a token and a path", () => {
    const taskId = job();
    expect(keepStepShot({ taskId, sequence: 2, bytes: jpeg(1) })).toBe(true);
    const shot = shotsOf(taskId).get(2)!;
    expect(shot.path).toBe(`/api/files/${shot.id}/content`);
    expect(shot.size).toBe(404);
    expect(fileTokenValid(shot.id, shot.token)).toBe(true);
    const file = getFile(shot.id)!;
    expect(file).toMatchObject({ direction: "shot", kind: "image", mime: "image/jpeg", name: "step-2.jpg", task_id: taskId });
    // read with its token and by nobody without it
    expect(mayRead(file, { token: shot.token })).toBe(true);
    expect(mayRead(file, { token: "0".repeat(shot.token.length) })).toBe(false);
    expect(mayRead(file, {})).toBe(false);
  });

  it("is not one of the job's files: not handed in, not handed back, on no receipt", () => {
    const taskId = job();
    keepStepShot({ taskId, sequence: 1, bytes: jpeg(2) });
    keepOutput({ taskId, bytes: PNG, name: "chart.png", wallet: null });
    expect(filesOfTask(taskId, "in")).toEqual([]);
    expect(filesOfTask(taskId, "out").map((f) => f.name)).toEqual(["chart.png"]);
    expect(receiptFiles(taskId, "out").map((f) => f.name)).toEqual(["chart.png"]);
    expect(receiptFiles(taskId, "in")).toEqual([]);
    expect(shotsOf(taskId).size).toBe(1);
  });

  it("a second picture for the same line takes the first one's place", () => {
    const taskId = job();
    keepStepShot({ taskId, sequence: 1, bytes: jpeg(3) });
    const first = shotsOf(taskId).get(1)!.id;
    keepStepShot({ taskId, sequence: 1, bytes: jpeg(4) });
    expect(shotsOf(taskId).size).toBe(1);
    expect(shotsOf(taskId).get(1)!.id).not.toBe(first);
  });

  it("is refused when it is not a picture, is empty, is far too large, or names no line", () => {
    const taskId = job();
    expect(keepStepShot({ taskId, sequence: 1, bytes: Buffer.from("just some words, not a picture") })).toBe(false);
    expect(keepStepShot({ taskId, sequence: 1, bytes: Buffer.alloc(0) })).toBe(false);
    expect(keepStepShot({ taskId, sequence: 1, bytes: jpeg(5, MAX_SHOT_BYTES + 10) })).toBe(false);
    expect(keepStepShot({ taskId, sequence: 0, bytes: jpeg(5) })).toBe(false);
    expect(keepStepShot({ taskId, sequence: 1.5, bytes: jpeg(5) })).toBe(false);
    expect(shotsOf(taskId).size).toBe(0);
    // and what was refused as "not a picture" is not left lying in the store either
    expect((getDb().prepare("SELECT COUNT(*) n FROM task_files WHERE deleted_at IS NULL").get() as { n: number }).n).toBe(0);
  });

  it("one job keeps only so many", () => {
    const taskId = job();
    for (let i = 1; i <= MAX_SHOTS_PER_JOB; i++) expect(keepStepShot({ taskId, sequence: i, bytes: jpeg(i % 250, 300 + i) })).toBe(true);
    expect(keepStepShot({ taskId, sequence: MAX_SHOTS_PER_JOB + 1, bytes: jpeg(9, 999) })).toBe(false);
    expect(shotsOf(taskId).size).toBe(MAX_SHOTS_PER_JOB);
  });

  it("nothing is kept while files are off", () => {
    const taskId = job();
    expect(keepStepShot({ taskId, sequence: 1, bytes: jpeg(6) }, { env: {} })).toBe(false);
    expect(shotsOf(taskId).size).toBe(0);
  });

  it("goes when its time is up, a visitor's sooner than a wallet's, and the log is then a log without it", () => {
    const guest = job(), owner = job(), now = Date.now();
    keepStepShot({ taskId: guest, sequence: 1, bytes: jpeg(7) }, { now });
    keepStepShot({ taskId: owner, sequence: 1, bytes: jpeg(8), wallet: "0xAbC0000000000000000000000000000000000001" }, { now });
    const later = now + KEEP_MS.guest + 1000;
    expect(shotsOf(guest, later).size).toBe(0);
    expect(shotsOf(owner, later).size).toBe(1);
    purgeExpiredFiles(later);
    expect(shotsOf(guest).size).toBe(0);
    expect(shotsOf(owner, now + KEEP_MS.wallet + 1000).size).toBe(0);
  });

  it("one job's pictures are never another's", () => {
    const a = job(), b = job();
    keepStepShot({ taskId: a, sequence: 1, bytes: jpeg(9) });
    expect(shotsOf(b).size).toBe(0);
    // a row that points a line at another job's picture shows nothing
    getDb().prepare("INSERT INTO task_step_shots (task_id, sequence, file_id) VALUES (?,?,?)").run(b, 1, shotsOf(a).get(1)!.id);
    expect(shotsOf(b).size).toBe(0);
  });
});

describe("the live log, with pictures", () => {
  it("a line said for the browser gets the picture taken once the thing is done", () => {
    const taskId = job(), live = liveLog(taskId);
    live.say("Picked up by Browser Agent");
    const picture = live.show("Opening example.com");
    expect(stepsOf(taskId).map((s) => [s.text, Boolean(s.shot)])).toEqual([["Picked up by Browser Agent", false], ["Opening example.com", false]]);
    picture(jpeg(1));
    const steps = stepsOf(taskId);
    expect(steps[1].shot).toMatchObject({ path: expect.stringMatching(/^\/api\/files\/f_[0-9a-f]+\/content$/), token: expect.any(String) });
    expect(steps[0].shot).toBeUndefined();
  });

  it("the same thing done twice in a row is one line, and the newer picture is the one it shows", () => {
    const taskId = job(), live = liveLog(taskId);
    live.show("Scrolling down")(jpeg(1));
    const first = stepsOf(taskId)[0].shot!.id;
    live.show("Scrolling down")(jpeg(2));
    const steps = stepsOf(taskId);
    expect(steps.length).toBe(1);
    expect(steps[0].shot!.id).not.toBe(first);
  });

  it("say tells where the line went, and null when nothing was written", () => {
    const taskId = job(), live = liveLog(taskId);
    expect(live.say("One")).toBe(1);
    expect(live.say("One")).toBeNull();
    expect(live.say("Two")).toBe(2);
    expect(live.say(null)).toBeNull();
  });

  it("with the log off there is no line and no picture, and nothing throws", () => {
    const taskId = job(), live = liveLog(taskId, { enabled: false });
    live.show("Opening example.com")(jpeg(1));
    expect(stepsOf(taskId)).toEqual([]);
    expect(shotsOf(taskId).size).toBe(0);
  });

  it("a picture for a job that is no longer running is not kept with a line that was never written", () => {
    const taskId = createTask({ fromAgent: "buyer", toAgent: "browser-agent", task: "x" }).taskId; // not running
    const live = liveLog(taskId);
    live.show("Opening example.com")(jpeg(1));
    expect(emitProgress(taskId, "x")).toBeNull();
    expect(shotsOf(taskId).size).toBe(0);
  });
});
