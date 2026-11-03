/// <reference types="node" />
// 桌上螢幕的固定鏡頭（motion: "still"，2026-11-03 demo 用）：鏡頭整段不動、從斜上方看、螢幕佔畫面寬約九成，評審看得到完整畫面又不晃。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

// deskScreen.js 是經典腳本：用 vm 執行，取出 presetCamera 與場景物件 S
const context = vm.createContext({});
vm.runInContext(readFileSync(join(import.meta.dirname, "builtins/deskScreen.js"), "utf8"), context, { filename: "deskScreen.js" });
const presetCamera = vm.runInContext("presetCamera", context) as (three: typeof THREE, motion: string, u: number) => { pos: THREE.Vector3; look: THREE.Vector3; fov: number };
const S = vm.runInContext("S", context) as Record<string, unknown>;

/** 螢幕寬（場景單位，同 deskScreen.js 的 SCREEN_W） */
const SCREEN_W = 4.0;
/** 畫面寬高比 */
const ASPECT = 16 / 9;
/** 垂直視角（度） */
const FOV = 35;

// setup 會算的滿版鏡頭：正對螢幕、螢幕剛好填滿畫面
const center = new THREE.Vector3(0, 1.25, 0);
const dist = SCREEN_W / 2 / ASPECT / Math.tan((FOV * Math.PI) / 360);
S.fov0 = FOV;
S.flat = { pos: center.clone().add(new THREE.Vector3(0, 0, dist)), look: center.clone(), fov: FOV };

/** 螢幕寬佔畫面寬的比例（鏡頭到螢幕中心的距離換算，近似） */
function widthShare(pos: THREE.Vector3, look: THREE.Vector3) {
  const d = pos.distanceTo(look);
  const halfW = d * Math.tan((FOV * Math.PI) / 360) * ASPECT;
  return SCREEN_W / (2 * halfW);
}

describe("桌上螢幕的固定鏡頭（still）", () => {
  it("整段不動：開頭、中間、結尾的鏡頭位置與看的點都一樣", () => {
    const a = presetCamera(THREE, "still", 0);
    const b = presetCamera(THREE, "still", 0.5);
    const c = presetCamera(THREE, "still", 1);
    expect(a.pos.distanceTo(b.pos)).toBeLessThan(1e-9);
    expect(a.pos.distanceTo(c.pos)).toBeLessThan(1e-9);
    expect(a.look.distanceTo(c.look)).toBeLessThan(1e-9);
  });

  it("從斜上方看（看得到木紋桌面），螢幕佔畫面寬 85%～95%", () => {
    const { pos, look } = presetCamera(THREE, "still", 0.5);
    const elevation = (Math.asin((pos.y - look.y) / pos.distanceTo(look)) * 180) / Math.PI;
    expect(elevation).toBeGreaterThan(12);
    expect(elevation).toBeLessThan(35);
    const share = widthShare(pos, look);
    expect(share).toBeGreaterThan(0.85);
    expect(share).toBeLessThan(0.95);
  });

  it("鏡頭在螢幕正前方（左右置中），看的點是螢幕中心", () => {
    const { pos, look } = presetCamera(THREE, "still", 0.3);
    expect(Math.abs(pos.x)).toBeLessThan(1e-9);
    expect(look.distanceTo(center)).toBeLessThan(1e-9);
  });
});

// 螢幕後仰時（2026-11-03 開發者：下面靠近、上面遠離比較好）：固定鏡頭從接近水平的高度看，螢幕上緣比下緣離鏡頭遠
describe("固定鏡頭看後仰的螢幕", () => {
  it("螢幕後仰 20 度：上緣離鏡頭比下緣遠，螢幕仍佔畫面寬 85%～95%", () => {
    const tilt = (20 * Math.PI) / 180;
    const normal = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt));
    const up = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt));
    const saved = S.flat;
    S.flat = { pos: center.clone().add(normal.clone().multiplyScalar(dist)), look: center.clone(), fov: FOV };
    const { pos, look } = presetCamera(THREE, "still", 0.5);
    S.flat = saved;
    const h = (4.0 * 9) / 16 / 2;
    const top = center.clone().add(up.clone().multiplyScalar(h));
    const bottom = center.clone().add(up.clone().multiplyScalar(-h));
    expect(pos.distanceTo(top)).toBeGreaterThan(pos.distanceTo(bottom) + 0.15);
    const share = widthShare(pos, look);
    expect(share).toBeGreaterThan(0.85);
    expect(share).toBeLessThan(0.95);
  });
});
