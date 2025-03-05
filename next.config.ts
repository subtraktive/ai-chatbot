import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    ppr: true,
  },
  images: {
    remotePatterns: [
      {
        hostname: 'avatar.vercel.sh',
        protocol: "https",
      },
      {
        protocol: "https",
        hostname: "*.public.blob.vercel-storage.com", // All Vercel Blob subdomains
      },
    ],
  },
};

export default nextConfig;
