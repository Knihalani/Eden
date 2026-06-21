import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  async redirects() {
    return [
      // Legacy /jobs URL renamed to /eval-harnesses.
      // When the eval-pipeline feature flag is off, /eval-harnesses will
      // 404 (handled by the new page guard); the redirect itself still
      // happens, which is the desired behavior: old links always land
      // users on the new canonical URL first.
      {
        source: "/jobs",
        destination: "/eval-harnesses",
        permanent: false,
      },
      {
        source: "/jobs/:path*",
        destination: "/eval-harnesses/:path*",
        permanent: false,
      },
      // Auth cutover to Clerk (June 17, 2026). The old /login and
      // /signup still render the same Clerk chrome, but Clerk's own
      // portal-style flows use /sign-in and /sign-up — sending old
      // links straight there avoids a stale "Sign up" cross-link
      // that points back to the legacy path.
      {
        source: "/login",
        destination: "/sign-in",
        permanent: false,
      },
      {
        source: "/login/:path*",
        destination: "/sign-in/:path*",
        permanent: false,
      },
      {
        source: "/signup",
        destination: "/sign-up",
        permanent: false,
      },
      {
        source: "/signup/:path*",
        destination: "/sign-up/:path*",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
