// 測試插件（3D）：用本機打包的 three.js 在 Worker 的 OffscreenCanvas 上畫「疊加物件」：
// 一片貼著當格畫面的平面（t 秒繞 Y 軸轉），背景透明。由 build.mjs 以 esbuild 打包成 dist/three-box.js。
import * as THREE from 'three';

let renderer, scene, camera, mesh, tex;

globalThis.plugin = {
  /** 建 WebGLRenderer（用傳進來的 OffscreenCanvas）、場景、鏡頭；回傳 renderer 字串與 three 版本。 */
  init(canvas) {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true });
    renderer.setSize(canvas.width, canvas.height, false); // false：不去動 canvas.style（OffscreenCanvas 沒有）
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // 貼圖原樣輸出，不做 sRGB 轉換（否則畫素會跟輸入不同）
    camera = new THREE.PerspectiveCamera(50, canvas.width / canvas.height, 0.1, 100);
    camera.position.z = 3;
    scene = new THREE.Scene();
    tex = new THREE.Texture();
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 1.125), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    scene.add(mesh);
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), three: THREE.REVISION, webgl2: renderer.capabilities.isWebGL2 };
  },
  /** 畫一格：當格畫面（ImageBitmap）當貼圖。 */
  render(t, bitmap) {
    tex.image = bitmap;
    tex.needsUpdate = true;
    mesh.rotation.y = t;
    renderer.render(scene, camera);
  },
  probe: (v) => globalThis.__probes(v),
};
