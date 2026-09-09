import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite-plus";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Dev-only live watch: lists local league runs and serves freshly built season
 * bundles for them, so the regular spectator pages can render a run as it
 * plays. `apply: "serve"` keeps every trace of this out of production builds —
 * the deployed site consumes only the exported season-bundle.json.
 */
function liveWatch(): Plugin {
  return {
    name: "live-watch",
    apply: "serve",
    configureServer(server) {
      const tracesDist = fileURLToPath(new URL("../traces/dist", import.meta.url));
      server.middlewares.use("/traces", (req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const file = path.join(tracesDist, "traces", path.normalize(pathname));
        if (!file.startsWith(path.join(tracesDist, "traces")) || !fs.existsSync(file)) {
          next();
          return;
        }
        res.setHeader(
          "content-type",
          file.endsWith(".gz") ? "application/gzip" : "application/json",
        );
        fs.createReadStream(file).pipe(res);
      });
      server.middlewares.use("/api/watch", (req, res) => {
        void (async () => {
          const respond = (code: number, body: JsonValue): void => {
            res.statusCode = code;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
          };
          let league: typeof import("league/server");
          try {
            league = await import("league/server");
          } catch {
            respond(500, { error: "league dist missing — run `vp run league#build` first" });
            return;
          }
          const url = new URL(req.url ?? "/", "http://localhost").pathname;
          if (url === "/runs") {
            respond(200, league.listExternalRuns(league.RUNS_DIR));
            return;
          }
          const match =
            /^\/runs\/([A-Za-z0-9._-]+)\/(bundle|traces\/manifest|traces\/([A-Za-z0-9._-]+)\/game-(\d+))$/.exec(
              url,
            );
          if (!match?.[1]) {
            respond(404, { error: "unknown watch endpoint" });
            return;
          }
          try {
            const exported = league.buildSeasonExport({
              recordsPath: league.RESULTS_PATH,
              runsDir: league.RUNS_DIR,
              runId: match[1],
              title: `Live · ${match[1].slice(-8)}`,
              releasedThroughWeek: "all",
            });
            if (match[2] === "bundle") {
              respond(200, exported.bundle);
              return;
            }
            if (match[2] === "traces/manifest") {
              respond(200, exported.manifest);
              return;
            }
            const game = exported.traces.get(match[3] ?? "")?.[Number(match[4]) - 1];
            if (game) respond(200, game);
            else respond(404, { error: "that game has no released traces" });
          } catch (error) {
            respond(409, { error: error instanceof Error ? error.message : String(error) });
          }
        })();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), liveWatch()],
  resolve: {
    alias: {
      "@": "/src",
      ui: fileURLToPath(new URL("../../packages/ui/src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts?(x)"],
    environmentOptions: {
      happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: true } },
    },
  },
});
