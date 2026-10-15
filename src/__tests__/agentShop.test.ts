// Agents that sell what they make: the switch, the limits and the tables the shop keeps.
import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { shopEnabled, shopLimits } from "@/lib/agentShop";
import { formatEth } from "@/lib/money";

describe("the shop's switch", () => {
  it("is off unless AGENT_SHOP is on, and needs agents that build", () => {
    expect(shopEnabled({})).toBe(false);
    expect(shopEnabled({ AGENT_SHOP: "on" })).toBe(false);
    expect(shopEnabled({ AGENT_SITES: "on" })).toBe(false);
    expect(shopEnabled({ AGENT_SHOP: "off", AGENT_SITES: "on" })).toBe(false);
    expect(shopEnabled({ AGENT_SHOP: " ON ", AGENT_SITES: "on" })).toBe(true);
  });
});

describe("the shop's limits", () => {
  it("has a floor and a ceiling on prices, in wei, that a deployment can move inside bounds", () => {
    const d = shopLimits({});
    expect(formatEth(d.minWei)).toBe("0.0001 ETH");
    expect(formatEth(d.maxWei)).toBe("1 ETH");
    expect(formatEth(d.materialMaxWei)).toBe("0.005 ETH");
    expect(d).toMatchObject({ perAgent: 50, makePerDayMax: 3, makeDaily: 50, priceGraceMinutes: 30 });
    const set = shopLimits({ AGENT_SHOP_MIN_ETH: "0.001", AGENT_SHOP_MAX_ETH: "0.5", AGENT_SHOP_MAKE_PER_DAY: "2", AGENT_SHOP_MATERIAL_MAX_ETH: "0" });
    expect(formatEth(set.minWei)).toBe("0.001 ETH");
    expect(formatEth(set.maxWei)).toBe("0.5 ETH");
    expect(set.makePerDayMax).toBe(2);
    expect(set.materialMaxWei).toBe(0n);
    // out of range or not a number: the default, never a float read as money
    const odd = shopLimits({ AGENT_SHOP_MIN_ETH: "-1", AGENT_SHOP_MAX_ETH: "1e3", AGENT_SHOP_MAKE_PER_DAY: "99" });
    expect(formatEth(odd.minWei)).toBe("0.0001 ETH");
    expect(formatEth(odd.maxWei)).toBe("1 ETH");
    expect(odd.makePerDayMax).toBe(3);
  });
});

describe("the shop's tables", () => {
  it("are there, and one page can be on sale only once at a time", () => {
    const db = getDb();
    for (const t of ["shop_products", "shop_sales", "shop_agents", "shop_make_runs"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).toBeTruthy();
    }
    const add = db.prepare("INSERT INTO shop_products (product_id, agent_id, seller_wallet, site_id, version, sha256, title, description, price_wei, status, created_at, updated_at) VALUES (?, 'a', '0x1', 'site-1', 1, 'f', 't', 'd', '1', ?, 'x', 'x')");
    add.run("p1", "listed");
    expect(() => add.run("p2", "listed")).toThrow(/UNIQUE/);
    add.run("p3", "down");
    db.exec("DELETE FROM shop_products");
  });

  it("never takes the same payment for two sales", () => {
    const db = getDb();
    const add = db.prepare("INSERT INTO shop_sales (sale_id, product_id, agent_id, buyer, buyer_kind, price_wei, payment_signature, status, version, sha256, title, created_at) VALUES (?, 'p', 'a', 'b', 'wallet', '1', ?, 'paid', 1, 'f', 't', 'x')");
    add.run("s1", "0xabc");
    expect(() => add.run("s2", "0xabc")).toThrow(/UNIQUE/);
    // a purchase from an agent's balance has no transaction of its own
    add.run("s3", null);
    add.run("s4", null);
    db.exec("DELETE FROM shop_sales");
  });
});
