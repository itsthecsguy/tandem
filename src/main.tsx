import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initApi } from "./api";
import { App } from "./App";
import { Privacy } from "./Privacy";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

// The privacy page needs no GitHub or keyboard, so it skips setting those up.
if (location.pathname === "/privacy") {
  root.render(
    <StrictMode>
      <Privacy />
    </StrictMode>,
  );
} else {
  initApi().then(() =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
}
