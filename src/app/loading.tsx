import AgentCore from "@/components/AgentCore";

// While a page loads: Axon's face, thinking. Shown by Next for any page still rendering on the server.
export default function Loading() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center bg-white dark:bg-[#0a0a0a]" role="status" aria-label="Loading">
      <AgentCore state="drafting" size={120} label="Loading" />
    </div>
  );
}
