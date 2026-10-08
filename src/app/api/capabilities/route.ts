import { type NextRequest } from "next/server";
import { publicJson } from "@/lib/httpCache";
import { getAllCapabilities } from "@/lib/capabilities";

// GET /api/capabilities — list all capabilities with agent counts
export async function GET(req: NextRequest) {
  const capabilities = getAllCapabilities();
  return publicJson(req, { capabilities, total: capabilities.length });
}
