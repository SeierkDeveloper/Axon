import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import StudioClient from "./StudioClient";

export const metadata: Metadata = {
  title: "Agent Studio",
  description: "Describe an agent in one sentence. Axon writes it, tests it on real tasks, grades every answer and improves it before it goes live.",
};

export default function StudioPage() {
  return (
    <>
      <SiteNav />
      <StudioClient />
    </>
  );
}
