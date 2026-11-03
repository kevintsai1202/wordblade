// 內建 3D 範本「Screen in a scene」（spec §5.8）：螢幕播當格畫面（V1），放在三種程式畫的場景裡：
//   desk（木紋桌上的螢幕）、classroom（教室黑板，影片就是板面）、studio（攝影棚，螢幕立在架上、聚光）。
// 場景全部用程式畫（沒有外部素材，開發者 2026-10-27 決定）；桌上螢幕移植自 spikes/export-bench/src/scene3d.ts。
// 三個場景的螢幕位置、大小相同，運鏡共用。頭尾接回滿版：區段開頭與結尾鏡頭正對螢幕、螢幕剛好填滿畫面。
// 鏡頭：有鏡頭關鍵幀（env.params.cameraKeys，前面串了 cameraPath.js 的 CAMERA3D）就照關鍵幀走，否則用 motion 預設運鏡。
// 參數：scene、motion（reveal 拉遠再推回／push 慢慢推近／orbit 繞半圈／still 固定斜上方、螢幕佔畫面寬九成）、tilt（螢幕後仰度數）、ramp（頭尾過場秒數）。
// 材質欄位（P1-14，型別 texture，env.textures[欄位]；沒選就用程式畫的預設）：deskTexture（桌面）、wallTexture／floorTexture／frameTexture
//   （教室的牆、地板、黑板框與講桌）、floorTexture（攝影棚地面）；backgroundImage（3D 背景圖，當 scene.background）。
/* global CAMERA3D */

/** 畫面只由 t 決定（跳格不必從頭推） */
const pure = true;

/** 螢幕寬高（場景單位）與中心高度 */
const SCREEN_W = 4.0;
const SCREEN_H = SCREEN_W * 9 / 16;
const CENTER_Y = 1.25;

/** 場景物件（setup 建、update 用） */
const S = {};

/** 木紋程序貼圖：幾個頻率的正弦疊成年輪＋固定偽雜訊（每次都一樣）；tone 調深淺 */
function woodTexture(THREE, tone) {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ring = Math.sin(y * 0.21) * 0.5 + Math.sin(y * 0.047 + 1.3) * 0.35 + Math.sin(y * 0.9) * 0.15;
    for (let x = 0; x < size; x++) {
      const noise = ((x * 7919 + y * 104729) % 97) / 97 - 0.5;
      const k = (0.62 + ring * 0.16 + noise * 0.05) * tone;
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

/**
 * 材質欄位 → MeshStandardMaterial：使用者在 Inspector 選了材質才有（env.textures[field]），沒選回 null 由呼叫端用預設。
 * repeat 是這個表面的基本平鋪次數 [橫, 縱]，再乘上使用者設的倍數；法線強度用 normalScale 套。
 */
function texturedMaterial(THREE, env, field, repeat) {
  const t = env.textures && env.textures[field];
  if (!t) return null;
  t.map.repeat.set(repeat[0] * t.repeat, repeat[1] * t.repeat);
  const mat = new THREE.MeshStandardMaterial({ map: t.map, roughness: 0.8 });
  if (t.normalMap) {
    t.normalMap.repeat.set(repeat[0] * t.repeat, repeat[1] * t.repeat);
    mat.normalMap = t.normalMap;
    mat.normalScale = new THREE.Vector2(t.normalStrength, t.normalStrength);
  }
  return mat;
}

/** 使用者選了 3D 背景圖（env.textures.backgroundImage）就拿它當 scene.background（2D 貼圖、sRGB），蓋過各場景的純色 */
function applyBackgroundImage(THREE, scene, env) {
  const t = env.textures && env.textures.backgroundImage;
  if (!t) return;
  t.map.wrapS = t.map.wrapT = THREE.ClampToEdgeWrapping;
  t.map.repeat.set(1, 1);
  scene.background = t.map;
}

/** 垂直漸層貼圖（攝影棚背景） */
function gradientTexture(THREE, top, bottom) {
  const c = new OffscreenCanvas(4, 256);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 木紋桌：桌面、螢幕邊框與底座、桌上的方塊和杯子 */
function buildDesk(THREE, scene, group, env) {
  scene.background = new THREE.Color(0x1a1410);
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(26, 16), texturedMaterial(THREE, env, 'deskTexture', [5, 3]) || new THREE.MeshStandardMaterial({ map: woodTexture(THREE, 1), roughness: 0.75 }));
  desk.rotation.x = -Math.PI / 2;
  scene.add(desk);
  group.add(new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 0.22, SCREEN_H + 0.22, 0.1), new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.4, metalness: 0.3 })));
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
}

/** 教室：牆、木地板、黑板邊框與粉筆槽（影片就是板面）、講桌 */
function buildClassroom(THREE, scene, group, env) {
  scene.background = new THREE.Color(0xd9d2c3);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), texturedMaterial(THREE, env, 'wallTexture', [6, 2.4]) || new THREE.MeshStandardMaterial({ color: 0xe8e0cf, roughness: 0.95 }));
  wall.position.set(0, 4, -0.3);
  scene.add(wall);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 16), texturedMaterial(THREE, env, 'floorTexture', [6, 3]) || new THREE.MeshStandardMaterial({ map: woodTexture(THREE, 0.75), roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.6;
  scene.add(floor);
  // 黑板木框（比螢幕大一圈）與粉筆槽
  const frame = texturedMaterial(THREE, env, 'frameTexture', [1, 1]) || new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.7 });
  group.add(new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 0.5, SCREEN_H + 0.5, 0.08), frame));
  const tray = new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 0.5, 0.08, 0.25), frame);
  tray.position.set(0, -SCREEN_H / 2 - 0.28, 0.12);
  group.add(tray);
  for (let i = 0; i < 3; i++) {
    const chalk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 10), new THREE.MeshStandardMaterial({ color: [0xffffff, 0xf7e27a, 0xf2a3b3][i], roughness: 0.9 }));
    chalk.rotation.z = Math.PI / 2;
    chalk.position.set(-1.2 + i * 0.35, -SCREEN_H / 2 - 0.2, 0.15);
    group.add(chalk);
  }
  // 講桌
  const lectern = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.1, 0.8), frame);
  lectern.position.set(2.8, -0.05, 2.2);
  scene.add(lectern);
}

/** 攝影棚：漸層背幕、地面、螢幕立架、兩盞聚光的光錐 */
function buildStudio(THREE, scene, group, env) {
  scene.background = new THREE.Color(0x101318);
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(40, 16), new THREE.MeshBasicMaterial({ map: gradientTexture(THREE, '#2c3240', '#0d0f14') }));
  backdrop.position.set(0, 4, -6);
  scene.add(backdrop);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 20), texturedMaterial(THREE, env, 'floorTexture', [8, 4]) || new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.35, metalness: 0.2 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.6;
  scene.add(floor);
  group.add(new THREE.Mesh(new THREE.BoxGeometry(SCREEN_W + 0.14, SCREEN_H + 0.14, 0.08), new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.3, metalness: 0.5 })));
  // 立架：從螢幕下緣到地面（沒有環境貼圖，金屬感調低免得暗掉），底下一塊圓底座
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa3b2, metalness: 0.3, roughness: 0.4 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 16), steel);
  pole.position.set(0, -0.6 + 0.9 - CENTER_Y, -0.1);
  group.add(pole);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.05, 32), steel);
  foot.position.set(0, -0.575, 0);
  scene.add(foot);
  for (const x of [-4.5, 4.5]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.8, 7, 32, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
    cone.position.set(x, 3, -1);
    cone.rotation.z = x < 0 ? -0.35 : 0.35;
    scene.add(cone);
  }
}

/** 建場景 */
function setup(THREE, scene, camera, env) {
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
  sun.position.set(-4, 8, 6);
  scene.add(sun);

  const tilt = -(env.params.tilt ?? 7) * Math.PI / 180;
  const group = new THREE.Group();
  group.position.set(0, CENTER_Y, 0);
  group.rotation.x = tilt;
  scene.add(group);
  const kind = env.params.scene || 'desk';
  if (kind === 'classroom') buildClassroom(THREE, scene, group, env);
  else if (kind === 'studio') buildStudio(THREE, scene, group, env);
  else buildDesk(THREE, scene, group, env);
  applyBackgroundImage(THREE, scene, env);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN_W, SCREEN_H), env.frameMaterial());
  screen.position.z = 0.056;
  group.add(screen);

  // 滿版位置：正對螢幕、沿螢幕法線退到剛好填滿畫面的距離（畫面比螢幕寬時以高度為準）
  S.fov0 = camera.fov;
  const fov = camera.fov * Math.PI / 180;
  const aspect = env.width / env.height;
  const dist = Math.max(SCREEN_H / 2, SCREEN_W / 2 / aspect) / Math.tan(fov / 2) + 0.056;
  const normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
  const center = new THREE.Vector3(0, CENTER_Y, 0).add(normal.clone().multiplyScalar(0.056));
  S.THREE = THREE;
  S.camera = camera;
  S.flat = { pos: center.clone().add(normal.clone().multiplyScalar(dist - 0.056)), look: center.clone(), up: new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt), fov: camera.fov };
}

/** 平滑（頭尾慢、中間快） */
function smooth(u) {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
}

/** 固定鏡頭（still）：比滿版鏡頭往上抬幾度、螢幕佔畫面寬的比例 */
const STILL_ELEVATION = 20;
const STILL_SHARE = 0.9;

/** 預設運鏡的中間段（u：0～1） */
function presetCamera(THREE, motion, u) {
  if (motion === 'still') {
    // 固定鏡頭（2026-11-03）：從滿版鏡頭往上抬 STILL_ELEVATION 度、拉遠到螢幕佔畫面寬 STILL_SHARE，整段不動
    const look = S.flat.look.clone();
    const back = S.flat.pos.clone().sub(look).applyAxisAngle(new THREE.Vector3(1, 0, 0), -STILL_ELEVATION * Math.PI / 180);
    return { pos: look.clone().add(back.multiplyScalar(1 / STILL_SHARE)), look, fov: S.fov0 };
  }
  const look = new THREE.Vector3(0, CENTER_Y * 0.8, 0);
  if (motion === 'orbit') {
    const a = -0.8 + u * 1.6;
    return { pos: new THREE.Vector3(Math.sin(a) * 9, 4.2, Math.cos(a) * 9), look, fov: S.fov0 };
  }
  if (motion === 'push') return { pos: new THREE.Vector3(0.8 - u * 0.8, 3.6 - u * 1.2, 10 - u * 3.5), look, fov: S.fov0 };
  return { pos: new THREE.Vector3(-1.2 + u * 2.4, 4.4, 9.5), look, fov: S.fov0 };
}

/** 中間段在時間 t 的鏡頭：有關鍵幀照關鍵幀，否則預設運鏡 */
function middleCamera(THREE, env, t, ramp) {
  const keys = env.params.cameraKeys;
  if (keys && keys.length) {
    const c = CAMERA3D.cameraAt(keys, t);
    return { pos: new THREE.Vector3(...c.position), look: new THREE.Vector3(...c.target), fov: c.fov };
  }
  const L = env.duration;
  return presetCamera(THREE, env.params.motion || 'reveal', L > 2 * ramp ? (t - ramp) / (L - 2 * ramp) : 0.5);
}

/** 每格更新鏡頭：頭尾在滿版與中間段之間過場 */
function update(t, env) {
  const THREE = S.THREE;
  const camera = S.camera;
  const L = env.duration;
  const ramp = Math.min(env.params.ramp ?? 1.2, L / 3);
  let k = 1;
  let target;
  if (t < ramp) { k = smooth(t / ramp); target = middleCamera(THREE, env, ramp, ramp); }
  else if (t > L - ramp) { k = smooth((L - t) / ramp); target = middleCamera(THREE, env, L - ramp, ramp); }
  else target = middleCamera(THREE, env, t, ramp);
  camera.position.copy(S.flat.pos).lerp(target.pos, k);
  camera.up.copy(S.flat.up).lerp(new THREE.Vector3(0, 1, 0), k).normalize();
  camera.lookAt(S.flat.look.clone().lerp(target.look, k));
  camera.fov = S.flat.fov + (target.fov - S.flat.fov) * k;
  camera.updateProjectionMatrix();
}
