// 內建 3D 範本「Floating board」（spec §5.8 漂浮的板子）：V1 畫面變成一塊在空間中轉動、推近、拉遠的板子。
// 姿勢關鍵幀沿用原專案（字導字演）的格式與數學：前面串了 vendor/plane3d_math.js（PLANE3D）與 boardGeometry.js（BOARD3D），
// 投影結果和原專案逐點相同（boardGeometry.test.ts）。頭尾自動回滿版平面（edges），所以前後接原片看不出接縫。
// 參數（env.params）：keys（[{anchor, t, rx, ry, rz, size, px, py, ease}]）、float（{rx, ry, period} 或 null）、edges、
//   background（studio｜grid｜blur｜color｜image）、color（純色背景）、shadow（0～1）；
//   backgroundImage（P1-14，型別 texture：env.textures.backgroundImage 是 AI 產生的 3D 背景圖，background 選 image 時鋪滿遠處的背景平面；沒選圖就畫攝影棚）。
// 背景全部用程式畫（攝影棚、科技格線的畫法沿用原專案 scripts/plane3d-scenes-build.js）。
/* global PLANE3D, BOARD3D */

/** 畫面只由 t 決定 */
const pure = true;

/** 場景物件 */
const B = {};

/** 畫背景（2D canvas）：攝影棚、科技格線、純色；模糊原畫面每格另外畫 */
function paintBackground(g, kind, color, w, h) {
  if (kind === 'color') {
    g.fillStyle = color || '#202020';
    g.fillRect(0, 0, w, h);
  } else if (kind === 'grid') {
    const vy = h * 0.55;
    const sky = g.createLinearGradient(0, 0, 0, vy);
    sky.addColorStop(0, '#0a1226');
    sky.addColorStop(1, '#132447');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, vy);
    g.fillStyle = '#0a1226';
    g.fillRect(0, vy, w, h - vy);
    g.strokeStyle = 'rgba(90,170,255,0.28)';
    g.lineWidth = Math.max(1, h / 540);
    g.beginPath();
    for (let k = 1; k <= 12; k++) { const y = vy + (h - vy) * (k / 12) ** 2; g.moveTo(0, y); g.lineTo(w, y); }
    for (let k = 0; k <= 24; k++) { const x = -w + 3 * w * k / 24; g.moveTo(w / 2, vy); g.lineTo(x, h); }
    g.stroke();
  } else {
    const rg = g.createRadialGradient(w / 2, h * 0.35, 0, w / 2, h * 0.35, Math.max(w, h) * 0.8);
    rg.addColorStop(0, '#5a6378');
    rg.addColorStop(0.55, '#2c3240');
    rg.addColorStop(1, '#14171f');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
    const floor = g.createLinearGradient(0, h * 0.68, 0, h);
    floor.addColorStop(0, 'rgba(255,255,255,0.07)');
    floor.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = floor;
    g.fillRect(0, h * 0.68, w, h * 0.32);
  }
}

/** 建一個四邊形（四角由 update 依姿勢更新） */
function quad(THREE, material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]), 2));
  geo.setIndex([0, 2, 1, 2, 3, 1]);
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

/** 把四角寫進四邊形 */
function setCorners(mesh, corners) {
  const pos = mesh.geometry.attributes.position;
  corners.forEach(([x, y, z], i) => pos.setXYZ(i, x, y, z));
  pos.needsUpdate = true;
}

/** 建場景 */
function setup(THREE, scene, camera, env) {
  const { width: w, height: h } = env;
  camera.fov = BOARD3D.verticalFov(w, h);
  camera.aspect = w / h;
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();

  // 背景：遠處一片剛好填滿畫面的平面
  const p = env.params;
  B.kind = p.background || 'studio';
  B.canvas = new OffscreenCanvas(Math.round(w / 2), Math.round(h / 2));
  B.ctx = B.canvas.getContext('2d');
  if (B.kind !== 'blur') paintBackground(B.ctx, B.kind, p.color, B.canvas.width, B.canvas.height);
  const image = B.kind === 'image' && env.textures && env.textures.backgroundImage;
  if (image) {
    // 使用者的背景圖：2D 貼圖、sRGB、不平鋪
    B.bgTexture = image.map;
    B.bgTexture.wrapS = B.bgTexture.wrapT = THREE.ClampToEdgeWrapping;
    B.bgTexture.repeat.set(1, 1);
  } else {
    B.bgTexture = new THREE.CanvasTexture(B.canvas);
    B.bgTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const far = 50;
  const bh = 2 * far * Math.tan(camera.fov * Math.PI / 360);
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(bh * w / h, bh), new THREE.MeshBasicMaterial({ map: B.bgTexture, toneMapped: false }));
  bg.position.set(0, 0, -far);
  scene.add(bg);

  // 陰影（板子後面一片半透明黑）與板子
  B.shadow = quad(THREE, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }));
  scene.add(B.shadow);
  B.board = quad(THREE, env.frameMaterial());
  scene.add(B.board);
  B.THREE = THREE;
}

/** 每格：依姿勢關鍵幀更新板子四角、陰影；模糊背景重畫 */
function update(t, env) {
  const p = env.params;
  const w = env.width;
  const h = env.height;
  const effect = { keys: p.keys && p.keys.length ? p.keys : [PLANE3D.FLAT], float: p.float || null, edges: p.edges !== false };
  const pose = PLANE3D.poseAt(effect, env.duration, t);
  const corners = BOARD3D.cornersInCamera(pose, w, h);
  setCorners(B.board, corners);
  // 陰影：往下偏一點、稍微放大，強度隨頭尾漸變（滿版時沒有陰影）
  const weight = PLANE3D.edgeWeight(effect, env.duration, t) * (p.shadow ?? 0.55);
  const dy = PLANE3D.SHADOW_DY * 2 * (h / w);
  setCorners(B.shadow, corners.map(([x, y, z]) => [x * 1.02, y * 1.02 - dy * (-z / PLANE3D.D0), z - 0.001]));
  B.shadow.material.opacity = weight * 0.8;
  if (B.kind === 'blur' && env.frameTexture.image && env.frameTexture.image.width > 1) {
    // 模糊原畫面：放大 1.2 倍、強模糊、壓暗 20%（同原專案）
    const g = B.ctx;
    const cw = B.canvas.width;
    const ch = B.canvas.height;
    const img = env.frameTexture.image;
    g.filter = `blur(${(ch * 0.03).toFixed(1)}px) brightness(0.8)`;
    g.drawImage(img, img.width * 0.083, img.height * 0.083, img.width / 1.2, img.height / 1.2, -cw * 0.05, -ch * 0.05, cw * 1.1, ch * 1.1);
    g.filter = 'none';
    B.bgTexture.needsUpdate = true;
  }
}
