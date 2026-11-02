import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initApi } from "./api";
import { App } from "./App";
import { Changelog } from "./Changelog";
import { Privacy } from "./Privacy";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

// These pages need no GitHub or keyboard, so they skip setting those up.
const Page = { "/privacy": Privacy, "/changelog": Changelog }[location.pathname];

if (Page) {
  root.render(
    <StrictMode>
      <Page />
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
