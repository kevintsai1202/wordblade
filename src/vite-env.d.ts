/// <reference types="vite/client" />

/** 經典腳本當模組載入（vite.config.ts 的 classicGlobalPlugin） */
declare module "*?global=PLANE3D" {
  const value: unknown;
  export default value;
}
