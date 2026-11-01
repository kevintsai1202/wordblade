// deploy/csp.mjs 的型別（vite.config.ts 與單元測試引用）
/** 沙盒啟動腳本的 CSP sha256 來源表達式 */
export function runtimeHash(): string;
/** 父頁 CSP；desktop：Windows 版（加素材協定） */
export function parentCsp(options?: { desktop?: boolean; dev?: boolean }): string;
