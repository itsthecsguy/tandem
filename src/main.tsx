import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initApi } from "./api";
import { App } from "./App";
import "./styles.css";

initApi().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
