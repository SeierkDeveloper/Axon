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
import { decimalToWei, formatEth, toWei } from "./money";
import { sitesEnabled } from "./agentSites";

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
    makeDaily: num(env.AGENT_SHOP_MAKE_DAILY_MAX, 50, 0, 5000),
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
const big = (v: unknown): bigint | null => (v === null || v === undefined ? null : toWei(String(v)));
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
