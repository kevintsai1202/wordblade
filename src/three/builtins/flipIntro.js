// 內建 3D 插件「翻頁式片頭」（spec §5.23、D34；節奏與畫面參數取自 brand-v2 短版，調查 docs/research/intro-styles.md §1.4～§1.5）。
// 全畫面（scene3d）：封面一張張以上緣為軸翻下、越翻越快、舞台推近微轉 → 一次閃光 → 標題方塊縮入、字裡輪流透出封面 → 揭曉轉白字＋彈跳＋斜光 → 結尾淡出。
// 時間表由主程式的 intro/flip.ts 算好放在參數裡（畫面與音效同一份），插件只依 t 畫，所以 pure。
// 參數（env.params）：
//   imageIds（主程式解碼成 env.images，順序相同）、pages [{t, img, strength}]（img 是 env.images 的索引）、titleFills [索引]、icon（索引或 null）、
//   montageStart、titleIn、flash、reveal（秒）、title、subtitle、tone（duotone｜original）、dark、light（雙色調的暗色與亮色）、accent（標題方塊顏色）。
// 圖片貼圖不做色彩轉換（同 frameMaterial），ImageBitmap 第一列在最上，所以在 shader 翻 v。

/** 畫面只由 t 決定 */
const pure = true;

/** 場景物件 */
const F = {};

/** 頁面尺寸（世界單位；畫面高 1.08、鏡頭距離 1.8 時剛好是 brand-v2 的 1600×900 頁面在 1920×1080 舞台） */
const PAGE_W = 1.6;
const PAGE_H = 0.9;
/** 舞台原點到鏡頭的距離（垂直視角 33.4° 時畫面高 1.08） */
const CAM_D = 1.8;

/** GSAP 的 power 系列緩動 */
const easeIn = (p, n) => Math.pow(p, n + 1);
const easeOut = (p, n) => 1 - Math.pow(1 - p, n + 1);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** #rrggbb → [r, g, b]（0～1，不做色彩轉換） */
function rgb(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '') || /^#?([0-9a-f]{6})$/i.exec(fallback);
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 貼圖（ImageBitmap 或畫布）：不翻轉、不轉色彩、不做 mipmap */
function rawTexture(THREE, image, Ctor) {
  const tex = new (Ctor || THREE.Texture)(image);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** 貼圖材質：可選雙色調（依亮度在 dark、light 之間上色）、整體透明度 */
function pageMaterial(THREE, tex, duo, dark, light) {
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: { map: { value: tex }, duo: { value: duo }, dark: { value: new THREE.Vector3(...dark) }, light: { value: new THREE.Vector3(...light) }, opacity: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'uniform sampler2D map; uniform float duo; uniform vec3 dark; uniform vec3 light; uniform float opacity; varying vec2 vUv;',
      'void main() {',
      '  vec4 c = texture2D(map, vUv);',
      '  float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));',
      '  vec3 d = mix(dark, light, smoothstep(0.05, 0.95, l));',
      '  gl_FragColor = vec4(mix(c.rgb, d, duo), c.a * opacity);',
      '}',
    ].join('\n'),
  });
}

/** 依 cover 方式把圖片畫進框（裁掉多的） */
function drawCover(g, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s;
  const sh = h / s;
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

/** 圓角矩形路徑 */
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** 建場景 */
function setup(THREE, scene, camera, env) {
  const p = env.params;
  const { width: w, height: h } = env;
  camera.fov = 2 * Math.atan(540 / 1800) * 180 / Math.PI;
  camera.aspect = w / h;
  camera.position.set(0, 0, CAM_D);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  scene.add(camera);
  F.dark = rgb(p.dark, '#141a4a');
  F.light = rgb(p.light, '#a9b8ff');

  // 背景：遠處一片暗色漸層（全畫面不透明，蓋住 V1）
  const bgCanvas = new OffscreenCanvas(64, 36);
  const bg = bgCanvas.getContext('2d');
  const grad = bg.createRadialGradient(32, 14, 0, 32, 14, 48);
  grad.addColorStop(0, '#20264f');
  grad.addColorStop(1, '#05060d');
  bg.fillStyle = grad;
  bg.fillRect(0, 0, 64, 36);
  const far = 40;
  const fh = 2 * (far + CAM_D) * Math.tan(camera.fov * Math.PI / 360) * 1.6;
  const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(fh * w / h, fh), pageMaterial(THREE, rawTexture(THREE, bgCanvas, THREE.CanvasTexture), 0, F.dark, F.light));
  bgMesh.position.z = -far;
  scene.add(bgMesh);

  // 舞台與頁面：幾何往下平移半頁，原點在上緣（翻頁以上緣為軸）
  F.stage = new THREE.Group();
  scene.add(F.stage);
  const textures = (env.images || []).map((b) => rawTexture(THREE, b));
  const geo = new THREE.PlaneGeometry(PAGE_W, PAGE_H);
  geo.translate(0, -PAGE_H / 2, 0);
  const duo = p.tone === 'original' ? 0 : 1;
  F.pages = (p.pages || []).map((page, i) => {
    const tex = textures[page.img] || textures[0];
    const mesh = new THREE.Mesh(geo, tex ? pageMaterial(THREE, tex, duo, F.dark, F.light) : new THREE.MeshBasicMaterial({ color: 0x333a66 }));
    mesh.position.set(0, PAGE_H / 2, i * 0.002);
    mesh.visible = false;
    F.stage.add(mesh);
    const next = (p.pages[i + 1] || {}).t;
    const gap = next !== undefined ? next - page.t : (i > 0 ? page.t - p.pages[i - 1].t : 0.2);
    return { mesh, t: page.t, dur: Math.min(0.55, gap * 1.5) };
  });

  // 鏡頭前的兩片：標題卡（畫在畫布上）與閃光
  const dist = 1;
  const vh = 2 * dist * Math.tan(camera.fov * Math.PI / 360);
  F.cardCanvas = new OffscreenCanvas(w, h);
  F.card = F.cardCanvas.getContext('2d');
  F.cardTex = rawTexture(THREE, F.cardCanvas, THREE.CanvasTexture);
  F.cardMesh = new THREE.Mesh(new THREE.PlaneGeometry(vh * w / h, vh), pageMaterial(THREE, F.cardTex, 0, F.dark, F.light));
  F.cardMesh.position.z = -dist;
  F.cardMesh.renderOrder = 10;
  F.cardMesh.material.depthTest = false;
  camera.add(F.cardMesh);
  F.flash = new THREE.Mesh(new THREE.PlaneGeometry(vh * w / h * 1.1, vh * 1.1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false }));
  F.flash.position.z = -dist * 0.9;
  F.flash.renderOrder = 11;
  camera.add(F.flash);
  // 標題的另一張畫布：先畫字、再用 source-in 把封面填進字裡
  F.textCanvas = new OffscreenCanvas(w, h);
  F.text = F.textCanvas.getContext('2d');
  F.camera = camera;
}

/** 畫標題卡（t ≥ titleIn） */
function drawCard(t, env) {
  const p = env.params;
  const g = F.card;
  const w = env.width;
  const h = env.height;
  g.clearRect(0, 0, w, h);
  if (t < p.titleIn) return;
  const imgs = env.images || [];
  const title = String(p.title || '');
  const fs = h * 0.13;
  const font = `900 ${fs}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  g.font = font;
  const tw = Math.min(g.measureText(title).width, w * 0.7);
  const bw = tw + fs * 1.2;
  const bh = fs * 1.6;
  const revealed = t >= p.reveal;
  // 方塊：從 1.22 倍縮入（0.4 秒 power3.out）；揭曉時彈 1.04 倍
  let scale = 1.22 - 0.22 * easeOut(clamp01((t - p.titleIn) / 0.4), 3);
  if (revealed && t < p.reveal + 0.25) scale *= 1 + 0.04 * Math.sin(Math.PI * (t - p.reveal) / 0.25);
  g.save();
  g.translate(w / 2, h / 2);
  g.scale(scale, scale);
  g.globalAlpha = clamp01((t - p.titleIn) / 0.08);
  const accent = rgb(p.accent, '#2f5bff').map((c) => Math.round(c * 255 * (revealed ? 1 : 0.62)));
  g.fillStyle = `rgb(${accent.join(',')})`;
  roundRect(g, -bw / 2, -bh / 2, bw, bh, fs * 0.18);
  g.fill();
  // 字：揭曉前每 2 格換一張封面透出，揭曉後白字
  const tx = F.text;
  tx.setTransform(1, 0, 0, 1, 0, 0);
  tx.clearRect(0, 0, w, h);
  tx.font = font;
  tx.textAlign = 'center';
  tx.textBaseline = 'middle';
  tx.fillStyle = '#ffffff';
  tx.fillText(title, w / 2, h / 2 + fs * 0.04, w * 0.7);
  const fills = p.titleFills || [];
  if (!revealed && fills.length && imgs.length) {
    const k = Math.floor((t - p.titleIn) * env.fps / 2) % fills.length;
    const img = imgs[fills[k]] || imgs[0];
    tx.globalCompositeOperation = 'source-in';
    drawCover(tx, img, w / 2 - bw / 2, h / 2 - bh / 2, bw, bh);
    tx.globalCompositeOperation = 'source-over';
  }
  g.drawImage(F.textCanvas, -w / 2, -h / 2);
  // icon：揭曉後彈入，放在方塊左邊
  const icon = p.icon === null || p.icon === undefined ? null : imgs[p.icon];
  if (icon && t >= p.reveal + 0.05) {
    const q = clamp01((t - p.reveal - 0.05) / 0.25);
    const s = q < 0.6 ? 1.1 * easeOut(q / 0.6, 2) : 1.1 - 0.1 * easeOut((q - 0.6) / 0.4, 1);
    const size = bh * s;
    g.save();
    g.translate(-bw / 2 - bh * 0.7, 0);
    roundRect(g, -size / 2, -size / 2, size, size, size * 0.2);
    g.clip();
    drawCover(g, icon, -size / 2, -size / 2, size, size);
    g.restore();
  }
  // 斜光：揭曉後 0.6 秒掃過方塊（只亮在已畫的地方）
  const sweep = (t - p.reveal - 0.6) / 0.5;
  if (sweep > 0 && sweep < 1) {
    g.globalCompositeOperation = 'source-atop';
    const x = -bw / 2 - bh + (bw + bh * 2) * sweep;
    const lg = g.createLinearGradient(x - bh * 0.5, 0, x + bh * 0.5, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.fillRect(-bw, -bh, bw * 2, bh * 2);
    g.globalCompositeOperation = 'source-over';
  }
  g.restore();
  // 副標：揭曉後逐字出現（每字 0.04 秒）
  const sub = String(p.subtitle || '');
  if (sub && t >= p.reveal + 0.15) {
    const n = Math.min(sub.length, Math.floor((t - p.reveal - 0.15) / 0.04) + 1);
    g.font = `600 ${fs * 0.36}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(255,255,255,0.88)';
    g.fillText(sub.slice(0, n), w / 2, h / 2 + bh * 0.5 * scale + fs * 0.35, w * 0.8);
  }
}

/** 每格更新 */
function update(t, env) {
  const p = env.params;
  const start = p.montageStart || 0;
  const climax = p.titleIn;
  // 舞台推近微轉：scale 0.72→1.32（鏡頭距離反比）、rotationY −10°→8°、rotationX 6°→−2°，power1.in
  const m = easeIn(clamp01((t - start) / Math.max(0.01, climax - start)), 1);
  const s = 0.72 + 0.6 * m;
  F.camera.position.set(0, 0, CAM_D / s);
  F.stage.rotation.y = (-10 + 18 * m) * Math.PI / 180;
  F.stage.rotation.x = (6 - 8 * m) * Math.PI / 180;
  // 頁面：到時間就整頁不透明（不漸變，避免兩頁半透明疊在一起），從 −105° 翻到 0°（power2.out）；標題進場後收掉
  for (const page of F.pages) {
    const on = t >= page.t && t < climax;
    page.mesh.visible = on;
    if (on) page.mesh.rotation.x = -105 * (1 - easeOut(clamp01((t - page.t) / page.dur), 2)) * Math.PI / 180;
  }
  // 閃光：0.06 秒升到 0.85，0.35 秒退
  const f = t - p.flash;
  F.flash.material.opacity = f < 0 ? 0 : f < 0.06 ? 0.85 * f / 0.06 : Math.max(0, 0.85 * (1 - (f - 0.06) / 0.35));
  drawCard(t, env);
  F.cardTex.needsUpdate = true;
  // 結尾 0.35 秒淡出到背景
  F.cardMesh.material.uniforms.opacity.value = clamp01((env.duration - t) / 0.35);
}
