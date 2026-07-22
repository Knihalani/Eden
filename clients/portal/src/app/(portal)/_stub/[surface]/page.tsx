import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ComingSoonPanel } from "@/components/shell/coming-soon-panel";
import {
  STUB_SURFACE_IDS,
  SURFACE_DOC_HINT,
} from "@/lib/sidebar-config";

export default async function StubSurfacePage({
  params,
}: {
  params: Promise<{ surface: string }>;
}) {
  const { surface } = await params;

  if (
    surface === "dashboard" ||
    !(STUB_SURFACE_IDS as readonly string[]).includes(surface)
  ) {
    notFound();
  }

  const tLeaves = await getTranslations("nav.leaves");
  let label: string;
  try {
    label = tLeaves(surface as Parameters<typeof tLeaves>[0]);
  } catch {
    label = surface;
  }

  return (
    <ComingSoonPanel
      surfaceId={surface}
      surfaceLabel={label}
      docFile={SURFACE_DOC_HINT[surface]}
    />
  );
}
