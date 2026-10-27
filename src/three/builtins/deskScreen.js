// 內建 3D 範本「Screen on a desk」（spec §5.8）：木紋桌上立一台螢幕，螢幕播當格畫面（V1）。
// 場景全部用程式畫（木紋是程序貼圖，沒有外部素材，開發者 2026-10-27 決定）；移植自 spikes/export-bench/src/scene3d.ts。
// 頭尾接回滿版平面：區段開頭與結尾鏡頭正對螢幕、螢幕剛好填滿畫面，中間依 motion 運鏡，所以前後接原片時看不出接縫。
// 參數：motion（reveal：拉遠看到桌子再推回；push：慢慢推近；orbit：繞著桌子轉半圈）、tilt（螢幕後仰度數）、ramp（頭尾過場秒數）。

/** 畫面只由 t 決定（跳格不必從頭推） */
const pure = true;

/** 螢幕寬高（場景單位）與中心 */
const SCREEN_W = 4.0;
const SCREEN_H = SCREEN_W * 9 / 16;
const CENTER_Y = 1.25;

/** 場景物件（setup 建、update 用） */
const S = {};

/** 木紋程序貼圖：幾個頻率的正弦疊成年輪＋固定偽雜訊（每次都一樣） */
function woodTexture(THREE) {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ring = Math.sin(y * 0.21) * 0.5 + Math.sin(y * 0.047 + 1.3) * 0.35 + Math.sin(y * 0.9) * 0.15;
    for (let x = 0; x < size; x++) {
      const noise = ((x * 7919 + y * 104729) % 97) / 97 - 0.5;
      const k = 0.62 + ring * 0.16 + noise * 0.05;
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, 168 * k + 20);
      data[i + 1] = Math.min(255, 112 * k + 12);
      data[i + 2] = Math.min(255, 66 * k + 8);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 建場景 */
function setup(THREE, scene, camera, env) {
  scene.background = new THREE.Color(0x1a1410);
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
  sun.position.set(-4, 8, 6);
  scene.add(sun);

  const desk = new THREE.Mesh(new THREE.PlaneGeometry(26, 16), new THREE.MeshStandardMaterial({ map: woodTexture(THREE), roughness: 0.75 }));
  desk.rotation.x = -Math.PI / 2;
  scene.add(desk);

  const tilt = -(env.params.tilt ?? 7) * Math.PI / 180;
  const group = new THREE.Group();
  group.position.set(0, CENTER_Y, 0);
  group.rotation.x = tilt;
  scene.add(group);
  group.add(new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 0.22, SCREEN_H + 0.22, 0.1), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.4, metalness: 0.3 })));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), env.frameMaterial());
  screen.position.z = 0.056;
  group.add(screen);
  const stand = new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.5, metalness: 0.4 });
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.2, 0.12), stand);
  neck.position.set(0, -0.95, -0.1);
  group.add(neck);
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 1.0), stand);
  base.position.set(0, 0.03, 0.15);
  scene.add(base);

  const block = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), new THREE.MeshStandardMaterial({ color: 0x3b7ddd, roughness: 0.6 }));
  block.position.set(-3.2, 0.25, 1.2);
  block.rotation.y = 0.5;
  scene.add(block);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.6, 32), new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.3 }));
  cup.position.set(3.1, 0.3, 1.6);
  scene.add(cup);

  // 滿版位置：正對螢幕、沿螢幕法線退到剛好填滿畫面的距離（垂直視角 40°；畫面比螢幕寬時以高度為準）
  const fov = camera.fov * Math.PI / 180;
  const aspect = env.width / env.height;
  const dist = Math.max(SCREEN_H / 2, SCREEN_W / 2 / aspect) / Math.tan(fov / 2) + 0.056;
  const normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
  const center = new THREE.Vector3(0, CENTER_Y, 0).add(normal.clone().multiplyScalar(0.056));
  S.THREE = THREE;
  S.camera = camera;
  S.flat = { pos: center.clone().add(normal.clone().multiplyScalar(dist - 0.056)), look: center.clone(), up: new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt) };
  S.center = center;
}

/** 平滑（頭尾慢、中間快） */
function smooth(u) {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
}

/** 中間段的鏡頭（u：0～1） */
function middleCamera(THREE, motion, u) {
  const look = new THREE.Vector3(0, CENTER_Y * 0.8, 0);
  if (motion === 'orbit') {
    const a = -0.8 + u * 1.6;
    return { pos: new THREE.Vector3(Math.sin(a) * 9, 4.2, Math.cos(a) * 9), look };
  }
  if (motion === 'push') {
    return { pos: new THREE.Vector3(0.8 - u * 0.8, 3.6 - u * 1.2, 10 - u * 3.5), look };
  }
  // reveal：拉遠看到整張桌子、慢慢往右移
  return { pos: new THREE.Vector3(-1.2 + u * 2.4, 4.4, 9.5), look };
}

/** 每格更新鏡頭 */
function update(t, env) {
  const THREE = S.THREE;
  const camera = S.camera;
  const L = env.duration;
  const ramp = Math.min(env.params.ramp ?? 1.2, L / 3);
  const mid = middleCamera(THREE, env.params.motion || 'reveal', L > 2 * ramp ? (t - ramp) / (L - 2 * ramp) : 0.5);
  // 頭：滿版 → 中間段起點；尾：中間段終點 → 滿版
  let k = 1;
  let target = mid;
  if (t < ramp) { k = smooth(t / ramp); target = middleCamera(THREE, env.params.motion || 'reveal', 0); }
  else if (t > L - ramp) { k = smooth((L - t) / ramp); target = middleCamera(THREE, env.params.motion || 'reveal', 1); }
  camera.position.copy(S.flat.pos).lerp(target.pos, k);
  const look = S.flat.look.clone().lerp(target.look, k);
  camera.up.copy(S.flat.up).lerp(new THREE.Vector3(0, 1, 0), k).normalize();
  camera.lookAt(look);
}
