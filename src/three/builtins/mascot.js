// 內建 3D 範本「Mascot」（spec §5.7、§5.8 吉祥物）：基本幾何組成的小角色，疊在影片上（anim3d，透明背景）。
// 從畫面一側走進來，停在目標框旁邊，然後揮手或指著目標框；目標框 env.box（0～1）可以在預覽上拖。
// 畫面只由 t 決定（pure）；鏡頭固定，畫面座標用 z=0 平面換算（box 的位置對得上畫面）。
// 參數：action（wave 揮手／point 指著框）、from（left／right 從哪邊走進來）、color、height（角色高度佔畫面高的比例）、walk（走路秒數）。

/** 畫面只由 t 決定 */
const pure = true;

/** 場景物件 */
const M = {};

/** 建角色：身體、頭、眼睛、手腳（每個關節一個 Group，方便轉） */
function buildMascot(THREE, color) {
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1d24, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const root = new THREE.Group();

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.55, 8, 16), body);
  torso.position.y = 1.15;
  root.add(torso);
  const head = new THREE.Group();
  head.position.y = 2.05;
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.48, 24, 16), body));
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), white);
    eye.position.set(0.17 * side, 0.06, 0.4);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), dark);
    pupil.position.set(0.17 * side, 0.06, 0.5);
    head.add(pupil);
  }
  root.add(head);

  /** 一條手或腳：肩（髖）關節 Group，裡面一根膠囊往下垂 */
  const limb = (x, y, len, radius) => {
    const joint = new THREE.Group();
    joint.position.set(x, y, 0);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, len, 6, 12), body);
    m.position.y = -len / 2 - radius;
    joint.add(m);
    root.add(joint);
    return joint;
  };
  return {
    root, head,
    armL: limb(-0.52, 1.5, 0.55, 0.12), armR: limb(0.52, 1.5, 0.55, 0.12),
    legL: limb(-0.2, 0.68, 0.42, 0.14), legR: limb(0.2, 0.68, 0.42, 0.14),
  };
}

/** 建場景 */
function setup(THREE, scene, camera, env) {
  scene.add(new THREE.AmbientLight(0xffffff, 1.3));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 6, 8);
  scene.add(key);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  // z=0 平面上看得到的範圍（畫面座標換算用）
  M.viewH = 2 * 20 * Math.tan(camera.fov * Math.PI / 360);
  M.viewW = M.viewH * camera.aspect;
  M.parts = buildMascot(THREE, new THREE.Color(env.params.color || '#ffb020'));
  scene.add(M.parts.root);
}

/** 畫面座標（0～1，y 往下）→ z=0 平面的世界座標 */
function toWorld(x, y) {
  return { x: (x - 0.5) * M.viewW, y: (0.5 - y) * M.viewH };
}

/** 平滑（頭尾慢） */
function smooth(u) {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
}

/** 每格：走路 → 停在框旁 → 揮手或指著框 */
function update(t, env) {
  const p = env.params;
  const box = env.box || { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 };
  const P = M.parts;
  const fromLeft = (p.from || 'left') === 'left';
  const size = (p.height ?? 0.35) * M.viewH / 2.6;  // 角色模型高約 2.6
  P.root.scale.setScalar(size);

  // 站的位置：框靠近入場那一側的外面，腳底對齊框的下緣（畫面外就夾回來）
  const standX = Math.min(0.92, Math.max(0.08, fromLeft ? box.cx - box.w / 2 - 0.07 : box.cx + box.w / 2 + 0.07));
  const footY = Math.min(0.98, box.cy + box.h / 2);
  const start = toWorld(fromLeft ? -0.12 : 1.12, footY);
  const stand = toWorld(standX, footY);
  const walk = Math.min(p.walk ?? 1.6, env.duration * 0.6);
  const k = smooth(t / walk);
  P.root.position.set(start.x + (stand.x - start.x) * k, stand.y, 0);

  // 走路：腳前後擺、身體上下彈，面向前進方向；到了就轉正面向鏡頭
  const walking = t < walk;
  const phase = t * 9;
  const swing = walking ? Math.sin(phase) * 0.7 : 0;
  P.legL.rotation.x = swing;
  P.legR.rotation.x = -swing;
  P.root.rotation.y = walking ? (fromLeft ? 1 : -1) * 0.9 * (1 - smooth((t - walk + 0.3) / 0.3)) : 0;
  P.root.position.y += walking ? Math.abs(Math.sin(phase)) * 0.08 * size : 0;

  // 手：走路時跟著擺；到了以後揮手（靠框那隻手舉高左右揮）或指著框中心
  const near = fromLeft ? P.armR : P.armL;
  const far = fromLeft ? P.armL : P.armR;
  if (walking) {
    near.rotation.set(-swing * 0.8, 0, 0);
    far.rotation.set(swing * 0.8, 0, 0);
    P.head.rotation.z = 0;
  } else {
    const a = smooth((t - walk) / 0.35);
    far.rotation.set(0, 0, (fromLeft ? 1 : -1) * 0.15 * a);
    if ((p.action || 'point') === 'wave') {
      near.rotation.set(0, 0, (fromLeft ? 1 : -1) * (2.6 * a + Math.sin((t - walk) * 10) * 0.35 * a));
    } else {
      // 指向框中心：從肩膀到框中心的角度（手臂預設朝下，所以加 90°）
      const shoulder = P.root.localToWorld(near.position.clone());
      const target = toWorld(box.cx, box.cy);
      const angle = Math.atan2(target.y - shoulder.y, target.x - shoulder.x) + Math.PI / 2;
      near.rotation.set(0, 0, angle * a);
    }
    P.head.rotation.z = Math.sin((t - walk) * 2.2) * 0.06;
  }
}
