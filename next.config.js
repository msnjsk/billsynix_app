/**
 * BUILD_TARGET=desktop (used by `npm run desktop:*`) exports the app as static files into
 * `out/`, which the Electron shell in `electron/` serves offline. The normal web build is unchanged.
 */
const isDesktop = process.env.BUILD_TARGET === 'desktop';

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    tsconfigPath: './tsconfig.json',
  },
  ...(isDesktop
    ? {
        output: 'export',
        // There is no image-optimising server inside the desktop app.
        images: { unoptimized: true },
      }
    : {}),
};

module.exports = nextConfig;
