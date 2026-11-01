import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parentCsp, runtimeHash } from "../../deploy/csp.mjs";
import { cspHash } from "./sandboxFrame";

// 父頁 CSP（spec §5.7）：沙盒 srcdoc iframe 繼承父頁 CSP，父頁要放行同一個啟動腳本雜湊。
// 改了 iframeRuntime.js 之後 tauri.conf.json 的 CSP 要跟著更新（node deploy/csp.mjs --desktop），這裡會先失敗提醒。
describe("父頁 CSP", () => {
  it("建置時算的啟動腳本雜湊＝執行時 sandboxFrame 算的", async () => {
    const runtime = readFileSync(new URL("./iframeRuntime.js", import.meta.url), "utf8").replace(/\r\n?/g, "\n");
    expect(runtimeHash()).toBe(await cspHash(runtime));
  });

  it("tauri.conf.json 的 CSP 和 deploy/csp.mjs 一致（不一致就跑 node deploy/csp.mjs --desktop（與 --desktop --dev）更新）", () => {
    const conf = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    expect(conf.app.security.csp).toBe(parentCsp({ desktop: true }));
    // devCsp 設 null 會被當成沒設、開發時套用正式 CSP（擋掉 React 的行內前置腳本），所以另給一份開發用的
    expect(conf.app.security.devCsp).toBe(parentCsp({ desktop: true, dev: true }));
  });

  it("擋 iframe 自我導航、只放行 blob Worker、script-src 不放行 blob 與 inline", () => {
    const csp = parentCsp();
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("worker-src blob:");
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/);
    expect(csp).not.toContain("asset.localhost");
  });
});
