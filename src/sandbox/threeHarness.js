// 沙盒 Worker 裡的 3D 插件 harness（spec §5.7、§5.8）：接在 workerPrelude → three.js（THREE 全域）→ 插件程式之後。
// 3D 插件是原生 JS（three.js 進不了直譯器），安全只靠沙盒：沒有 same-origin 的 iframe、CSP connect-src 'none'、Worker 沒有 DOM、逾時強制終止。
// 插件契約：在最外層定義
//   function setup(THREE, scene, camera, env)   建場景（每次從區段開頭重跑都會再呼叫一次，scene 是新的）
//   function update(t, env)                     每格更新（t 是區段內秒數）
//   const pure = true;                          選填：畫面只由 t 決定（不在 update 之間累積狀態），跳格時不必從頭推
// env：width、height（畫格像素）、duration、fps、frame、t、progress、params、box（0～1）、rand(i)（固定種子）、
//      frameTexture（當格畫面的貼圖：NoColorSpace、不翻轉）、frameMaterial()（原樣貼當格畫面的材質，已處理上下顛倒與色彩）。
// 協定同 2D harness：render {frame, fps, duration, width, height, params, box, background?} → ImageBitmap；vet {…} → {lit}。
(function (g) {
  'use strict';
  /* global THREE, setup, update, pure */
  const plugin = {
    setup: typeof setup === 'function' ? setup : null,
    update: typeof update === 'function' ? update : null,
    pure: typeof pure !== 'undefined' && pure === true,
  };
  /** 跳格時最多從上一格往後推幾格；超過就從區段開頭重跑 */
  const MAX_STEP = 60;

  let chan = null;
  let canvas = null;
  let renderer = null;
  /** 目前的場景實例：scene、camera、參數鍵、最後畫到第幾格 */
  let inst = null;
  /** 當格畫面的貼圖 */
  let frameTexture = null;
  /** 沒有下層畫面時用的 1×1 黑格 */
  const black = new ImageData(1, 1);

  /** 錯誤轉成可序列化的物件（行號從堆疊裡找插件的那一行） */
  function serializeError(e) {
    return { name: e && e.name || 'Error', message: String(e && e.message || e), stage: e && e.stage || 'runtime', line: null, column: null };
  }

  /** 固定種子亂數（mulberry32 的雜湊版，同一個 i 永遠得到同一個值） */
  function rand(seed) {
    return (i) => {
      let a = (seed + Math.imul((i | 0) + 1, 0x9e3779b1)) >>> 0;
      a = Math.imul(a ^ (a >>> 15), a | 1);
      a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
      return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 原樣貼當格畫面的材質：ImageBitmap 第一列在最上（不支援 flipY），在 shader 裡翻 v；不做色彩轉換（10/27 實測 sRGB 貼圖每格多 40 ms） */
  function frameMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: frameTexture } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }',
    });
  }

  /** 準備畫布與 renderer（尺寸變了才重建） */
  function ensureRenderer(width, height) {
    if (renderer && canvas.width === width && canvas.height === height) return;
    if (renderer) renderer.dispose();
    canvas = new OffscreenCanvas(width, height);
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: true });
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0);
    frameTexture = new THREE.Texture(black);
    frameTexture.flipY = false;
    frameTexture.colorSpace = THREE.NoColorSpace;
    frameTexture.generateMipmaps = false;
    frameTexture.minFilter = THREE.LinearFilter;
    frameTexture.magFilter = THREE.LinearFilter;
    inst = null;
  }

  /** 這一格的 env */
  function envOf(d, frame) {
    const t = frame / d.fps;
    return {
      width: d.width, height: d.height, duration: d.duration, fps: d.fps, frame, t,
      progress: d.duration > 0 ? Math.min(1, t / d.duration) : 1,
      params: d.params || {}, box: d.box || { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 },
      rand: rand(d.seed || 1), frameTexture, frameMaterial,
    };
  }

  /** 釋放場景裡的幾何與材質 */
  function disposeScene(scene) {
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) { for (const v of Object.values(m)) if (v && v.isTexture && v !== frameTexture) v.dispose(); m.dispose(); }
    });
  }

  /** 從區段開頭建場景（呼叫插件的 setup） */
  function setupInstance(d, key) {
    if (inst) disposeScene(inst.scene);
    __reseed(1000 + (d.seed || 0));
    __clock.ms = 0;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, d.width / d.height, 0.01, 1000);
    camera.position.set(0, 0, 5);
    if (plugin.setup) plugin.setup(THREE, scene, camera, envOf(d, 0));
    inst = { scene, camera, key, last: -1 };
  }

  /** 推到第 frame 格：純函式插件直接跳；否則逐格推（倒退或跳太遠就從頭重跑） */
  function advance(d, frame) {
    if (!plugin.update) return;
    if (plugin.pure || frame === inst.last) {
      __clock.ms = (frame / d.fps) * 1000;
      plugin.update(frame / d.fps, envOf(d, frame));
    } else {
      if (frame < inst.last || frame - inst.last > MAX_STEP) setupInstance(d, inst.key);
      for (let f = Math.max(0, inst.last + 1); f <= frame; f++) {
        __clock.ms = (f / d.fps) * 1000;
        plugin.update(f / d.fps, envOf(d, f));
      }
    }
    inst.last = frame;
  }

  /** 畫一格，回傳 ImageBitmap */
  function renderFrame(d) {
    ensureRenderer(d.width, d.height);
    const key = JSON.stringify([d.params || {}, d.box || null, d.duration, d.fps, d.seed || 0]);
    if (!inst || inst.key !== key) setupInstance(d, key);
    frameTexture.image = d.background || black;
    frameTexture.needsUpdate = true;
    try {
      advance(d, d.frame);
      renderer.render(inst.scene, inst.camera);
    } finally {
      if (d.background) d.background.close();
    }
    return canvas.transferToImageBitmap();
  }

  /** 畫一格並數不透明的像素（vet 用：插件要真的畫出東西） */
  function litPixels(d) {
    const bitmap = renderFrame(d);
    const c = new OffscreenCanvas(64, 36);
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, 64, 36);
    bitmap.close();
    const px = ctx.getImageData(0, 0, 64, 36).data;
    let lit = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 16) lit++;
    return lit;
  }

  /** 處理一個請求 */
  function handle(d) {
    switch (d.type) {
      case 'render': {
        const bitmap = renderFrame(d);
        return [bitmap, [bitmap]];
      }
      case 'vet': {
        // 開頭、中間、結尾各畫一格（從頭建場景），至少一格有畫東西
        if (!plugin.setup || !plugin.update) throw Object.assign(new Error('3D 插件要在最外層定義 function setup(THREE, scene, camera, env) 與 function update(t, env)'), { stage: 'schema' });
        inst = null;
        const last = Math.max(0, Math.round(d.duration * d.fps) - 1);
        const lit = [0, Math.round(last / 2), last].map((frame) => litPixels({ ...d, frame }));
        if (Math.max(...lit) === 0) throw Object.assign(new Error('插件沒有畫出任何東西（三格都是全透明）'), { stage: 'blank' });
        return [{ lit }, []];
      }
      default:
        throw new Error('unknown request: ' + d.type);
    }
  }

  /** 收到請求：執行並回覆 */
  function onRequest(e) {
    const d = e.data;
    try {
      const [result, transfer] = handle(d);
      chan.postMessage({ type: 'result', id: d.id, result }, transfer);
    } catch (err) {
      chan.postMessage({ type: 'error', id: d.id, error: serializeError(err) });
    }
  }

  g.onmessage = (e) => {
    if (e.data && e.data.type === 'port') {
      chan = e.data.port;
      chan.onmessage = onRequest;
      chan.postMessage({ type: 'hello' });
    }
  };
})(globalThis);
