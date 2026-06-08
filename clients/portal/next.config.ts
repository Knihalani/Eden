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
    ];
  },
};

export default nextConfig;
