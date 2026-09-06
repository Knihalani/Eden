import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SEE_PENDING } from "../../account/home";
import { productGate } from "../../account/route";
import { TourPanel } from "../../home/tour";

export const metadata = {
  title: "Tour — Eden",
};

export default async function TourPage() {
  const session = await auth(SEE_PENDING);
  const dest = productGate("/tour", session);
  if (dest) redirect(dest);
  return <TourPanel />;
}
