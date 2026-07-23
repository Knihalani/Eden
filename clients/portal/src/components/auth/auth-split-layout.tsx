import { EdenLogo } from "@/components/ds/eden-logo";

interface AuthSplitLayoutProps {
  brandPanel?: React.ReactNode;
  children: React.ReactNode;
}

export function AuthSplitLayout({ children }: AuthSplitLayoutProps) {
  return (
    <div className="auth-shell flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-7 flex flex-col items-center gap-3">
          <EdenLogo size={40} priority />
          <p className="type-title !text-[1rem] tracking-[-0.02em]">eden</p>
        </div>
        {children}
      </div>
    </div>
  );
}
