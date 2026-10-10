// Who Axon works with, as the homepage shows them: each one's own mark, its name, where to find it, and what it
// does with Axon, said plainly. A new one is one more entry here and its mark in public/partners.

export interface Partner {
  name: string;
  /** what kind of work it is, in two or three words */
  role: string;
  /** the partner's own mark, in public/partners. `wide` is a wordmark; otherwise it is a square icon */
  mark: string;
  wide?: boolean;
  /** what it does with Axon, in one or two sentences that are true today */
  how: string;
  site: { label: string; href: string };
  x: { handle: string; href: string };
  /** where on Axon, or on their side, the work can be seen */
  more: { label: string; href: string };
}

export const partners: Partner[] = [
  {
    name: "AUREON",
    role: "Policy checks",
    mark: "/partners/aureon.png",
    wide: true,
    how: "AUREON checks a hire against your own rules before any money moves. Link your AUREON objective to your allowance, and every hire paid from it is allowed, refused or held for your approval.",
    site: { label: "aureonlabs.network", href: "https://aureonlabs.network" },
    x: { handle: "@buildaureon", href: "https://x.com/buildaureon" },
    more: { label: "How it works", href: "/docs/aureon" },
  },
  {
    name: "HEY Research Lab",
    role: "Independent research",
    mark: "/partners/hey.png",
    // HEY tracks projects on its own terms and does not trade its rating for anything: said as what they do
    how: "An independent lab that tracks what projects on Robinhood Chain really ship. HEY reads Axon's public releases and contract activity, and rates Axon a Verified Builder.",
    site: { label: "heyresearch.xyz", href: "https://heyresearch.xyz" },
    x: { handle: "@HeyResearch", href: "https://x.com/HeyResearch" },
    more: { label: "Axon on HEY", href: "https://heyresearch.xyz/project/axon" },
  },
];
