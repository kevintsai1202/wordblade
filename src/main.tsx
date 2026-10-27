import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// 字幕字型（D37：隨程式打包，預覽與匯出一致）：英文 Inter、中文 Noto Sans TC（分塊，用到的字才下載）
import "@fontsource/inter/700.css";
import "@fontsource/noto-sans-tc/700.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 桌面版自我檢查（WORDBLADE_SELFTEST 環境變數，見 scripts/desktop-selftest/run.ps1）
const selftest = new URLSearchParams(window.location.search).get("selftest");
if (selftest) void import("./selftest").then((m) => m.runSelftest(selftest));
