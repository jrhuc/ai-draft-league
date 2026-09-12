import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { App } from "@/App";
import { SeasonProvider } from "@/lib/season-context";

const LiveRunPage = import.meta.env.DEV ? lazy(() => import("@/routes/live-run")) : null;
const LivePage = import.meta.env.DEV ? lazy(() => import("@/routes/live")) : null;

export function SiteRouter() {
  return (
    <Routes>
      {LivePage ? (
        <Route
          path="/live"
          element={
            <Suspense fallback={<div className="boot">Loading runs…</div>}>
              <LivePage />
            </Suspense>
          }
        />
      ) : null}
      {LiveRunPage ? (
        <Route
          path="/live/:runId"
          element={
            <Suspense fallback={<div className="boot">Loading live watch…</div>}>
              <LiveRunPage />
            </Suspense>
          }
        />
      ) : null}
      <Route
        path="*"
        element={
          <SeasonProvider>
            <App />
          </SeasonProvider>
        }
      />
    </Routes>
  );
}
