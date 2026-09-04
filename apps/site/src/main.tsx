import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppErrorBoundary } from "ui/components/app-error";
import { App } from "@/App";
import { SeasonProvider } from "@/lib/season-context";

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "ui/styles/globals.css";
import "ui/styles/motion.css";
import "ui/styles/teams.css";
import "ui/styles/matches.css";
import "ui/styles/bracket.css";
import "./styles/season.css";
import "./styles/draft.css";
import "./styles/transactions.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <SeasonProvider>
          <App />
        </SeasonProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
