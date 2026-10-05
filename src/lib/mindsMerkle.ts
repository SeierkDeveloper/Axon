// Agent Minds: the proof behind a reward.
//
// A reward is one number of ETH and one root. Each holder's share is a leaf: (index, account, amount). The treasury
// checks a claim against the root with OpenZeppelin's MerkleProof, so the tree here is built the way that library
// reads one: a leaf is hashed twice, and every pair is sorted before it is hashed together.

import { encodeAbiParameters, keccak256, concat, type Hex } from "viem";

export interface Share { index: number; account: `0x${string}`; amount: bigint }

export function leafOf(s: Share): Hex {
  return keccak256(concat([keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }], [BigInt(s.index), s.account, s.amount]))]));
}

const pair = (a: Hex, b: Hex): Hex => (BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** The root of these shares and the proof for each, in the order given. One share is its own root, with an empty proof. */
export function merkle(shares: Share[]): { root: Hex; proofs: Hex[][] } {
  if (!shares.length) throw new Error("a reward needs at least one share");
  let layer = shares.map(leafOf);
  const proofs: Hex[][] = shares.map(() => []);
  // where each share's node sits in the layer being folded
  let at = shares.map((_, i) => i);
  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? pair(layer[i], layer[i + 1]) : layer[i]);
    at = at.map((pos, share) => {
      const sibling = pos ^ 1;
      if (sibling < layer.length) proofs[share].push(layer[sibling]);
      return pos >> 1;
    });
    layer = next;
  }
  return { root: layer[0], proofs };
}

/** Check a proof the way the treasury does. */
export function verify(root: Hex, s: Share, proof: Hex[]): boolean {
  return proof.reduce((h, p) => pair(h, p), leafOf(s)) === root;
}

/**
 * Divide `total` among holders by what each holds. Shares too small to be worth their gas are left out and what they
 * would have had goes to the rest; the shares add up to `total` to the wei (the last wei of rounding goes to the
 * largest holder). At most `max` holders, the largest first.
 */
export function divide(total: bigint, holders: { account: string; balance: bigint }[], minShare: bigint, max = 1000): Share[] {
  let in_ = holders.filter((h) => h.balance > 0n).sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : a.account.localeCompare(b.account))).slice(0, max);
  // leaving a small holder out raises everybody else's share, so this settles in a few rounds
  for (let round = 0; round < 20; round++) {
    const sum = in_.reduce((s, h) => s + h.balance, 0n);
    if (sum === 0n) return [];
    const kept = in_.filter((h) => (total * h.balance) / sum >= minShare);
    if (kept.length === in_.length) break;
    in_ = kept;
  }
  const sum = in_.reduce((s, h) => s + h.balance, 0n);
  if (!in_.length || sum === 0n) return [];
  const amounts = in_.map((h) => (total * h.balance) / sum);
  amounts[0] += total - amounts.reduce((s, a) => s + a, 0n);
  return in_.map((h, index) => ({ index, account: h.account.toLowerCase() as `0x${string}`, amount: amounts[index] }));
}
