// 10/27 實測③：「螢幕在桌上」3D 場景（spec §5.8）。統一合成器路線（Worker）與 ffmpeg 退路（Tauri 主執行緒）共用這一份，
// 確保兩條路量到的是同一個場景、同樣的算繪成本。three.js 由呼叫端傳進來（Worker 與主執行緒各自 import），
// 這個模組本身不 import three 的執行期程式碼，只借型別。
import type * as ThreeNS from "three";

/** three.js 模組的型別 */
export type Three = typeof ThreeNS;

/** 場景設定 */
export interface Scene3DOptions {
  /** 輸出寬高（像素） */
  width: number;
  height: number;
  /** 鏡頭推近的總長度（秒）：t 從 0 到這個值，鏡頭從遠線性內插到近 */
  duration: number;
  /** 是否開 MSAA（兩條路用同樣的值） */
  antialias?: boolean;
  /** 診斷用：不更新螢幕貼圖（量貼圖上傳佔多少成本） */
  skipTexture?: boolean;
  /** 診斷用：螢幕貼圖改用 SRGBColorSpace（SRGB8_ALPHA8）的舊寫法 */
  srgbTexture?: boolean;
}

/** setup 回傳的場景控制器 */
export interface Scene3D {
  /** 算繪器（量測頁用來讀 renderer 名稱、WebGL context 做 readPixels） */
  renderer: ThreeNS.WebGLRenderer;
  /**
   * 畫一格：t＝區段內的時間（秒），bitmap＝當格的合成畫面（貼在螢幕上）。
   * 會接管 bitmap 的所有權：貼圖上傳後立刻 close()，呼叫端不要再用。
   */
  render(t: number, bitmap: ImageBitmap): void;
  /** 釋放 GPU 資源 */
  dispose(): void;
}

/** 鏡頭起點（遠）與終點（近），都看向螢幕中心 */
const CAMERA_FAR = [0.0, 4.2, 10.5] as const;
const CAMERA_NEAR = [0.0, 1.5, 3.4] as const;
/** 螢幕中心（鏡頭看向的點） */
const SCREEN_CENTER = [0, 1.25, 0] as const;

/** 線性內插 */
function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/**
 * 產生木紋色的程序貼圖（不用 DOM／canvas，Worker 與主執行緒都能跑）：
 * 橫向的深淺條紋加一點雜訊，當桌面。
 */
function makeWoodTexture(THREE: Three): ThreeNS.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    // 條紋：幾個不同頻率的正弦疊起來，模擬年輪
    const ring = Math.sin(y * 0.21) * 0.5 + Math.sin(y * 0.047 + 1.3) * 0.35 + Math.sin(y * 0.9) * 0.15;
    for (let x = 0; x < size; x++) {
      const noise = ((x * 7919 + y * 104729) % 97) / 97 - 0.5; // 固定的偽雜訊，每次都一樣
      const k = 0.62 + ring * 0.16 + noise * 0.05;
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, 168 * k + 20);
      data[i + 1] = Math.min(255, 112 * k + 12);
      data[i + 2] = Math.min(255, 66 * k + 8);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 建立「螢幕在桌上」場景：木紋桌面平面＋一塊 16:9 螢幕（貼當格合成畫面）＋深色邊框與底座，
 * 鏡頭在 duration 秒內從遠推近。
 * @param THREE three.js 模組（呼叫端 import 後傳入）
 * @param canvas 畫布（Worker 的 OffscreenCanvas 或主執行緒的 OffscreenCanvas／canvas）
 */
export function setup(THREE: Three, canvas: OffscreenCanvas | HTMLCanvasElement, options: Scene3DOptions): Scene3D {
  const { width, height, duration } = options;
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas as HTMLCanvasElement,
    antialias: options.antialias ?? true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x1a1410, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);

  // 光源：環境光＋一盞斜上方的平行光（只影響桌面與底座；螢幕自發光）
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
  sun.position.set(-4, 8, 6);
  scene.add(sun);

  // 桌面
  const desk = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 16),
    new THREE.MeshStandardMaterial({ map: makeWoodTexture(THREE), roughness: 0.75, metalness: 0 }),
  );
  desk.rotation.x = -Math.PI / 2;
  scene.add(desk);

  // 螢幕：16:9，微微後仰，下緣離桌面一小段（底座撐著）
  const screenW = 4.0;
  const screenH = screenW * 9 / 16;
  const tilt = -0.12; // 後仰角（弧度）
  const group = new THREE.Group();
  group.position.set(SCREEN_CENTER[0], SCREEN_CENTER[1], SCREEN_CENTER[2]);
  group.rotation.x = tilt;
  scene.add(group);

  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(screenW + 0.22, screenH + 0.22, 0.1),
    new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.4, metalness: 0.3 }),
  );
  group.add(bezel);

  // 螢幕面：貼圖是 ImageBitmap（第一列在最上），ImageBitmap 不支援 flipY，所以在 shader 裡翻 v。
  // 貼圖用 NoColorSpace（RGBA8）＋原樣輸出的 ShaderMaterial：畫面本來就是 sRGB 的值，原樣貼上去、不做色彩轉換。
  // 先前用 SRGBColorSpace（SRGB8_ALPHA8 貼圖格式）時，ImageBitmap 上傳每格多花約 40 ms（Arc 內顯，Chromium 156），見 RESULT.md。
  const screenTexture = new THREE.Texture();
  screenTexture.flipY = false;
  screenTexture.colorSpace = options.srgbTexture ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  screenTexture.generateMipmaps = false;
  screenTexture.minFilter = THREE.LinearFilter;
  screenTexture.magFilter = THREE.LinearFilter;
  const screenMaterial = options.srgbTexture
    ? new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false })
    : new THREE.ShaderMaterial({
      uniforms: { map: { value: screenTexture } },
      vertexShader: "varying vec2 vUv; void main() { vUv = vec2(uv.x, 1.0 - uv.y); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }",
    });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), screenMaterial);
  screen.position.z = 0.056;
  group.add(screen);

  // 底座：一根支柱＋一塊底板
  const standMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.5, metalness: 0.4 });
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.2, 0.12), standMaterial);
  neck.position.set(0, -0.95, -0.1); // 支柱上緣在螢幕後面，下緣沉進桌面下（被桌面擋住）
  group.add(neck);
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 1.0), standMaterial);
  base.position.set(0, 0.03, 0.15);
  scene.add(base);

  // 桌上的小東西：一個方塊和一個圓柱，讓鏡頭推近時有視差
  const block = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.5, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x3b7ddd, roughness: 0.6 }),
  );
  block.position.set(-3.2, 0.25, 1.2);
  block.rotation.y = 0.5;
  scene.add(block);
  const cup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.24, 0.6, 32),
    new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.3 }),
  );
  cup.position.set(3.1, 0.3, 1.6);
  scene.add(cup);

  return {
    renderer,
    render(t: number, bitmap: ImageBitmap) {
      // 鏡頭：t／duration 線性內插，從遠推到近
      const k = Math.min(1, Math.max(0, t / duration));
      camera.position.set(lerp(CAMERA_FAR[0], CAMERA_NEAR[0], k), lerp(CAMERA_FAR[1], CAMERA_NEAR[1], k), lerp(CAMERA_FAR[2], CAMERA_NEAR[2], k));
      camera.lookAt(SCREEN_CENTER[0], SCREEN_CENTER[1], SCREEN_CENTER[2]);

      // 換貼圖：新的 ImageBitmap 當 image，標記要更新
      if (!options.skipTexture) {
        screenTexture.image = bitmap;
        screenTexture.needsUpdate = true;
      }
      renderer.render(scene, camera);
      bitmap.close();
    },
    dispose() {
      renderer.dispose();
    },
  };
}
