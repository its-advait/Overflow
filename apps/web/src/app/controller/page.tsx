import { ShieldCheck } from "lucide-react";
import { ControllerRequests } from "@/components/controller-requests";

/** Overflow service base URL (public, read at build time). */
const SERVICE_URL = process.env["NEXT_PUBLIC_SERVICE_URL"] ?? "http://localhost:4000";

export default function ControllerPage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-12">
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
        <ShieldCheck className="size-6" aria-hidden />
        Controller requests
      </h1>
      <ControllerRequests serviceUrl={SERVICE_URL} />
    </main>
  );
}
