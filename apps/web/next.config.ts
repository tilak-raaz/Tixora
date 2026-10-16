import path from 'node:path';
import type { NextConfig } from 'next';

/** Where the Next.js server reaches the API, for the rewrite below and server-side fetches. */
const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

/** The monorepo root (next runs from apps/web), where the lockfile and @bmt/* packages live. */
const repoRoot = path.resolve(process.cwd(), '../..');

const nextConfig: NextConfig = {
  // The end-to-end tests build into their own folder, so they can run beside `next dev`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // The Docker image runs Next's standalone server, which carries only the files it needs
  // (infra/docker/web.Dockerfile). Local builds keep the usual output for `next start`.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  reactStrictMode: true,
  // The floating Next.js badge in development; off so screenshots show only the app.
  devIndicators: false,
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
