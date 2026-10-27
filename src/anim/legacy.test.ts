/// <reference types="node" />
// 原專案（字導字演）動畫直譯器、執行環境、元件庫的單元測試，交給 Vitest 執行（測試本體在 legacy/*.cjs，沿用不改寫）。
// 做法：腳本裡的 test(name, fn) 在 Vitest 下改成登記到 globalThis.__animCollect，這裡收齊後逐一註冊成 it()。
import { createRequire } from "node:module";
import { describe, it } from "vitest";

const require = createRequire(import.meta.url);

/** 載入一支腳本，回傳它登記的測試（腳本的頂層設定照常執行） */
function collect(file: string): [string, () => void][] {
  const tests: [string, () => void][] = [];
  (globalThis as { __animCollect?: (name: string, fn: () => void) => void }).__animCollect = (name, fn) => {
    tests.push([name, fn]);
  };
  try {
    require(file);
  } finally {
    delete (globalThis as { __animCollect?: unknown }).__animCollect;
  }
  return tests;
}

for (const [label, file] of [
  ["直譯器（anim_vm）", "./legacy/anim-vm-unit.cjs"],
  ["執行環境（anim_runtime）", "./legacy/anim-runtime-unit.cjs"],
  ["內建元件庫（anim-library）", "./legacy/anim-library-unit.cjs"],
] as const) {
  describe(label, () => {
    for (const [name, fn] of collect(file)) it(name, fn);
  });
}
