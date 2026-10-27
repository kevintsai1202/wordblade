// 沙盒 Worker 裡的 2D 動畫 harness（spec §5.7）：接在 workerPrelude → acorn → anim_vm → anim_runtime 之後。
// 插件程式碼一律不可信：只交給原專案的直譯器（AnimVM，逐節點白名單、步數上限）執行，從不交給瀏覽器 eval；
// 這層 Worker 又在沒有 same-origin、CSP 擋網路的 iframe 裡（雙層防護）。
// 協定（資料通道是父頁轉移進來的 MessagePort）：每個請求帶 id，回覆 {type:'result', id, result} 或 {type:'error', id, error}。
//   setComponents {components}       → {hashes}：驗證並記住元件（雜湊 → 元件），之後 render 用雜湊指到元件
//   render {instance, frame, fps, duration, videoW, videoH, width, height, background?} → ImageBitmap（transfer）
//   vet {component}                  → {plugin, hash}：結構、編譯、試跑、參數變體（Vibe特效寫的程式用這個把關）
//   usesBackground {instance}        → boolean：這段動畫有沒有圖層讀下層畫面（有才需要讀回畫面）
//   manifest                         → API 說明（給 AI 的文件）
// 不能出現結束 script 標籤的字樣（雖然這支不放進 srcdoc，保持和 iframe 啟動腳本相同的規則）。
(function (g) {
  'use strict';
  // anim_runtime.js 頂層是 const AnimRuntime（全域詞法綁定，不在 globalThis 上），要直接用名稱
  // eslint-disable-next-line no-undef
  const RT = AnimRuntime;
  /** 資料通道 */
  let chan = null;
  /** 記住的元件：雜湊 → 正規化過的元件 */
  const components = Object.create(null);
  /** 畫布（依尺寸重用）與 vet 用的 1920×1080 畫布 */
  let canvas = null;
  let vetCanvas = null;
  /** 下層畫面分析用的縮圖畫布（寬 480，同原專案 ANIM_ANALYSIS_W） */
  const ANALYSIS_W = 480;
  let analysisCanvas = null;
  /** 上一格的分析資料（bg.motion 用） */
  let previous = null;

  /** 錯誤轉成可序列化的物件（AnimError 帶階段、行、欄） */
  function serializeError(e) {
    return { name: e && e.name || 'Error', message: String(e && e.message || e), stage: e && e.stage || null, line: e && e.line || null, column: e && e.column || null };
  }

  /** 取得指定尺寸的畫布（尺寸變了才重建） */
  function canvasOf(width, height) {
    if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new OffscreenCanvas(width, height);
    return canvas;
  }

  /** 把下層畫面（ImageBitmap）做成 makeBackground 要的來源：full 給 g.image，analysis 是縮圖的像素給 bg 分析 */
  function backgroundOf(bitmap) {
    if (!bitmap) return null;
    const aw = ANALYSIS_W;
    const ah = Math.max(1, Math.round(aw * bitmap.height / bitmap.width));
    if (!analysisCanvas || analysisCanvas.width !== aw || analysisCanvas.height !== ah) analysisCanvas = new OffscreenCanvas(aw, ah);
    const ac = analysisCanvas.getContext('2d', { willReadFrequently: true });
    ac.clearRect(0, 0, aw, ah);
    ac.drawImage(bitmap, 0, 0, aw, ah);
    const data = ac.getImageData(0, 0, aw, ah).data;
    const under = { full: bitmap, analysis: { data, width: aw, height: ah }, previous };
    previous = data;
    return under;
  }

  /** 處理一個請求，回傳 [結果, transfer list] */
  function handle(d) {
    switch (d.type) {
      case 'setComponents': {
        const hashes = [];
        for (const raw of d.components) {
          const plugin = RT.validateComponent(raw);
          const hash = RT.componentHash(plugin);
          components[hash] = plugin;
          hashes.push(hash);
        }
        return [{ hashes }, []];
      }
      case 'render': {
        const c = canvasOf(d.width, d.height);
        const ctx = c.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, d.width, d.height);
        const background = backgroundOf(d.background || null);
        try {
          RT.drawFrame(ctx, d.instance, components, {
            frame: d.frame, fps: d.fps, duration: d.duration, videoW: d.videoW, videoH: d.videoH, background,
            canvasFactory: (w, h) => new OffscreenCanvas(w, h),
          });
        } finally {
          if (d.background) d.background.close();
        }
        const bitmap = c.transferToImageBitmap();
        return [bitmap, [bitmap]];
      }
      case 'vet': {
        if (!vetCanvas) vetCanvas = new OffscreenCanvas(1920, 1080);
        const plugin = RT.vetComponent(vetCanvas.getContext('2d'), d.component, { lintPaths: !!d.lintPaths });
        return [{ plugin, hash: RT.componentHash(plugin) }, []];
      }
      case 'usesBackground':
        return [RT.instanceUsesBackground(d.instance, components), []];
      case 'manifest':
        return [RT.apiManifest(), []];
      default:
        throw new Error('unknown request: ' + d.type);
    }
  }

  /** 收到請求：執行並回覆（錯誤也回覆，帶 id） */
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
