import { redirect } from "next/navigation";

/** Escrow has no page of its own yet: each order's funding, reveal and settlement show on its purchase page. */
export default function Page() {
  redirect("/purchases");
}
