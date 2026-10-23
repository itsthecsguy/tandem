import { execFile } from "node:child_process";

import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

/**
 * In development there's no Worker to finish GitHub sign-in, so the dev server
 * hands this page the GitHub CLI's token instead. Only same-origin requests
 * with Tandem's header get it, so other sites open in the browser can't.
 */
function devGitHubToken(): Plugin {
  return {
    name: "tandem-dev-github-token",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/gh-token", (req, res) => {
        if (req.headers["sec-fetch-site"] !== "same-origin" || req.headers["x-tandem-dev"] !== "1") {
          res.statusCode = 403;
          res.end();
          return;
        }
        execFile("gh", ["auth", "token"], (err, stdout) => {
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify({ token: err ? null : stdout.trim() || null }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devGitHubToken()],
  server: {
    port: 5317,
    strictPort: true,
    // `npm run dev:helper` runs the UI against the local helper instead.
    proxy: process.env.TANDEM_HELPER ? { "/api": "http://127.0.0.1:4317" } : undefined,
  },
});
