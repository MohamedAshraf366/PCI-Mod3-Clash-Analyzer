import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Ship smaller client bundles by only pulling in the modules actually used
  // from these large libraries, instead of the whole package.
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts", "date-fns", "@radix-ui/react-icons"],
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
