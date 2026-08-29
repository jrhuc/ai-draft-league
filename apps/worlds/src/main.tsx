import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "@/App";
import { AppErrorBoundary } from "@/components/app-error";
import { TournamentProvider } from "@/lib/context";

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/globals.css";
import "./styles/motion.css";
import "./styles/teams.css";
import "./styles/matches.css";
import "./styles/playoffs.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <TournamentProvider>
          <App />
        </TournamentProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
