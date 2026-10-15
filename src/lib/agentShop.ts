// Agents that sell what they make: the shop's store and its rules.
//
// An agent that builds a page or a small app for its owner can now sell it. The owner puts one version of the page up
// for sale with a title, a few words and a price in ETH; anybody can open the live page to see what it is; a buyer pays
// in ETH on Robinhood Chain the way a paid hire is paid, and gets the files at once with a receipt that carries the
// version's fingerprint. What a sale brings in is the agent's earnings, like a paid job's.
//
// The rules the whole thing rests on:
//
//   Only what the owner had built through Axon is sold: a page this agent built for the owner themselves, under the
//   owner's own mark. Never a page it built for a customer, which is the customer's.
//
//   What is sold is fixed when it is listed: one version, by its fingerprint. A later change to the page is not slipped
//   into a sale; the owner lists the new version instead.
//
//   Every page listed passes the build rules again when it is listed and again when it is sold (./agentSites). A page
//   that was taken down, after reports or by a moderator, is off sale with it.
//
//   Money is wei from the moment a price is read (./money). A price has a floor and a ceiling a deployment can set.
//
// This file is the store and listing. Buying is ./shopSales, an agent making products by itself is ./shopMake, an agent
// buying material for a job is ./shopTool.
//
// AGENT_SHOP=on switches it on, with AGENT_SITES=on (what is sold is what agents build). Off (the default) nothing
// here is reachable and every page and route behaves as it did before.

import { randomBytes } from "node:crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { sameAddress } from "./address";
import { getAgentById } from "./agents";
import { validateAgentText } from "./agentContent";
import { decimalToWei, formatEth, toWei } from "./money";
import { checkFiles, filesOf, getSite, reportSite, siteLimits, sitesEnabled, versionsOf, type Site } from "./agentSites";
import { fileReport } from "./abuse";

type Env = Record<string, string | undefined>;

export function shopEnabled(env: Env = process.env): boolean {
  return (env.AGENT_SHOP ?? "off").trim().toLowerCase() === "on" && sitesEnabled(env);
}

const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};
/** An ETH amount from the environment, as wei, inside bounds; the fallback when it is missing or out of them. */
const ethEnv = (raw: string | undefined, fallback: string, min: bigint, max: bigint): bigint => {
  const wei = raw?.trim() ? decimalToWei(raw.trim()) : null;
  return wei !== null && wei >= min && wei <= max ? wei : (decimalToWei(fallback) as bigint);
};

const WEI = (eth: string): bigint => decimalToWei(eth) as bigint;

export interface ShopLimits {
  /** the lowest and highest price a product may have */
  minWei: bigint;
  maxWei: bigint;
  /** products one agent may have on sale at once */
  perAgent: number;
  /** products one agent may make by itself in a day, at most, whatever its owner sets */
  makePerDayMax: number;
  /** products all agents together may make by themselves in a day: each one is a build Axon pays the model for */
  makeDaily: number;
  /** the most one job may spend on other agents' products, whatever an owner sets */
  materialMaxWei: bigint;
  /** minutes a price that was just changed is still honoured, for a buyer who paid while it changed */
  priceGraceMinutes: number;
}

/** What may be sold, and for how much. Each can be set for a deployment; a value out of range is ignored. */
export function shopLimits(env: Env = process.env): ShopLimits {
  return {
    minWei: ethEnv(env.AGENT_SHOP_MIN_ETH, "0.0001", WEI("0.000001"), WEI("1")),
    maxWei: ethEnv(env.AGENT_SHOP_MAX_ETH, "1", WEI("0.000001"), WEI("100")),
    perAgent: num(env.AGENT_SHOP_PER_AGENT, 50, 1, 1000),
    makePerDayMax: num(env.AGENT_SHOP_MAKE_PER_DAY, 3, 1, 24),
    makeDaily: num(env.AGENT_SHOP_MAKE_DAILY_MAX, 40, 0, 5000),
    materialMaxWei: ethEnv(env.AGENT_SHOP_MATERIAL_MAX_ETH, "0.005", 0n, WEI("1")),
    priceGraceMinutes: num(env.AGENT_SHOP_PRICE_GRACE_MIN, 30, 0, 24 * 60),
  };
}

export const SHOP = { titleChars: 80, descriptionChars: 400, kindChars: 300, page: 24, most: 100 } as const;

// ── What the store holds ──────────────────────────────────────────────────────

export type MadeBy = "owner" | "agent";

export interface Product {
  productId: string;
  agentId: string;
  sellerWallet: string;
  siteId: string;
  version: number;
  sha256: string;
  title: string;
  description: string;
  priceWei: bigint;
  prevPriceWei: bigint | null;
  priceChangedAt: string | null;
  status: "listed" | "down";
  madeBy: MadeBy;
  sold: number;
  createdAt: string;
  updatedAt: string;
}

export type SaleStatus = "paid" | "delivered" | "refunded";

export interface Sale {
  saleId: string;
  productId: string;
  agentId: string;
  buyer: string;
  buyerKind: "wallet" | "agent";
  forTaskId: string | null;
  priceWei: bigint;
  paymentSignature: string | null;
  status: SaleStatus;
  version: number;
  sha256: string;
  title: string;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ShopAgent {
  agentId: string;
  ownerWallet: string;
  make: { on: boolean; kind: string | null; priceWei: bigint | null; everyHours: number | null; perDay: number | null; nextAt: string | null };
  buy: { on: boolean; maxWei: bigint | null };
  updatedAt: string;
}

type Row = Record<string, unknown>;
/** Wei as it is kept: whole numbers in text, never a decimal. */
const big = (v: unknown): bigint | null => (v === null || v === undefined || !/^\d+$/.test(String(v)) ? null : BigInt(String(v)));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export const toProduct = (r: Row): Product => ({
  productId: String(r.product_id), agentId: String(r.agent_id), sellerWallet: String(r.seller_wallet), siteId: String(r.site_id),
  version: Number(r.version), sha256: String(r.sha256), title: String(r.title), description: String(r.description),
  priceWei: big(r.price_wei) ?? 0n, prevPriceWei: big(r.prev_price_wei), priceChangedAt: str(r.price_changed_at),
  status: r.status === "down" ? "down" : "listed", madeBy: r.made_by === "agent" ? "agent" : "owner", sold: Number(r.sold ?? 0),
  createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

export const toSale = (r: Row): Sale => ({
  saleId: String(r.sale_id), productId: String(r.product_id), agentId: String(r.agent_id), buyer: String(r.buyer),
  buyerKind: r.buyer_kind === "agent" ? "agent" : "wallet", forTaskId: str(r.for_task_id), priceWei: big(r.price_wei) ?? 0n,
  paymentSignature: str(r.payment_signature), status: (["paid", "delivered", "refunded"].includes(String(r.status)) ? r.status : "paid") as SaleStatus,
  version: Number(r.version), sha256: String(r.sha256), title: String(r.title), error: str(r.error), createdAt: String(r.created_at), deliveredAt: str(r.delivered_at),
});

const toShopAgent = (r: Row): ShopAgent => ({
  agentId: String(r.agent_id), ownerWallet: String(r.owner_wallet),
  make: { on: Number(r.make_on) === 1, kind: str(r.make_kind), priceWei: big(r.make_price_wei), everyHours: r.make_every_hours === null ? null : Number(r.make_every_hours), perDay: r.make_per_day === null ? null : Number(r.make_per_day), nextAt: str(r.make_next_at) },
  buy: { on: Number(r.buy_on) === 1, maxWei: big(r.buy_max_wei) },
  updatedAt: String(r.updated_at),
});

export function getProduct(productId: string): Product | null {
  const r = getDb().prepare("SELECT * FROM shop_products WHERE product_id = ?").get(productId) as Row | undefined;
  return r ? toProduct(r) : null;
}

export function getSale(saleId: string): Sale | null {
  const r = getDb().prepare("SELECT * FROM shop_sales WHERE sale_id = ?").get(saleId) as Row | undefined;
  return r ? toSale(r) : null;
}

export function shopAgentOf(agentId: string): ShopAgent | null {
  const r = getDb().prepare("SELECT * FROM shop_agents WHERE agent_id = ?").get(agentId) as Row | undefined;
  return r ? toShopAgent(r) : null;
}

export const newId = (prefix: string): string => `${prefix}_${randomBytes(12).toString("base64url")}`;
export const clip = (s: unknown, most: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, most);
export const now = (): string => new Date().toISOString();
/** How a price is written for a person: "0.01 ETH". */
export const priceText = (wei: bigint): string => formatEth(wei);

// ── A price ───────────────────────────────────────────────────────────────────

/**
 * A price as an owner or a caller gives it: "0.01", "0.01 ETH", or a number from a JSON body. Read once into wei from
 * its decimal text, never multiplied as a float, and held to the floor and the ceiling.
 */
export function readPrice(raw: unknown, limits: ShopLimits = shopLimits()): { ok: true; wei: bigint } | { ok: false; why: string } {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/\s*ETH$/i, "") : "";
  const wei = typeof raw === "number" ? toWei(raw) : decimalToWei(text);
  if (wei === null || wei <= 0n) return { ok: false, why: "Give the price in ETH, for example 0.01." };
  if (wei < limits.minWei) return { ok: false, why: `The lowest price is ${formatEth(limits.minWei)}.` };
  if (wei > limits.maxWei) return { ok: false, why: `The highest price is ${formatEth(limits.maxWei)}.` };
  return { ok: true, wei };
}

// ── What may be sold ──────────────────────────────────────────────────────────

/** Is a built page's mark this wallet's own: the wallet itself, or the library mark of a hire signed in with it? */
export function markIsWallet(mark: string | null | undefined, wallet: string): boolean {
  if (!mark || !wallet) return false;
  return mark.toLowerCase() === `w:${wallet.toLowerCase()}` || sameAddress(mark, wallet);
}

/** Is this wallet the agent's owner right now? */
export function ownsAgent(agentId: string, wallet: string | null | undefined): boolean {
  return Boolean(wallet) && sameAddress(getAgentById(agentId)?.walletAddress, wallet);
}

export type Sellable = { ok: true; site: Site; version: number; sha256: string } | { ok: false; why: string };

/**
 * Whether one version of a page may be sold as this agent's by this wallet, and what exactly would be sold. The page
 * must be one this agent built, for this wallet, through Axon; it must be up; the version must still be kept; and its
 * files must pass the build rules today, not only on the day they were built. Asked when a page is listed and again
 * when it is sold.
 */
export function sellable(a: { siteId: string; agentId: string; wallet: string; version?: number }): Sellable {
  const site = getSite(a.siteId);
  if (!site || site.agentId !== a.agentId) return { ok: false, why: "This agent did not build that page." };
  if (!markIsWallet(site.ownerMark, a.wallet)) return { ok: false, why: "Only a page the agent built for you can be sold. A page it built for somebody else is theirs." };
  if (site.status !== "live") return { ok: false, why: "That page was taken down, so it cannot be sold." };
  const version = a.version ?? site.version;
  const kept = versionsOf(site.siteId).find((v) => v.version === version);
  if (!kept) return { ok: false, why: "That version of the page is no longer kept." };
  const files = filesOf(site.siteId, version);
  const checked = checkFiles(files.map((f) => ({ path: f.path, content: f.content })), siteLimits());
  if (!checked.ok) return { ok: false, why: `That page breaks a rule for built pages: ${checked.problems[0]}` };
  return { ok: true, site, version, sha256: kept.sha256 };
}

/** The pages an owner could put up for sale as this agent's: built by it for them, up, and not on sale already. */
export function listablePages(agentId: string, wallet: string, limit = 30): { siteId: string; title: string; version: number; updatedAt: string }[] {
  const w = wallet.toLowerCase();
  const rows = getDb().prepare(
    `SELECT site_id, title, version, updated_at FROM built_sites
     WHERE agent_id = ? AND status = 'live' AND version > 0 AND (LOWER(owner_mark) = ? OR LOWER(owner_mark) = ?)
       AND site_id NOT IN (SELECT site_id FROM shop_products WHERE status = 'listed')
     ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
  ).all(agentId, `w:${w}`, w, limit) as Row[];
  return rows.map((r) => ({ siteId: String(r.site_id), title: String(r.title), version: Number(r.version), updatedAt: String(r.updated_at) }));
}

// ── Listing, changing, taking down ────────────────────────────────────────────

export type Listed = { ok: true; product: Product } | { ok: false; why: string };

/** The words of a listing, checked the way an agent's own words are. */
function wordsProblem(title: string, description: string): string | null {
  if (title.length < 2) return "Give it a title of a few words.";
  if (description.length < 10) return "Say in a sentence what it is.";
  return validateAgentText(`${title}\n${description}`);
}

/**
 * Put a page up for sale. The wallet must own the agent, and the page must be sellable as theirs (see `sellable`).
 * What is sold is the version shown now, by its fingerprint.
 */
export function listProduct(input: { agentId: string; wallet: string; siteId: string; title?: unknown; description?: unknown; price: unknown; madeBy?: MadeBy }, limits: ShopLimits = shopLimits()): Listed {
  if (!ownsAgent(input.agentId, input.wallet)) return { ok: false, why: "Only the agent's owner can sell what it made." };
  const price = readPrice(input.price, limits);
  if (!price.ok) return price;
  const can = sellable({ siteId: input.siteId, agentId: input.agentId, wallet: input.wallet });
  if (!can.ok) return can;
  const title = clip(input.title, SHOP.titleChars) || can.site.title;
  const description = clip(input.description, SHOP.descriptionChars);
  const bad = wordsProblem(title, description);
  if (bad) return { ok: false, why: bad };
  const db = getDb();
  const onSale = (db.prepare("SELECT COUNT(*) n FROM shop_products WHERE agent_id = ? AND status = 'listed'").get(input.agentId) as { n: number }).n;
  if (onSale >= limits.perAgent) return { ok: false, why: `An agent can have ${limits.perAgent} products on sale at once. Take one down first.` };
  const productId = newId("prod"), at = now();
  try {
    db.prepare(
      `INSERT INTO shop_products (product_id, agent_id, seller_wallet, site_id, version, sha256, title, description, price_wei, status, made_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'listed', ?, ?, ?)`,
    ).run(productId, input.agentId, input.wallet.toLowerCase(), can.site.siteId, can.version, can.sha256, title, description, price.wei.toString(), input.madeBy ?? "owner", at, at);
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return { ok: false, why: "That page is on sale already." };
    throw err;
  }
  logger.info("shop.listed", "A product was put up for sale", { productId, agentId: input.agentId, siteId: can.site.siteId, version: can.version, madeBy: input.madeBy ?? "owner" });
  void syncToTurso();
  return { ok: true, product: getProduct(productId)! };
}

/**
 * Change a product's price, title or words. A new price takes over at once; the one before is still honoured for a
 * short while, for a buyer whose payment was on its way while it changed.
 */
export function changeProduct(productId: string, wallet: string, change: { price?: unknown; title?: unknown; description?: unknown }, limits: ShopLimits = shopLimits()): Listed {
  const p = getProduct(productId);
  if (!p || !ownsAgent(p.agentId, wallet)) return { ok: false, why: "There is no such product of yours." };
  if (p.status !== "listed") return { ok: false, why: "That product was taken down. List the page again to sell it." };
  const title = change.title === undefined ? p.title : clip(change.title, SHOP.titleChars);
  const description = change.description === undefined ? p.description : clip(change.description, SHOP.descriptionChars);
  const bad = wordsProblem(title, description);
  if (bad) return { ok: false, why: bad };
  let priceWei = p.priceWei;
  if (change.price !== undefined) {
    const price = readPrice(change.price, limits);
    if (!price.ok) return price;
    priceWei = price.wei;
  }
  const at = now();
  const moved = priceWei !== p.priceWei;
  getDb().prepare(
    `UPDATE shop_products SET title = ?, description = ?, price_wei = ?, prev_price_wei = CASE WHEN ? THEN price_wei ELSE prev_price_wei END,
       price_changed_at = CASE WHEN ? THEN ? ELSE price_changed_at END, updated_at = ? WHERE product_id = ?`,
  ).run(title, description, priceWei.toString(), moved ? 1 : 0, moved ? 1 : 0, at, at, productId);
  void syncToTurso();
  return { ok: true, product: getProduct(productId)! };
}

/** Take a product off sale. Whoever bought it keeps what they bought. */
export function takeDown(productId: string, wallet: string): Listed {
  const p = getProduct(productId);
  if (!p || !ownsAgent(p.agentId, wallet)) return { ok: false, why: "There is no such product of yours." };
  if (p.status === "listed") {
    getDb().prepare("UPDATE shop_products SET status = 'down', updated_at = ? WHERE product_id = ?").run(now(), productId);
    logger.info("shop.taken_down", "A product was taken off sale", { productId, agentId: p.agentId });
    void syncToTurso();
  }
  return { ok: true, product: getProduct(productId)! };
}

/**
 * Whether a product can be bought right now: on sale, its page up, its version still kept. Why not, in words, when it
 * cannot. Its files are checked against the build rules again when it is sold (`sellable`).
 */
export function availability(p: Product): { ok: true } | { ok: false; why: string } {
  if (p.status !== "listed") return { ok: false, why: "This product was taken off sale." };
  const site = getSite(p.siteId);
  if (!site || site.status !== "live") return { ok: false, why: "This product's page was taken down, so it is not for sale." };
  if (!versionsOf(p.siteId).some((v) => v.version === p.version)) return { ok: false, why: "This product's files are no longer kept." };
  return { ok: true };
}

// ── How a product is shown ────────────────────────────────────────────────────

/** A product as anybody may see it: what it is, its price, how often it sold, and the address of its live page. */
export interface ProductView {
  productId: string;
  agentId: string;
  agentName: string;
  title: string;
  description: string;
  /** "0.01 ETH", and the same amount in wei as text, so a caller never has to read money from a float */
  price: string;
  priceWei: string;
  sold: number;
  /** made and listed by the agent on its own, not by its owner */
  madeByAgent: boolean;
  version: number;
  /** the fingerprint of what a buyer receives: every file's name and hash, as the receipt will show it */
  fingerprint: string;
  /** the live page, at the version that is sold */
  preview: string;
  available: boolean;
  listedAt: string;
}

export function productView(p: Product, origin = ""): ProductView {
  return {
    productId: p.productId, agentId: p.agentId, agentName: getAgentById(p.agentId)?.name ?? p.agentId, title: p.title, description: p.description,
    price: formatEth(p.priceWei), priceWei: p.priceWei.toString(), sold: p.sold, madeByAgent: p.madeBy === "agent", version: p.version, fingerprint: p.sha256,
    preview: `${origin.replace(/\/+$/, "")}/s/${p.siteId}?v=${p.version}`, available: availability(p).ok, listedAt: p.createdAt,
  };
}

/** An agent's products, newest first: on sale only, or every one (for its owner). Products whose page is down are left out of the shop. */
export function productsOfAgent(agentId: string, o: { all?: boolean; limit?: number } = {}): Product[] {
  const limit = Math.max(1, Math.min(SHOP.most, Math.floor(o.limit ?? SHOP.most)));
  const rows = getDb().prepare(
    `SELECT p.* FROM shop_products p JOIN built_sites s ON s.site_id = p.site_id
     WHERE p.agent_id = ? AND (? = 1 OR (p.status = 'listed' AND s.status = 'live')) ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`,
  ).all(agentId, o.all ? 1 : 0, limit) as Row[];
  return rows.map(toProduct);
}

export type ShopSort = "newest" | "sold" | "price";
export const SHOP_SORTS: readonly ShopSort[] = ["newest", "sold", "price"];

/**
 * What is for sale across every agent: on sale, its page up. Newest first, best selling first, or cheapest first; with
 * `q`, only products whose title or words say it.
 */
export function productsForSale(o: { q?: string | null; sort?: string | null; limit?: number; agentId?: string | null } = {}): Product[] {
  const limit = Math.max(1, Math.min(SHOP.most, Math.floor(o.limit ?? SHOP.page)));
  const sort = (SHOP_SORTS as readonly string[]).includes(o.sort ?? "") ? (o.sort as ShopSort) : "newest";
  const q = clip(o.q, 80).toLowerCase().replace(/[%_\\]/g, "");
  // price is kept as whole wei in text: ordered by its length first, then as text, which is the order of the numbers
  const order = sort === "sold" ? "p.sold DESC, p.created_at DESC" : sort === "price" ? "LENGTH(p.price_wei) ASC, p.price_wei ASC, p.created_at DESC" : "p.created_at DESC, p.rowid DESC";
  const rows = getDb().prepare(
    `SELECT p.* FROM shop_products p JOIN built_sites s ON s.site_id = p.site_id
     WHERE p.status = 'listed' AND s.status = 'live' AND (? IS NULL OR p.agent_id = ?)
       AND (? = '' OR LOWER(p.title) LIKE '%' || ? || '%' OR LOWER(p.description) LIKE '%' || ? || '%')
     ORDER BY ${order} LIMIT ?`,
  ).all(o.agentId ?? null, o.agentId ?? null, q, q, q, limit) as Row[];
  return rows.map(toProduct);
}

// ── Reporting a product ───────────────────────────────────────────────────────

export const PRODUCT_REPORT_REASONS = ["scam", "not_delivered", "impersonation", "harmful", "illegal", "other"] as const;
export type ProductReportReason = (typeof PRODUCT_REPORT_REASONS)[number];

/**
 * Somebody says a product should not be sold, through the reports that already exist. What it is counts against its
 * page (./agentSites reportSite): enough different people hide the page, and with it the product. Somebody signed in
 * also files a report against the agent in the moderators' queue (./abuse), naming the product; that is where a
 * purchase that did not arrive goes, since it says nothing about what the page is.
 */
export function reportProduct(productId: string, r: { reason: string; details?: string; reporter: string; wallet?: string | null }): { ok: boolean; hidden: boolean; filed: boolean; why?: string } {
  const p = getProduct(productId);
  if (!p) return { ok: false, hidden: false, filed: false, why: "There is no such product." };
  const reason = (PRODUCT_REPORT_REASONS as readonly string[]).includes(r.reason) ? (r.reason as ProductReportReason) : "other";
  if (reason === "not_delivered" && !r.wallet) return { ok: false, hidden: false, filed: false, why: "Sign in with the wallet that paid to report a purchase that did not arrive." };
  const details = clip(r.details, 400);
  const page = reason === "not_delivered" ? null : reportSite(p.siteId, { reason, details: `product ${p.productId}${details ? `: ${details}` : ""}`, reporter: r.reporter });
  let filed = false;
  if (r.wallet) {
    const abuse = reason === "not_delivered" ? "non_delivery" : reason === "scam" ? "scam" : reason === "other" ? "other" : "abuse";
    filed = fileReport({ targetAgent: p.agentId, reporter: r.wallet, reason: abuse, details: `Product ${p.productId} (${p.title})${details ? `: ${details}` : ""}` }).success;
  }
  logger.info("shop.reported", "A product was reported", { productId, reason, hidden: Boolean(page?.hidden), filed });
  return { ok: true, hidden: Boolean(page?.hidden), filed };
}
