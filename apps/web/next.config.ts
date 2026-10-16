import type { NextConfig } from 'next';

/** Where the Next.js server reaches the API, for the rewrite below and server-side fetches. */
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // @bmt/shared ships TypeScript source.
  transpilePackages: ['@bmt/shared'],
  // One origin for the browser (ADR 0012): /api/* is forwarded to the API, so the auth cookie is
  // first-party and there is no CORS. In production nginx routes /api/* before it reaches Next.js.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
};

export default nextConfig;
