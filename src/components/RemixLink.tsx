"use client";

import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";

// "Remix it" on a Studio agent's page, for everyone but the agent's owner: their own agent is changed in Studio, and a
// remix of it would only be refused.
export default function RemixLink({ agentId, owner }: { agentId: string; owner: string | null }) {
  const { address } = useWallet();
  if (owner && address && owner.toLowerCase() === address.toLowerCase()) return null;
  return (
    <Link href={`/studio?remix=${encodeURIComponent(agentId)}`} title="Copy this agent into Agent Studio, change it and publish your own. The original earns 10% of every hire of your remix." className="rounded-full border border-gray-200 px-3 py-1 text-gray-600 transition hover:border-gray-900 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:border-white dark:hover:text-white">
      Remix it
    </Link>
  );
}
