import { AuthFormCard } from "@/components/auth/auth-form-card";
import { AuthSplitLayout } from "@/components/auth/auth-split-layout";
import { InviteAcceptPanel } from "@/components/auth/invite-accept-panel";

export const metadata = { title: "Invitation · Eden" };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <AuthSplitLayout>
      <AuthFormCard>
        <InviteAcceptPanel token={token} />
      </AuthFormCard>
    </AuthSplitLayout>
  );
}
