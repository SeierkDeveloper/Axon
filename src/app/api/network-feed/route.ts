import { type NextRequest } from "next/server";
import { publicJson } from "@/lib/httpCache";
import { getRecentPosts } from "@/lib/telegram";
import { getNetworkStats } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const posts = getRecentPosts(20);
  const stats = getNetworkStats();
  return publicJson(req, {
    posts,
    stats: {
      totalAgents: stats.agents.total,
      activeAgents: stats.agents.active,
      tasksCompleted: stats.tasks.completed,
      ethTransacted: stats.payments.totalEthTransacted,
    },
  });
}
