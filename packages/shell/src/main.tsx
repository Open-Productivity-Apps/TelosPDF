import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Bundled UI font (Inter Variable, SIL OFL-1.1) — self-hosted woff2, no
// network. The workbench is metric-tuned at 13px, and the platform UI fonts
// (SF Pro vs Segoe UI vs whatever the Linux box has) differ enough in
// x-height and vertical centring to misalign button and segmented-control
// labels. Shipping one font renders the app identically everywhere.
import "@fontsource-variable/inter";
import "flag-icons/css/flag-icons.min.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
