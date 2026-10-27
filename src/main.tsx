import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 桌面版自我檢查（WORDBLADE_SELFTEST 環境變數，見 scripts/desktop-selftest/run.ps1）
const selftest = new URLSearchParams(window.location.search).get("selftest");
if (selftest) void import("./selftest").then((m) => m.runSelftest(selftest));
