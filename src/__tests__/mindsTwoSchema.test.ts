// Agent Minds 2, phase 0: the tables a mind keeps its plan, orders, promises, outcomes, reports and brief in exist,
// and nothing about the thoughts written before them changes.
import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";

const columns = (table: string) => (getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null }[]);

describe("what Agent Minds 2 stores", () => {
  it("has every table the plan needs", () => {
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mind_%'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["mind_history", "mind_plans", "mind_plan_log", "mind_orders", "mind_outcomes", "mind_reports", "mind_briefs", "mind_brief_log"]) expect(tables).toContain(t);
  });

  it("marks where a thought came from, and every earlier thought counts as woken by an event", () => {
    const source = columns("mind_thoughts").find((c) => c.name === "source")!;
    expect(source).toMatchObject({ notnull: 1, dflt_value: "'event'" });
    const db = getDb();
    const id = db.prepare("INSERT INTO mind_thoughts (token, at, model, status, reasons) VALUES ('0xschema', '2026-10-06T00:00:00.000Z', 'claude-opus-5-5', 'thought', '[]')").run().lastInsertRowid;
    expect((db.prepare("SELECT source FROM mind_thoughts WHERE id = ?").get(id) as { source: string }).source).toBe("event");
  });

  it("keeps one plan, one brief and one report a day per token, and an order starts armed", () => {
    const db = getDb(), at = "2026-10-06T10:00:00.000Z";
    db.prepare("INSERT INTO mind_plans (token, plan, set_at) VALUES ('0xone', '{}', ?)").run(at);
    expect(() => db.prepare("INSERT INTO mind_plans (token, plan, set_at) VALUES ('0xone', '{}', ?)").run(at)).toThrow();
    db.prepare("INSERT INTO mind_briefs (token, text, set_by, set_at) VALUES ('0xone', 'Reward the ones who stay.', '0xme', ?)").run(at);
    expect(() => db.prepare("INSERT INTO mind_briefs (token, text, set_by, set_at) VALUES ('0xone', 'x', '0xme', ?)").run(at)).toThrow();
    db.prepare("INSERT INTO mind_reports (token, day, text, at) VALUES ('0xone', '2026-10-06', 'Quiet day.', ?)").run(at);
    expect(() => db.prepare("INSERT INTO mind_reports (token, day, text, at) VALUES ('0xone', '2026-10-06', 'Again.', ?)").run(at)).toThrow();
    const id = db.prepare("INSERT INTO mind_orders (token, when_kind, when_value, then_kind, then_eth, created_at) VALUES ('0xone', 'holders_reach', 100, 'reward', 0.01, ?)").run(at).lastInsertRowid;
    expect(db.prepare("SELECT status, promise FROM mind_orders WHERE id = ?").get(id)).toEqual({ status: "armed", promise: 0 });
    // a sample of the token's numbers is one row per moment
    db.prepare("INSERT INTO mind_history (token, at, mcap_eth, holders) VALUES ('0xone', ?, 2.9, 26)").run(at);
    expect(() => db.prepare("INSERT INTO mind_history (token, at, mcap_eth, holders) VALUES ('0xone', ?, 3.0, 27)").run(at)).toThrow();
  });
});
