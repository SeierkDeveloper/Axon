import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A page opened in the last half minute is drawn again from what the browser already holds, so going back and
  // forth between sections asks the server nothing. Live figures on a page keep reading themselves on their own
  // timers, and anything that changes data calls for a fresh page itself.
  experimental: { staleTimes: { dynamic: 30, static: 180 } },
  // Enable standalone output for Docker — copies only the minimal files needed
  output: process.env.DOCKER_BUILD === "1" ? "standalone" : undefined,
  // libsql loads its native binding via a computed `require(`@libsql/${target}`)`
  // (see node_modules/libsql/index.js), which Next's file tracing can't follow —
  // so the platform package is dropped from the standalone bundle and the server
  // crashes at startup when instrumentation imports the Turso client. Force the
  // platform binaries into the trace: musl Linux for the Alpine runtime, plus the
  // darwin variants so a standalone build is also runnable locally. Globs that
  // match no installed package (the build host only installs its own platform's
  // binary) are simply ignored.
  //
  // The share cards read their font off disk. readFileSync on a path the bundler cannot see is
  // invisible to tracing in the same way, so src/ is left out of the standalone output and every
  // opengraph-image route answers 500 in production while working perfectly in development.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@libsql/linux-x64-musl/**/*",
      "./node_modules/@libsql/linux-arm64-musl/**/*",
      "./node_modules/@libsql/darwin-x64/**/*",
      "./node_modules/@libsql/darwin-arm64/**/*",
      "./src/assets/fonts/**/*",
    ],
  },
  // litesvm is a native module (AgenC's local marketplace sandbox, dev-only) and
  // the marketplace SDK's /testing entry loads it — keep both out of the webpack
  // bundle; they resolve from node_modules at runtime where available (the
  // cross-listing code degrades gracefully when they aren't).
  serverExternalPackages: ["litesvm", "@tetsuo-ai/marketplace-sdk"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // The microphone is refused to every page unless voice is switched on for this deployment, and then it is
          // allowed to this site's own pages only. Read when the site is built, like every header here.
          { key: "Permissions-Policy", value: `camera=(), microphone=(${(process.env.AGENT_VOICE ?? "").trim().toLowerCase() === "on" ? "self" : ""}), geolocation=()` },
          // Only send HSTS over real HTTPS — avoids locking out local dev
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
            : []),
        ],
      },
      {
        // API routes are consumed by agents/SDKs — allow cross-origin reads but
        // lock down scripts/frames to prevent XSS escalation via the dashboard.
        source: "/api/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'none'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
      {
        // Dashboard and docs pages — tighter CSP than a typical SPA because
        // we control all assets. Inline styles/scripts are forbidden.
        // A built page's own address (/s/...) is left out: it sends a stricter policy of its own, which is part of
        // the seal around what an agent built (src/lib/siteViewer.ts), and two policies would only blur that.
        source: "/((?!api|s/).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js hydration requires 'unsafe-inline'; Turbopack dev also needs 'unsafe-eval'
              isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'", // Tailwind inlines via style attr
              "img-src 'self' data: https: blob:",
              "font-src 'self'",
              // The Phase 10 Open World (React Three Fiber / drei) spins up blob
              // workers and loads generated textures from blob/data URLs.
              "worker-src 'self' blob:",
              // Allow the Solana RPC (Helius) for Axon Build's on-chain payment —
              // the browser fetches the blockhash and confirms the tx over https/wss.
              // ws:/wss: also cover the Phase 10 realtime presence server, whose
              // host is configured per-deploy via NEXT_PUBLIC_PRESENCE_URL.
              "connect-src 'self' https://*.helius-rpc.com wss://*.helius-rpc.com ws: wss:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
