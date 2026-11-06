import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * Local development runs every GovZones Worker in one workerd instance so D1, KV, R2, Queues,
 * Durable Objects and RPC service bindings behave as in production. The web Worker's dev gateway
 * maps hosts to Workers:
 *   http://govzones.localhost:5173           public site
 *   http://accounts.govzones.localhost:5173  account / enrollment Worker
 *   http://vote.govzones.localhost:5173      cookie-free anonymous ballot Worker
 *   http://admin.govzones.localhost:5173     admin console (dev bypass)
 * Auxiliary Workers are deployed separately with Wrangler, so they are loaded only by the dev server
 * (a build for --env preview/staging/production never reads their configs).
 */
export default defineConfig(({ command }) => ({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      persistState: { path: ".wrangler/state" },
      auxiliaryWorkers: command !== "serve" ? [] : [
        { configPath: "./workers/groups/wrangler.jsonc", devOnly: true },
        { configPath: "./workers/accounts/wrangler.jsonc", devOnly: true },
        { configPath: "./workers/ballot/wrangler.jsonc", devOnly: true },
        { configPath: "./workers/aggregator/wrangler.jsonc", devOnly: true },
        { configPath: "./workers/admin/wrangler.jsonc", devOnly: true },
      ],
    }),
    tailwindcss(),
    reactRouter(),
  ],
  // cors: false — CORS (including credentialed preflights to the account host) is decided by the Workers.
  server: { host: "127.0.0.1", port: 5173, strictPort: true, cors: false },
  worker: { format: "es" },
  resolve: { tsconfigPaths: true },
}));
