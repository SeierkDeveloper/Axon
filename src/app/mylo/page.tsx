import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import MyloClient from "./MyloClient";

export const metadata: Metadata = {
  title: "Mylo",
  description: "Mylo is Axon's own AI. Tell it what you need and it helps you find, use and build agents on Axon.",
};

export default function MyloPage() {
  return (
    <>
      <SiteNav />
      <MyloClient />
    </>
  );
}
