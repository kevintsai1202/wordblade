'use strict';
/** 動畫執行環境（設計 docs/superpowers/specs/2026-10-06-anim-engine-design.md §2、§4～§6）：把 anim_vm.js 的直譯器接到
 *  真正的畫布與 WebAudio。元件程式碼只透過這裡建立的宿主物件作畫、發聲、讀下層畫面：
 *  - 繪圖 g：1080p 虛擬座標（高 1080、寬依片子比例），路徑、描邊畫出（progress）、漸層、文字、發光、裁切、g.image（畫下層畫面的一塊）；
 *    每個參數在邊界檢查，每格的指令數、文字量、貼圖次數都有上限。
 *  - 下層畫面 bg（§5.1）：唯讀，只回數字與座標（取色、區域平均、最亮處、找顏色、邊緣點、移動量），每格呼叫次數與分析面積有上限。
 *  - 音效 a：只記錄 tone／noise 事件，之後由 scheduleSound／renderClip 以（Offline）AudioContext 合成；雜訊用固定種子，試聽與輸出相同。
 *  - env：畫布尺寸、目標框、時間、seed 與決定性亂數 rand(i)。
 *  畫格與音效都只由 (元件, 參數, 框, 時間, 下層畫面) 決定，預覽與逐格輸出才會一致；元件的回傳值一律丟掉（用途限制，§2）。
 *  依賴：AnimVM（anim_vm.js）。實際作畫與合成音效要瀏覽器；其餘（編譯、驗證、記錄式的 g／a、bg 分析、雜湊）在 node 也能用（測試）。 */
const AnimRuntime = (() => {
  const VM = typeof AnimVM !== 'undefined' ? AnimVM : require('./anim_vm.js');
  const {AnimError} = VM;
  const VERSION = 2;               // 繪圖、音效或 bg 的行為改了就加一：素材鍵跟著換，舊畫格不會被誤用（2：框架屬性）
  const MAX_COMMANDS = 5000;       // 每格最多幾個繪圖指令
  const MAX_TEXT = 200;            // 每段文字最多幾字
  const MAX_TEXT_PER_FRAME = 600;  // 每格文字總量（不能拿來排版長文）
  const MAX_IMAGES = 16;           // 每格最多幾次 g.image（每次都可能複製一大塊原尺寸畫面）
  const MAX_SAVE_DEPTH = 32;       // save 巢狀上限
  const MAX_SOUND_EVENTS = 32;     // 一段音效最多幾個音源
  const MAX_SOUND_SECONDS = 10;    // 一段音效最長幾秒
  const MAX_BG_CALLS = 64;         // 每格最多呼叫幾次 bg 的分析方法
  const MAX_BG_PIXELS = 2000000;   // 每格 bg 分析的像素總量（約 15 張 480 寬縮圖），擋住在一格內反覆掃整張畫面
  const MAX_EDGE_POINTS = 512;     // bg.edges 最多回幾個點
  const SMOKE_SLOW_MS = 400;       // 試跑時畫一格超過這麼久就不採用
  const SOUND_RATE = 48000;        // 輸出音效的取樣率
  /** 字型：鍵 → CSS 字型堆疊。只收 Windows 內建、canvas 實測畫得出來的字型（中文都落在微軟正黑體）。 */
  const FONTS = {
    sans: '"Microsoft JhengHei", "Segoe UI", Arial, sans-serif',
    display: 'Impact, "Arial Black", "Microsoft JhengHei", sans-serif',
    rounded: '"Segoe UI", "Microsoft JhengHei", Arial, sans-serif',
    mono: 'Consolas, "Courier New", "Microsoft JhengHei", monospace',
  };
  const CAPS = new Set(['butt', 'round', 'square']), JOINS = new Set(['miter', 'round', 'bevel']);
  const ALIGNS = new Set(['left', 'center', 'right']), BASELINES = new Set(['top', 'middle', 'alphabetic', 'bottom']);
  const RULES = new Set(['nonzero', 'evenodd']);
  const WAVES = new Set(['sine', 'square', 'sawtooth', 'triangle']), FILTERS = new Set(['lowpass', 'highpass', 'bandpass']);

  // ---- 參數檢查（宿主函式收到的都是直譯器的值：數字、字串、沒有原型的物件、陣列） ----
  const fail = msg => { throw new AnimError(msg); };
  /** 讀物件參數的欄位（只認自己的鍵）。 */
  function field(o, k) { return VM.isDataObject(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function num(v, name, lo, hi, dflt) {
    if (v === undefined || v === null) { if (dflt === undefined) fail(`${name} 需要數字`); return dflt; }
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} 必須是有限的數字`);
    return Math.min(hi, Math.max(lo, v));
  }
  /** 顏色只收 #RGB、#RRGGBB、#RRGGBBAA（避免把任意 CSS 字串交給畫布）。 */
  function color(v, name, dflt) {
    if (v === undefined || v === null) { if (dflt === undefined) fail(`${name} 需要顏色`); return dflt; }
    if (typeof v !== 'string' || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) fail(`${name} 顏色格式要是 #RRGGBB`);
    return v;
  }
  function pick(v, set, name, dflt) {
    if (v === undefined || v === null) return dflt;
    if (!set.has(v)) fail(`${name} 只能是 ${[...set].join('、')}`);
    return v;
  }
  const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const chars = s => [...s].length;
  /** 直譯器看得懂的資料物件（沒有原型）：宿主函式回傳物件一律經過這裡。 */
  const rec = o => Object.assign(Object.create(null), o);
  const round2 = v => Math.round(v * 100) / 100, round4 = v => Math.round(v * 10000) / 10000, round6 = v => Math.round(v * 1e6) / 1e6;

  // ---- 繪圖 ----
  /** 建立繪圖宿主物件。ctx 是 CanvasRenderingContext2D（或測試用的記錄器），呼叫前已縮放成 1080p 虛擬座標。
   *  路徑長度自己累計，描邊 progress 以虛線長度實作「畫出前段」。每格（每次 draw）建一個新的，計數從零開始。 */
  function makeGraphics(ctx, {alpha: baseAlpha = 1} = {}) {
    let commands = 0, depth = 0, textChars = 0, images = 0;
    let pathLength = 0, lastX = 0, lastY = 0, startX = 0, startY = 0;
    const alphaStack = [baseAlpha];  // 框架給的起始透明度（圖層 opacity × 淡入淡出），插件的 g.alpha 再相乘
    const count = () => { if (++commands > MAX_COMMANDS) fail(`每格最多 ${MAX_COMMANDS} 個繪圖指令`); };
    const point = (x, y, name) => [num(x, name + ' 的 x', -1e5, 1e5), num(y, name + ' 的 y', -1e5, 1e5)];
    const track = (x, y) => { pathLength += Math.hypot(x - lastX, y - lastY); lastX = x; lastY = y; };
    const alpha = () => alphaStack[alphaStack.length - 1];
    /** 以 16 段折線估計曲線長度。 */
    const curveLength = (f) => { let len = 0, [px, py] = f(0); for (let i = 1; i <= 16; i++) { const [x, y] = f(i / 16); len += Math.hypot(x - px, y - py); px = x; py = y; } return len; };
    function gradient(spec, name) {
      const type = pick(field(spec, 'type'), new Set(['linear', 'radial']), name + '.type', 'linear');
      const stops = field(spec, 'stops');
      if (!Array.isArray(stops) || stops.length < 2 || stops.length > 8) fail(`${name}.stops 要 2～8 個 [位置, 顏色]`);
      const c = k => num(field(spec, k), `${name}.${k}`, -1e5, 1e5);
      const g = type === 'linear' ? ctx.createLinearGradient(c('x0'), c('y0'), c('x1'), c('y1'))
        : ctx.createRadialGradient(c('x0'), c('y0'), num(field(spec, 'r0'), name + '.r0', 0, 1e5, 0), c('x1'), c('y1'), num(field(spec, 'r1'), name + '.r1', 0, 1e5));
      for (const s of stops) {
        if (!Array.isArray(s) || s.length !== 2) fail(`${name}.stops 每一項要是 [位置, 顏色]`);
        g.addColorStop(num(s[0], name + ' 的位置', 0, 1), color(s[1], name + ' 的顏色'));
      }
      return g;
    }
    function paint(opts, name) {
      const grad = field(opts, 'gradient');
      return grad !== undefined ? gradient(grad, name + '.gradient') : color(field(opts, 'color'), name + '.color', '#ffffff');
    }
    /** 文字只收字串或數字，並累計這一格的文字量。 */
    function textOf(str, name) {
      const s = typeof str === 'string' ? str : typeof str === 'number' ? String(str) : str === undefined || str === null ? '' : fail(`${name} 的文字要是字串或數字`);
      const n = chars(s);
      if (n > MAX_TEXT) fail(`${name} 每段最多 ${MAX_TEXT} 字`);
      return [s, n];
    }
    function applyFont(opts) {
      const key = field(opts, 'font') === undefined ? 'sans' : field(opts, 'font');
      if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(FONTS, key)) fail(`字型只能是 ${Object.keys(FONTS).join('、')}`);
      const w = field(opts, 'weight');
      const weight = w === undefined ? 700 : w === 'bold' ? 700 : w === 'normal' ? 400 : num(w, 'text.weight', 100, 900);
      ctx.font = `${Math.round(weight / 100) * 100} ${num(field(opts, 'size'), 'text.size', 4, 600, 64).toFixed(1)}px ${FONTS[key]}`;
    }
    const H = VM.hostFunction;
    const api = {
      begin: H('g.begin', () => { count(); ctx.beginPath(); pathLength = 0; lastX = lastY = startX = startY = 0; return null; }),
      moveTo: H('g.moveTo', (x, y) => { count(); [x, y] = point(x, y, 'moveTo'); ctx.moveTo(x, y); lastX = startX = x; lastY = startY = y; return null; }),
      lineTo: H('g.lineTo', (x, y) => { count(); [x, y] = point(x, y, 'lineTo'); ctx.lineTo(x, y); track(x, y); return null; }),
      quadTo: H('g.quadTo', (cx, cy, x, y) => {
        count(); [cx, cy] = point(cx, cy, 'quadTo'); [x, y] = point(x, y, 'quadTo');
        const x0 = lastX, y0 = lastY; pathLength += curveLength(u => [(1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * x, (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * cy + u * u * y]);
        ctx.quadraticCurveTo(cx, cy, x, y); lastX = x; lastY = y; return null;
      }),
      curveTo: H('g.curveTo', (c1x, c1y, c2x, c2y, x, y) => {
        count(); [c1x, c1y] = point(c1x, c1y, 'curveTo'); [c2x, c2y] = point(c2x, c2y, 'curveTo'); [x, y] = point(x, y, 'curveTo');
        const x0 = lastX, y0 = lastY, b = (a, p, q, r, u) => (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * p + 3 * (1 - u) * u * u * q + u ** 3 * r;
        pathLength += curveLength(u => [b(x0, c1x, c2x, x, u), b(y0, c1y, c2y, y, u)]);
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, x, y); lastX = x; lastY = y; return null;
      }),
      arc: H('g.arc', (x, y, r, a0, a1, ccw) => {
        count(); [x, y] = point(x, y, 'arc'); r = num(r, 'arc 的半徑', 0, 1e5); a0 = num(a0, 'arc 的起始角', -1e3, 1e3, 0); a1 = num(a1, 'arc 的結束角', -1e3, 1e3, Math.PI * 2);
        ctx.arc(x, y, r, a0, a1, !!ccw); pathLength += r * Math.abs(a1 - a0); lastX = x + r * Math.cos(a1); lastY = y + r * Math.sin(a1); return null;
      }),
      ellipse: H('g.ellipse', (x, y, rx, ry, rot, a0, a1) => {
        count(); [x, y] = point(x, y, 'ellipse'); rx = num(rx, 'ellipse 的 rx', 0, 1e5); ry = num(ry, 'ellipse 的 ry', 0, 1e5);
        rot = num(rot, 'ellipse 的旋轉', -1e3, 1e3, 0); a0 = num(a0, 'ellipse 的起始角', -1e3, 1e3, 0); a1 = num(a1, 'ellipse 的結束角', -1e3, 1e3, Math.PI * 2);
        ctx.ellipse(x, y, rx, ry, rot, a0, a1);
        pathLength += Math.abs(a1 - a0) * Math.sqrt((rx * rx + ry * ry) / 2); return null;
      }),
      rect: H('g.rect', (x, y, w, h) => { count(); [x, y] = point(x, y, 'rect'); [w, h] = point(w, h, 'rect 的寬高'); ctx.rect(x, y, w, h); pathLength += 2 * (Math.abs(w) + Math.abs(h)); return null; }),
      roundRect: H('g.roundRect', (x, y, w, h, r) => {
        count(); [x, y] = point(x, y, 'roundRect'); [w, h] = point(w, h, 'roundRect 的寬高'); r = num(r, 'roundRect 的圓角', 0, 1e4, 0);
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)); else ctx.rect(x, y, w, h);
        pathLength += 2 * (Math.abs(w) + Math.abs(h)) - (8 - 2 * Math.PI) * Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2); return null;
      }),
      circle: H('g.circle', (x, y, r) => {
        count(); [x, y] = point(x, y, 'circle'); r = num(r, 'circle 的半徑', 0, 1e5);
        ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); pathLength += 2 * Math.PI * r; lastX = startX = x + r; lastY = startY = y; return null;
      }),
      line: H('g.line', (x1, y1, x2, y2) => { count(); [x1, y1] = point(x1, y1, 'line'); [x2, y2] = point(x2, y2, 'line'); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); pathLength += Math.hypot(x2 - x1, y2 - y1); lastX = x2; lastY = y2; return null; }),
      close: H('g.close', () => { count(); ctx.closePath(); track(startX, startY); return null; }),
      stroke: H('g.stroke', opts => {
        count();
        ctx.save();
        ctx.strokeStyle = paint(opts, 'stroke');
        ctx.lineWidth = num(field(opts, 'width'), 'stroke.width', 0.1, 300, 4);
        ctx.lineCap = pick(field(opts, 'cap'), CAPS, 'stroke.cap', 'round');
        ctx.lineJoin = pick(field(opts, 'join'), JOINS, 'stroke.join', 'round');
        ctx.globalAlpha = alpha() * num(field(opts, 'alpha'), 'stroke.alpha', 0, 1, 1);
        const progress = num(field(opts, 'progress'), 'stroke.progress', 0, 1, 1);
        const dash = field(opts, 'dash');
        if (progress < 1) {
          // 描邊畫出：虛線長度＝路徑長×進度、間隔＝整條路徑，畫出來的就是路徑的前段
          const len = Math.max(pathLength, 0.001); ctx.setLineDash([len * progress, len + 1]); ctx.lineDashOffset = 0;
        } else if (dash !== undefined) {
          if (!Array.isArray(dash) || dash.length > 8) fail('stroke.dash 要是最多 8 個數字的陣列');
          ctx.setLineDash(dash.map(d => num(d, 'stroke.dash', 0, 1e4)));
          ctx.lineDashOffset = num(field(opts, 'dashOffset'), 'stroke.dashOffset', -1e5, 1e5, 0);
        }
        if (progress > 0) ctx.stroke();
        ctx.restore();
        return null;
      }),
      fill: H('g.fill', opts => {
        count();
        ctx.save(); ctx.fillStyle = paint(opts, 'fill');
        ctx.globalAlpha = alpha() * num(field(opts, 'alpha'), 'fill.alpha', 0, 1, 1);
        ctx.fill(pick(field(opts, 'rule'), RULES, 'fill.rule', 'nonzero')); ctx.restore(); return null;
      }),
      /** 以目前路徑裁切（之後畫的東西只留在路徑內，g.restore 解除）：放大鏡、聚光燈用。 */
      clip: H('g.clip', opts => { count(); ctx.clip(pick(field(opts, 'rule'), RULES, 'clip.rule', 'nonzero')); return null; }),
      text: H('g.text', (str, x, y, opts) => {
        count();
        const [s, n] = textOf(str, 'g.text');
        textChars += n;
        if (textChars > MAX_TEXT_PER_FRAME) fail(`每格文字總量最多 ${MAX_TEXT_PER_FRAME} 字`);
        [x, y] = point(x, y, 'text');
        ctx.save();
        applyFont(opts);
        ctx.textAlign = pick(field(opts, 'align'), ALIGNS, 'text.align', 'center');
        ctx.textBaseline = pick(field(opts, 'baseline'), BASELINES, 'text.baseline', 'middle');
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = num(field(opts, 'letterSpacing'), 'text.letterSpacing', -20, 200, 0) + 'px';
        ctx.globalAlpha = alpha() * num(field(opts, 'alpha'), 'text.alpha', 0, 1, 1);
        const shadow = field(opts, 'shadow');
        if (shadow !== undefined) {
          ctx.shadowColor = color(field(shadow, 'color'), 'text.shadow.color', '#000000');
          ctx.shadowBlur = num(field(shadow, 'blur'), 'text.shadow.blur', 0, 100, 0);
          ctx.shadowOffsetX = num(field(shadow, 'x'), 'text.shadow.x', -200, 200, 0);
          ctx.shadowOffsetY = num(field(shadow, 'y'), 'text.shadow.y', -200, 200, 0);
        }
        const outline = field(opts, 'outline');
        if (outline !== undefined) {
          ctx.lineJoin = 'round'; ctx.strokeStyle = color(outline, 'text.outline');
          ctx.lineWidth = num(field(opts, 'outlineWidth'), 'text.outlineWidth', 0, 80, 6);
          ctx.strokeText(s, x, y);
          ctx.shadowColor = 'transparent';  // 陰影只跟著描邊畫一次，填色不再疊一層
        }
        ctx.fillStyle = paint(opts, 'text');
        ctx.fillText(s, x, y);
        ctx.restore();
        return null;
      }),
      measure: H('g.measure', (str, opts) => {
        count(); const [s] = textOf(str, 'g.measure');
        ctx.save(); applyFont(opts); const w = ctx.measureText(s).width; ctx.restore(); return w;
      }),
      /** 把下層畫面的一塊（虛擬座標 sx, sy, sw, sh）畫到 (dx, dy, dw, dh)；來源換成原尺寸像素。沒有下層畫面時什麼都不畫。 */
      image: H('g.image', (bg, sx, sy, sw, sh, dx, dy, dw, dh) => {
        count();
        if (++images > MAX_IMAGES) fail(`g.image 每格最多 ${MAX_IMAGES} 次`);
        if (!bgSources.has(bg)) fail('g.image 的第一個參數要是 bg（下層畫面）');
        [sx, sy] = point(sx, sy, 'image 的來源'); [sw, sh] = point(sw, sh, 'image 的來源寬高'); [dx, dy] = point(dx, dy, 'image 的位置');
        dw = dw === undefined ? sw : num(dw, 'image 的寬', -1e5, 1e5); dh = dh === undefined ? sh : num(dh, 'image 的高', -1e5, 1e5);
        const src = bgSources.get(bg);
        if (!src || !src.full || sw <= 0 || sh <= 0) return null;
        const kx = src.full.width / src.virtualW, ky = src.full.height / src.virtualH;
        ctx.save(); ctx.globalAlpha = alpha();
        ctx.drawImage(src.full, sx * kx, sy * ky, sw * kx, sh * ky, dx, dy, dw, dh);
        ctx.restore();
        return null;
      }),
      save: H('g.save', () => { count(); if (++depth > MAX_SAVE_DEPTH) fail(`g.save 最多巢狀 ${MAX_SAVE_DEPTH} 層`); ctx.save(); alphaStack.push(alpha()); return null; }),
      restore: H('g.restore', () => { count(); if (depth <= 0) return null; depth--; ctx.restore(); alphaStack.pop(); return null; }),
      translate: H('g.translate', (x, y) => { count(); [x, y] = point(x, y, 'translate'); ctx.translate(x, y); return null; }),
      rotate: H('g.rotate', a => { count(); ctx.rotate(num(a, 'rotate 的角度', -1e3, 1e3)); return null; }),
      scale: H('g.scale', (sx, sy) => { count(); sx = num(sx, 'scale 的 x', -100, 100); ctx.scale(sx, sy === undefined ? sx : num(sy, 'scale 的 y', -100, 100)); return null; }),
      alpha: H('g.alpha', a => { count(); alphaStack[alphaStack.length - 1] *= num(a, 'alpha', 0, 1); return null; }),
      glow: H('g.glow', opts => {
        count();
        if (opts === null || opts === undefined) { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; return null; }
        ctx.shadowColor = color(field(opts, 'color'), 'glow.color', '#ffffff'); ctx.shadowBlur = num(field(opts, 'blur'), 'glow.blur', 0, 200, 20);
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; return null;
      }),
    };
    return VM.hostObject('g', api);
  }

  // ---- 讀下層畫面（§5.1） ----
  /** bg 宿主物件 → 來源 {full, virtualW, virtualH}（沒有下層畫面時是 null）。g.image 靠它認出真的 bg；元件程式碼拿不到這張表。 */
  const bgSources = new WeakMap();
  const luminance = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  function hexRgb(hex) {
    const h = hex.length <= 5 ? hex.slice(1, 4).split('').map(c => c + c).join('') : hex.slice(1, 7);
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }
  /** 建立唯讀的下層畫面物件 bg。src 為 null（沒有下層畫面、試跑的一半）時一律回中性值，元件照樣能跑。
   *  src = {analysis: {width, height, data}（寬 480 的分析縮圖，RGBA）, previous: 前一格同尺寸縮圖的 data 或 null,
   *         virtualW, virtualH（1080p 虛擬座標的寬高）, full: 原尺寸畫面（canvas，給 g.image）或 null}。
   *  所有座標都是虛擬座標；回傳的顏色是 0～255 整數、亮度 0～1（四位小數）、座標兩位小數。 */
  function makeBackground(src) {
    const A = src && src.analysis && src.analysis.data && src.analysis.width > 0 && src.analysis.height > 0 ? src.analysis : null;
    const VW = A ? src.virtualW : 1920, VH = A ? src.virtualH : 1080;
    const kx = A ? A.width / VW : 0, ky = A ? A.height / VH : 0;  // 虛擬座標 → 分析縮圖像素
    const prev = A && src.previous && src.previous.length === A.data.length ? src.previous : null;
    const d = A ? A.data : null, W = A ? A.width : 0;
    const L = i => luminance(d[i], d[i + 1], d[i + 2]);
    let calls = 0, pixels = 0;
    const begin = name => { if (++calls > MAX_BG_CALLS) fail(`每格最多呼叫 ${MAX_BG_CALLS} 次 bg 的分析方法（${name}）`); };
    const spend = n => { pixels += n; if (pixels > MAX_BG_PIXELS) fail('這一格 bg 分析的範圍太大（區域加起來超過上限），請縮小區域或減少呼叫'); };
    /** 讀區域參數（省略＝整張），回 {vx, vy, vw, vh, px}；px 是分析縮圖上的 [x0, y0, x1, y1)，沒有畫面或區域是空的時為 null。 */
    function area(x, y, w, h, name) {
      let vx = 0, vy = 0, vw = VW, vh = VH;
      if (!(x === undefined && y === undefined && w === undefined && h === undefined)) {
        vx = num(x, name + ' 的 x', -1e5, 1e5); vy = num(y, name + ' 的 y', -1e5, 1e5);
        vw = num(w, name + ' 的 w', -1e5, 1e5); vh = num(h, name + ' 的 h', -1e5, 1e5);
        if (vw < 0) { vx += vw; vw = -vw; }
        if (vh < 0) { vy += vh; vh = -vh; }
      }
      let px = null;
      if (A) {
        const x0 = clampInt(Math.floor(vx * kx), 0, W), x1 = clampInt(Math.ceil((vx + vw) * kx), 0, W);
        const y0 = clampInt(Math.floor(vy * ky), 0, A.height), y1 = clampInt(Math.ceil((vy + vh) * ky), 0, A.height);
        if (x1 > x0 && y1 > y0) px = [x0, y0, x1, y1];
      }
      return {vx, vy, vw, vh, px};
    }
    const H = VM.hostFunction;
    const api = {
      available: !!A,
      sample: H('bg.sample', (x, y) => {
        begin('sample'); x = num(x, 'sample 的 x', -1e5, 1e5); y = num(y, 'sample 的 y', -1e5, 1e5);
        if (!A) return rec({r: 0, g: 0, b: 0, l: 0});
        spend(1);
        const i = (clampInt(Math.floor(y * ky), 0, A.height - 1) * W + clampInt(Math.floor(x * kx), 0, W - 1)) * 4;
        return rec({r: d[i], g: d[i + 1], b: d[i + 2], l: round4(L(i))});
      }),
      average: H('bg.average', (x, y, w, h) => {
        begin('average'); const {px} = area(x, y, w, h, 'average');
        if (!px) return rec({r: 0, g: 0, b: 0, l: 0});
        const [x0, y0, x1, y1] = px, n = (x1 - x0) * (y1 - y0); spend(n);
        let r = 0, g = 0, b = 0;
        for (let yy = y0; yy < y1; yy++) for (let i = (yy * W + x0) * 4, e = (yy * W + x1) * 4; i < e; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        r /= n; g /= n; b /= n;
        return rec({r: Math.round(r), g: Math.round(g), b: Math.round(b), l: round4(luminance(r, g, b))});
      }),
      /** 最亮處：亮度在最大值 0.01 以內的像素的中心（一整片同樣亮時是那一片的中間）；沒有畫面時回區域中心、亮度 0。 */
      brightest: H('bg.brightest', (x, y, w, h) => {
        begin('brightest'); const {vx, vy, vw, vh, px} = area(x, y, w, h, 'brightest');
        if (!px) return rec({x: round2(vx + vw / 2), y: round2(vy + vh / 2), l: 0});
        const [x0, y0, x1, y1] = px; spend(2 * (x1 - x0) * (y1 - y0));
        let max = -1;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const l = L((yy * W + xx) * 4); if (l > max) max = l; }
        let sx = 0, sy = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) if (L((yy * W + xx) * 4) >= max - 0.01) { sx += xx; sy += yy; n++; }
        return rec({x: round2((sx / n + 0.5) / kx), y: round2((sy / n + 0.5) / ky), l: round4(max)});
      }),
      /** 找顏色：每個色版都在 ±tolerance（0～255，預設 32）內的像素的外框與個數；找不到（或沒有畫面）回 null。 */
      find: H('bg.find', (hex, tolerance, x, y, w, h) => {
        begin('find');
        const [cr, cg, cb] = hexRgb(color(hex, 'find 的顏色')), tol = num(tolerance, 'find 的容差', 0, 255, 32);
        const {px} = area(x, y, w, h, 'find');
        if (!px) return null;
        const [x0, y0, x1, y1] = px; spend((x1 - x0) * (y1 - y0));
        let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0, i = (yy * W + x0) * 4; xx < x1; xx++, i += 4) {
          if (Math.abs(d[i] - cr) <= tol && Math.abs(d[i + 1] - cg) <= tol && Math.abs(d[i + 2] - cb) <= tol) {
            count++; if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
          }
        }
        if (!count) return null;
        return rec({x: round2(minX / kx), y: round2(minY / ky), w: round2((maxX + 1 - minX) / kx), h: round2((maxY + 1 - minY) / ky), count});
      }),
      /** 邊緣點：亮度的 Sobel 梯度（步階 0→1 為 1）≥ threshold（預設 0.25）的像素中心，依列序、超過 512 個時等距取樣。 */
      edges: H('bg.edges', (x, y, w, h, threshold) => {
        begin('edges');
        const {px} = area(x, y, w, h, 'edges'), th = num(threshold, 'edges 的門檻', 0.01, 1, 0.25);
        if (!px) return [];
        const [x0, y0, x1, y1] = px, rw = x1 - x0, rh = y1 - y0; spend(4 * rw * rh);
        // 區域外多取一圈（夾在畫面內）才算得出邊上的梯度
        const lw = rw + 2, lh = rh + 2, lum = new Float32Array(lw * lh);
        for (let j = 0; j < lh; j++) {
          const yy = clampInt(y0 + j - 1, 0, A.height - 1);
          for (let k = 0; k < lw; k++) lum[j * lw + k] = L((yy * W + clampInt(x0 + k - 1, 0, W - 1)) * 4);
        }
        const hits = [];
        for (let j = 1; j <= rh; j++) for (let k = 1; k <= rw; k++) {
          const o = j * lw + k;
          const gx = lum[o - lw + 1] + 2 * lum[o + 1] + lum[o + lw + 1] - lum[o - lw - 1] - 2 * lum[o - 1] - lum[o + lw - 1];
          const gy = lum[o + lw - 1] + 2 * lum[o + lw] + lum[o + lw + 1] - lum[o - lw - 1] - 2 * lum[o - lw] - lum[o - lw + 1];
          if (Math.hypot(gx, gy) / 4 >= th) hits.push(x0 + k - 1, y0 + j - 1);
        }
        const n = hits.length / 2, take = Math.min(n, MAX_EDGE_POINTS), out = [];
        for (let i = 0; i < take; i++) { const m = Math.floor(i * n / take); out.push(rec({x: round2((hits[2 * m] + 0.5) / kx), y: round2((hits[2 * m + 1] + 0.5) / ky)})); }
        return out;
      }),
      /** 移動量：與前一格的亮度差平均（0～1）；沒有前一格時是 0。 */
      motion: H('bg.motion', (x, y, w, h) => {
        begin('motion'); const {px} = area(x, y, w, h, 'motion');
        if (!px || !prev) return 0;
        const [x0, y0, x1, y1] = px, n = (x1 - x0) * (y1 - y0); spend(2 * n);
        let s = 0;
        for (let yy = y0; yy < y1; yy++) for (let i = (yy * W + x0) * 4, e = (yy * W + x1) * 4; i < e; i += 4) s += Math.abs(L(i) - luminance(prev[i], prev[i + 1], prev[i + 2]));
        return round4(s / n);
      }),
    };
    const bg = VM.hostObject('bg', api);
    bgSources.set(bg, A ? {full: src.full || null, virtualW: VW, virtualH: VH} : null);
    return bg;
  }
  let synthetic = null;
  /** 試跑用的合成下層畫面（480×270，虛擬 1920×1080）：深灰漸層底、白色面板、紅色按鈕、藍色底列；
   *  前一格的紅色按鈕在左邊 8 像素處（移動量不是零）。不給原尺寸畫面（g.image 檢查參數後不畫）。 */
  function syntheticBackground() {
    if (synthetic) return synthetic;
    const W = 480, H = 270;
    const paintFrame = shift => {
      const data = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let r = (30 + x * 60 / W) | 0, g = r, b = r + 10;
        if (x >= 40 && x < 240 && y >= 30 && y < 150) r = g = b = 245;
        if (x >= 300 + shift && x < 380 + shift && y >= 180 && y < 215) { r = 230; g = 40; b = 40; }
        if (y >= 240) { r = 30; g = 90; b = 200; }
        const i = (y * W + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
      }
      return data;
    };
    synthetic = {analysis: {width: W, height: H, data: paintFrame(0)}, previous: paintFrame(-8), virtualW: 1920, virtualH: 1080, full: null};
    return synthetic;
  }

  // ---- 音效 ----
  /** 建立音效宿主物件：只記錄事件，scheduleSound 才真的合成。 */
  function makeAudio(events) {
    const add = ev => { if (events.length >= MAX_SOUND_EVENTS) fail(`一段音效最多 ${MAX_SOUND_EVENTS} 個音源`); events.push(ev); return null; };
    const timing = (o, name) => {
      const at = num(field(o, 'at'), name + '.at', 0, MAX_SOUND_SECONDS, 0), dur = num(field(o, 'dur'), name + '.dur', 0.01, MAX_SOUND_SECONDS, 0.3);
      if (at + dur > MAX_SOUND_SECONDS + 1e-9) fail(`音效最長 ${MAX_SOUND_SECONDS} 秒`);
      const attack = num(field(o, 'attack'), name + '.attack', 0, dur, Math.min(0.01, dur / 4));
      const release = num(field(o, 'release'), name + '.release', 0, dur, Math.min(0.08, dur / 2));
      return {at, dur, attack, release, gain: num(field(o, 'gain'), name + '.gain', 0, 1, 0.5), pan: num(field(o, 'pan'), name + '.pan', -1, 1, 0)};
    };
    return VM.hostObject('a', {
      tone: VM.hostFunction('a.tone', o => {
        const freq = num(field(o, 'freq'), 'tone.freq', 20, 20000, 440);
        return add({kind: 'tone', wave: pick(field(o, 'type'), WAVES, 'tone.type', 'sine'), freq, freqEnd: num(field(o, 'freqEnd'), 'tone.freqEnd', 20, 20000, freq), ...timing(o, 'tone')});
      }),
      noise: VM.hostFunction('a.noise', o => {
        const f = field(o, 'filter');
        const filter = f === undefined ? null : {type: pick(field(f, 'type'), FILTERS, 'noise.filter.type', 'bandpass'),
          freq: num(field(f, 'freq'), 'noise.filter.freq', 20, 20000, 1000), q: num(field(f, 'q'), 'noise.filter.q', 0.1, 30, 1)};
        if (filter) filter.freqEnd = num(field(f, 'freqEnd'), 'noise.filter.freqEnd', 20, 20000, filter.freq);
        return add({kind: 'noise', color: pick(field(o, 'color'), new Set(['white', 'pink']), 'noise.color', 'white'), filter, ...timing(o, 'noise')});
      }),
    });
  }
  /** 決定性亂數（mulberry32）：同一個種子永遠同一串，雜訊在預覽與輸出一致。 */
  function seeded(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /** 由 seed 與 i 決定的均勻亂數（0～1）：整數雜湊（lowbias32），同一組永遠同一個值、與呼叫順序無關。 */
  function hashRand(seed, i) {
    let x = (seed ^ Math.imul(i | 0, 0x9E3779B9)) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad); x ^= x >>> 15; x = Math.imul(x, 0x735a2d97); x ^= x >>> 15;
    return (x >>> 0) / 4294967296;
  }
  /** 把一段音效的事件排進 AudioContext 或 OfflineAudioContext（從 offset 秒起），回傳最後結束的秒數。 */
  function scheduleSound(ac, destination, events, offset = 0, seed = 1) {
    let end = 0;
    for (const [i, ev] of events.entries()) {
      const t0 = offset + ev.at, t1 = t0 + ev.dur;
      const attack = Math.max(0.001, ev.attack), release = Math.max(0.001, ev.release), peakEnd = Math.max(t0 + attack, t1 - release);
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(ev.gain, t0 + attack);
      gain.gain.setValueAtTime(ev.gain, peakEnd);
      gain.gain.linearRampToValueAtTime(0, Math.max(peakEnd + 0.001, t1));
      const pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
      if (pan) { pan.pan.value = ev.pan; gain.connect(pan); pan.connect(destination); } else gain.connect(destination);
      let source;
      if (ev.kind === 'tone') {
        source = ac.createOscillator(); source.type = ev.wave;
        source.frequency.setValueAtTime(ev.freq, t0);
        if (ev.freqEnd !== ev.freq) source.frequency.exponentialRampToValueAtTime(ev.freqEnd, t1);
        source.connect(gain);
      } else {
        const n = Math.max(1, Math.ceil(ev.dur * ac.sampleRate)), buf = ac.createBuffer(1, n, ac.sampleRate), data = buf.getChannelData(0), rnd = seeded(seed * 7919 + i);
        let b0 = 0, b1 = 0, b2 = 0;
        for (let k = 0; k < n; k++) {
          const w = rnd() * 2 - 1;
          if (ev.color === 'pink') { b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913; data[k] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
          else data[k] = w;
        }
        source = ac.createBufferSource(); source.buffer = buf;
        if (ev.filter) {
          const f = ac.createBiquadFilter(); f.type = ev.filter.type; f.Q.value = ev.filter.q;
          f.frequency.setValueAtTime(ev.filter.freq, t0);
          if (ev.filter.freqEnd !== ev.filter.freq) f.frequency.exponentialRampToValueAtTime(ev.filter.freqEnd, t1);
          source.connect(f); f.connect(gain);
        } else source.connect(gain);
      }
      source.start(t0); source.stop(t1 + 0.01);
      end = Math.max(end, t1);
    }
    return end;
  }
  /** 把一段動畫的各段音效（soundClips 的結果）排進 AudioContext：試聽與預覽用，與輸出的 renderClip 是同一套事件與種子。 */
  function scheduleClips(ac, destination, clips, offset = 0) {
    let end = 0;
    for (const c of clips) end = Math.max(end, scheduleSound(ac, destination, c.events, offset + c.at, c.seed));
    return end;
  }
  /** 以 OfflineAudioContext 把一段音效合成成 AudioBuffer（48 kHz 雙聲道、最長 10 秒多一點）。 */
  async function renderClip(clip) {
    const length = Math.max(1, Math.ceil((Math.min(MAX_SOUND_SECONDS, clip.seconds) + 0.02) * SOUND_RATE));
    const ac = new OfflineAudioContext(2, length, SOUND_RATE);
    scheduleSound(ac, ac.destination, clip.events, 0, clip.seed);
    return ac.startRendering();
  }
  /** AudioBuffer → 16-bit PCM WAV（Uint8Array）。 */
  function wavBytes(buffer) {
    const ch = buffer.numberOfChannels, n = buffer.length, rate = buffer.sampleRate, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt '); out.setUint32(16, 16, true);
    out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, rate, true); out.setUint32(28, rate * ch * 2, true);
    out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const chans = [...Array(ch).keys()].map(c => buffer.getChannelData(c));
    for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 0x7fff, true);
    return new Uint8Array(out.buffer);
  }

  // ---- 元件 ----
  const PARAM_TYPES = new Set(['number', 'color', 'enum', 'boolean', 'text', 'point', 'font', 'easing', 'angle', 'duration', 'direction']);
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/, HEX6 = /^#[0-9a-fA-F]{6}$/;
  /** 程式碼裡（含字串）不能出現的字詞：與引擎 core.ANIM_DENIED_WORDS 同一份（scripts/anim-runtime-unit.js 比對）。
   *  真正的護欄是直譯器；這份清單讓前端先擋下引擎存草稿時會拒收的元件，免得自動保存一直失敗。 */
  const DENIED_WORDS = /\b(?:eval|Function|globalThis|window|document|fetch|XMLHttpRequest|WebSocket|importScripts|postMessage|setTimeout|setInterval|localStorage|sessionStorage|indexedDB|Proxy|Reflect|constructor|prototype|__proto__|__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__)\b/;
  /** 檢查並正規化元件 JSON（§4）：只留認得的欄位，參數表的預設值要合型別與範圍，程式碼要通過護欄並定義入口函式。
   *  內建、AI 寫的、同步下來的元件都經過這裡；不合格丟 AnimError（訊息說明哪裡不對）。 */
  function validateComponent(raw) {
    const bad = msg => { throw new AnimError('元件格式不對：' + msg); };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('要是物件');
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) bad('id 只能是英數、底線、連字號（1～64 字）');
    if (raw.kind !== 'visual' && raw.kind !== 'sound') bad('kind 只能是 visual 或 sound');
    const version = raw.version === undefined ? 1 : raw.version;
    if (!Number.isInteger(version) || version < 1 || version > 1e6) bad('version 要是正整數');
    if (typeof raw.name !== 'string' || !raw.name.trim()) bad('名稱不能空白');
    if (chars(raw.name.trim()) > 30) bad('名稱最多 30 字');
    const description = raw.description === undefined ? '' : raw.description;
    if (typeof description !== 'string' || chars(description) > 120) bad('說明要是 120 字以內的文字');
    const tags = raw.tags === undefined ? [] : raw.tags;
    if (!Array.isArray(tags) || tags.length > 8 || tags.some(t => typeof t !== 'string' || !t.trim() || chars(t.trim()) > 16)) bad('標籤最多 8 個、每個 1～16 字');
    const params = raw.params === undefined ? {} : raw.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) bad('params 要是物件');
    const keys = Object.keys(params);
    if (keys.length > 16) bad('參數最多 16 個');
    const outParams = {};
    for (const key of keys) {
      if (!PARAM_RE.test(key) || VM.isDeniedName(key)) bad(`參數名稱「${key}」不能用（英文字母、數字、底線，不能是保留字）`);
      outParams[key] = paramDef(params[key], key, bad);
    }
    // schema 2 的選填欄位（插件框架 §2.2）：有給才檢查、才保留；不影響雜湊（雜湊只算 kind／params／code）
    const extra = {};
    if (raw.schema !== undefined) { if (raw.schema !== 1 && raw.schema !== 2) bad('schema 只能是 1 或 2'); extra.schema = raw.schema; }
    if (raw.category !== undefined) { if (!CATEGORIES.includes(raw.category)) bad(`category 只能是 ${CATEGORIES.join('、')}`); extra.category = raw.category; }
    if (raw.preview !== undefined) {
      const pv = raw.preview;
      if (!pv || typeof pv !== 'object' || Array.isArray(pv)) bad('preview 要是 {t, box}');
      const t = pv.t === undefined ? 1 : pv.t; if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > MAX_SECONDS) bad('preview.t 要是 0～60 的秒數');
      const box = pv.box === undefined ? {w: 0.3, h: 0.2} : pv.box;
      if (!box || typeof box !== 'object' || ![box.w, box.h].every(v => typeof v === 'number' && v >= 0.02 && v <= 1)) bad('preview.box 要是 {w, h}（0.02～1）');
      extra.preview = {t, box: {w: box.w, h: box.h}};
    }
    if (typeof raw.code !== 'string') bad('code 要是字串');
    VM.compile(raw.code, {entry: raw.kind === 'sound' ? 'sound' : 'draw'});
    const banned = raw.code.match(DENIED_WORDS);  // 編譯過了才查（語法錯誤的訊息帶行號，比較好改）
    if (banned) bad(`程式碼不能出現「${banned[0]}」（字串裡也不行）`);  // 護欄：語法白名單、上限、入口函式（錯誤帶行號）
    return {id: raw.id, version, kind: raw.kind, name: raw.name.trim(), description, tags: tags.map(t => t.trim()), params: outParams, code: raw.code, ...extra};
  }
  /** 檢查一個參數定義並回傳正規化的副本。 */
  function paramDef(def, key, bad) {
    const where = `參數「${key}」`;
    if (!def || typeof def !== 'object' || Array.isArray(def)) bad(`${where}要是物件`);
    if (!PARAM_TYPES.has(def.type)) bad(`${where}的 type 只能是 ${[...PARAM_TYPES].join('、')}`);
    const out = {type: def.type};
    if (def.label !== undefined) {
      if (typeof def.label !== 'string' || chars(def.label) > 20) bad(`${where}的 label 最多 20 字`);
      out.label = def.label;
    }
    const d = def.default;
    switch (def.type) {
      case 'number':
        if (![def.min, def.max].every(v => typeof v === 'number' && Number.isFinite(v))) bad(`${where}要有有限的 min 與 max`);
        if (def.min > def.max) bad(`${where}的 min 不能大於 max`);
        if (def.step !== undefined && !(typeof def.step === 'number' && Number.isFinite(def.step) && def.step > 0)) bad(`${where}的 step 要是正數`);
        if (typeof d !== 'number' || !Number.isFinite(d) || d < def.min || d > def.max) bad(`${where}的預設值要在 min～max 之間`);
        Object.assign(out, {min: def.min, max: def.max, default: d});
        if (def.step !== undefined) out.step = def.step;
        break;
      case 'color':
        if (typeof d !== 'string' || !HEX6.test(d)) bad(`${where}的預設值要是 #RRGGBB`);
        out.default = d.toLowerCase();
        if (def.role !== undefined) { if (!ROLES.includes(def.role)) bad(`${where}的 role 只能是 ${ROLES.join('、')}`); out.role = def.role; }  // 實例的 palette 依角色覆蓋
        break;
      case 'font':
        if (!Object.prototype.hasOwnProperty.call(FONTS, d)) bad(`${where}的預設值要是 ${Object.keys(FONTS).join('、')}`);
        out.default = d;
        break;
      case 'easing':
        if (!EASINGS.includes(d)) bad(`${where}的預設值要是 ease 的名稱（${EASINGS.join('、')}）`);
        out.default = d;
        break;
      case 'angle': case 'duration': {
        const lo = def.type === 'angle' ? -360 : 0, hi = def.type === 'angle' ? 360 : MAX_SECONDS;
        const min = def.min === undefined ? lo : def.min, max = def.max === undefined ? hi : def.max;
        if (![min, max].every(v => typeof v === 'number' && Number.isFinite(v)) || min < lo || max > hi || min > max) bad(`${where}的 min／max 要在 ${lo}～${hi} 之間`);
        if (typeof d !== 'number' || !Number.isFinite(d) || d < min || d > max) bad(`${where}的預設值要在 min～max 之間`);
        Object.assign(out, {min, max, default: d});
        break;
      }
      case 'direction':
        if (def.allowAuto !== undefined && typeof def.allowAuto !== 'boolean') bad(`${where}的 allowAuto 要是 true 或 false`);
        if (!DIRECTIONS.includes(d) && !(def.allowAuto && d === 'auto')) bad(`${where}的預設值要是八個方向之一`);
        out.default = d; if (def.allowAuto) out.allowAuto = true;
        break;
      case 'enum': {
        const vals = def.values;
        if (!Array.isArray(vals) || !vals.length || vals.length > 16 || vals.some(v => typeof v !== 'string' || !v || chars(v) > 32) || new Set(vals).size !== vals.length) bad(`${where}的 values 要是 1～16 個不重複的文字`);
        if (!vals.includes(d)) bad(`${where}的預設值要是 values 其中之一`);
        Object.assign(out, {values: [...vals], default: d});
        if (def.labels !== undefined) {
          if (!Array.isArray(def.labels) || def.labels.length !== vals.length || def.labels.some(l => typeof l !== 'string' || chars(l) > 20)) bad(`${where}的 labels 要與 values 一樣多、每個最多 20 字`);
          out.labels = [...def.labels];
        }
        break;
      }
      case 'boolean':
        if (typeof d !== 'boolean') bad(`${where}的預設值要是 true 或 false`);
        out.default = d;
        break;
      case 'text': {
        const max = def.maxLength === undefined ? MAX_TEXT : def.maxLength;
        if (!Number.isInteger(max) || max < 1 || max > MAX_TEXT) bad(`${where}的 maxLength 要是 1～${MAX_TEXT}`);
        if (typeof d !== 'string' || chars(d) > max) bad(`${where}的預設值要是 ${max} 字以內的文字`);
        out.default = d;
        if (def.maxLength !== undefined) out.maxLength = max;
        break;
      }
      case 'point':
        if (!d || typeof d !== 'object' || ![d.x, d.y].every(v => typeof v === 'number' && v >= 0 && v <= 1)) bad(`${where}的預設值要是 {x, y}（0～1）`);
        out.default = {x: d.x, y: d.y};
        break;
    }
    return out;
  }
  /** 依參數表驗證並補預設；不認得的鍵丟掉。回傳一般物件（交給直譯器時再轉成沒有原型的物件）。 */
  function resolveParams(defs, given, palette) {
    const out = {};
    for (const [key, def] of Object.entries(defs || {})) {
      const v = given && Object.prototype.hasOwnProperty.call(given, key) ? given[key] : undefined;
      const d = def.default;
      switch (def.type) {
        case 'number': case 'angle': case 'duration': out[key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, v)) : d; break;
        case 'color': {
          const pal = def.role && palette && typeof palette[def.role] === 'string' && HEX68.test(palette[def.role]) ? palette[def.role].toLowerCase() : null;  // 實例配色優先
          out[key] = pal || (typeof v === 'string' && HEX6.test(v) ? v.toLowerCase() : d); break;
        }
        case 'font': out[key] = typeof v === 'string' && Object.prototype.hasOwnProperty.call(FONTS, v) ? v : d; break;
        case 'easing': out[key] = EASINGS.includes(v) ? v : d; break;
        case 'direction': out[key] = DIRECTIONS.includes(v) || (def.allowAuto && v === 'auto') ? v : d; break;
        case 'enum': out[key] = (def.values || []).includes(v) ? v : d; break;
        case 'boolean': out[key] = typeof v === 'boolean' ? v : !!d; break;
        case 'text': out[key] = typeof v === 'string' ? [...v].slice(0, def.maxLength || MAX_TEXT).join('') : d; break;
        case 'point': out[key] = v && typeof v.x === 'number' && typeof v.y === 'number' && Number.isFinite(v.x) && Number.isFinite(v.y)
          ? {x: Math.min(1, Math.max(0, v.x)), y: Math.min(1, Math.max(0, v.y))} : d; break;
        default: out[key] = d;
      }
    }
    return out;
  }
  /** 入口名稱 → (程式碼 → 編譯結果或錯誤)：同一份程式碼只解析一次（每格都會呼叫）。 */
  const compiled = {draw: new Map(), sound: new Map()};
  /** 編譯元件（含護欄），失敗丟 AnimError；成功與失敗都快取。 */
  function compileComponent(comp) {
    const entry = comp.kind === 'sound' ? 'sound' : 'draw', cache = compiled[entry];
    let hit = cache.get(comp.code);
    if (!hit) {
      try { hit = {program: VM.compile(comp.code, {entry})}; } catch (e) { hit = {error: e}; }
      if (cache.size >= 256) cache.clear();
      cache.set(comp.code, hit);
    }
    if (hit.error) throw hit.error;
    return hit.program;
  }
  /** 元件有沒有用到下層畫面：draw 有第五個參數、而且函式裡讀到它（解構或給預設值時保守當成有）。
   *  只有用到的元件，輸出時才要逐格定位播放器準備下層畫面（§5.1）。 */
  function usesBackground(comp) {
    if (!comp || comp.kind !== 'visual') return false;
    const binding = compileComponent(comp).module.vars.get('draw');
    const fn = binding && binding.value && binding.value.node;
    if (!fn || fn.params.length < 5) return false;
    const p = fn.params[4];
    return p.type !== 'Identifier' || referencesName(fn.body, p.name, null, null);
  }
  /** 語法樹裡有沒有讀到這個名稱（屬性名不算）。 */
  function referencesName(node, name, parent, key) {
    if (!node || typeof node.type !== 'string') return false;
    if (node.type === 'Identifier' && node.name === name) {
      if (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
      if (parent && parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) return false;
      return true;
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'type') continue;
      const child = node[k];
      if (Array.isArray(child)) { for (const c of child) if (referencesName(c, name, node, k)) return true; }
      else if (child && typeof child.type === 'string' && referencesName(child, name, node, k)) return true;
    }
    return false;
  }
  /** 一段動畫有沒有任何圖層用到下層畫面。 */
  function instanceUsesBackground(instance, components) {
    return (instance.layers || []).some(l => usesBackground(components[l.component]));
  }

  // ---- 雜湊 ----
  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  /** SHA-256（同步，回十六進位）：元件雜湊與素材鍵用。瀏覽器的 crypto.subtle 是非同步，草稿與預覽的路徑不方便等它。 */
  function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text), len = bytes.length, total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total); buf.set(bytes); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000)); dv.setUint32(total - 4, (len * 8) >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, k] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
    }
    return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
  }
  /** 排序鍵的 JSON：同樣內容永遠同一個字串（數字照 JSON 規則）。 */
  function stableJson(v) {
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  const hash32 = v => sha256Hex(stableJson(v)).slice(0, 32);
  /** 元件內容雜湊（SHA-256 前 128 位元，32 位十六進位）：草稿與素材以它記住用到的元件版本，元件庫改版不會改到做好的動畫。 */
  function componentHash(comp) { return hash32({kind: comp.kind, params: comp.params || {}, code: comp.code}); }
  /** 畫格素材鍵：一段動畫逐格畫面的所有輸入（各圖層元件內容、參數、起訖、框、id（亂數種子）、輸出尺寸、fps、格數、字型指紋，
   *  有圖層用到 bg 時再加下層內容 under），任一改變就換鍵、重畫。 */
  function frameKey(instance, components, {width, height, fps, frames, fonts, under}) {
    const layers = (instance.layers || []).map(l => {
      const comp = components[l.component];
      return {...normalizeLayer(l), component: comp ? componentHash(comp) : null};  // 框架屬性（正規化後）也決定畫格
    });
    return hash32({v: VERSION, id: instance.id, box: instance.box || null, palette: normalizePalette(instance.palette), layers, width, height, fps: String(fps), frames, fonts: fonts || '',
      under: instanceUsesBackground(instance, components) ? (under === undefined ? null : under) : null});
  }
  /** 音效素材鍵（一段音效一個）：事件與種子完全決定合成結果。 */
  function soundKey(clip) { return hash32({v: VERSION, rate: SOUND_RATE, seed: clip.seed, seconds: clip.seconds, events: clip.events}); }
  function hashSeed(text) { let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }


  // ---- 框架屬性（設計 2026-10-20-anim-plugin-framework-design.md §8）：由框架在呼叫 draw 之前套用，插件只管在 env.box 裡畫 ----
  const EASINGS = Object.keys(VM.EASE);                                   // easing 名稱（anim_vm.js 的 EASE 表）
  const ANCHORS = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const DIRECTIONS = ['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];  // direction 型別的八方向
  const SIDES = ['left', 'right', 'top', 'bottom'];                        // 進場／退場的方向
  const ENTER_TYPES = ['fade', 'slide', 'pop', 'bounce', 'wipe'], EXIT_TYPES = ['fade', 'slide', 'shrink', 'wipe'];
  const EMPHASIS_TYPES = ['pulse', 'shake', 'wiggle', 'bounce', 'blink'], LOOP_MODES = ['restart', 'pingpong'];
  const ROLES = ['primary', 'secondary', 'text', 'outline'];              // 顏色參數的角色：實例的 palette 依角色覆蓋
  const CATEGORIES = ['pointer', 'emphasis', 'text', 'overlay', 'feedback', 'fx', 'sound'];  // 插件分類（schema 2，介面分組與 AI 挑底稿用）
  const MAX_PATH_POINTS = 200, MAX_SECONDS = 60;
  const MAX_OUTLINE_STEPS = 5;                                            // 描邊的偏移步數上限（8 方向 × 步數張整畫布貼圖）
  const HEX68 = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  /** 子物件的預設值（給了物件但欄位省略時補上）。 */
  const SUB_DEFAULTS = {
    shadow: {color: '#00000080', blur: 12, dx: 0, dy: 4}, outline: {color: '#ffffff', width: 4}, loop: {count: 1, mode: 'restart'},
    enter: {type: 'fade', from: 'left', duration: 0.5, ease: 'outCubic'}, exit: {type: 'fade', to: 'right', duration: 0.3, ease: 'linear'},
    emphasis: {type: 'pulse', period: 0.8, strength: 0.5},
  };
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const nnum = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const npick = (v, list, d) => (list.includes(v) ? v : d);
  const ncolor = (v, d) => (typeof v === 'string' && HEX68.test(v) ? v.toLowerCase() : d);
  /** 圖層正規化：補預設、夾範圍、丟掉不認得的鍵。drawFrame 與 frameKey 都用它，省略欄位與明寫預設值得到同一個素材鍵。 */
  function normalizeLayer(layer) {
    const l = isObj(layer) ? layer : {}, tf = isObj(l.transform) ? l.transform : {}, fd = isObj(l.fade) ? l.fade : {};
    const out = {
      component: l.component, params: isObj(l.params) ? l.params : {}, start: nnum(l.start, 0, MAX_SECONDS, 0), end: l.end == null ? null : nnum(l.end, 0, MAX_SECONDS, null),
      transform: {dx: nnum(tf.dx, -2000, 2000, 0), dy: nnum(tf.dy, -2000, 2000, 0), anchor: npick(tf.anchor, ANCHORS, 'center'), scale: nnum(tf.scale, 0.1, 10, 1), rotate: nnum(tf.rotate, -360, 360, 0)},
      opacity: nnum(l.opacity, 0, 1, 1),
      fade: {in: nnum(fd.in, 0, MAX_SECONDS, 0), out: nnum(fd.out, 0, MAX_SECONDS, 0), easeIn: npick(fd.easeIn, EASINGS, 'outCubic'), easeOut: npick(fd.easeOut, EASINGS, 'linear')},
      path: null, shadow: null, outline: null, loop: null, enter: null, exit: null, emphasis: null, fill: null,
    };
    // WordBlade（2026-11-02）：圖片填色——texture 是 drawFrame 的 textures 陣列索引，repeat 是畫面高度內平鋪幾次，mix 是蓋多少
    if (isObj(l.fill) && Number.isInteger(l.fill.texture) && l.fill.texture >= 0 && l.fill.texture < 16) {
      out.fill = {texture: l.fill.texture, repeat: nnum(l.fill.repeat, 0.25, 20, 2), mix: nnum(l.fill.mix, 0, 1, 1)};
    }
    if (Array.isArray(l.path) && l.path.length) {
      const pts = []; let last = -1;
      for (const p of l.path.slice(0, MAX_PATH_POINTS)) {
        if (!isObj(p)) continue;
        const t = nnum(p.t, 0, MAX_SECONDS, NaN); if (!Number.isFinite(t) || t < last) continue;  // 時間不能倒退
        last = t; pts.push({t, cx: nnum(p.cx, 0, 1, 0.5), cy: nnum(p.cy, 0, 1, 0.5)});
      }
      if (pts.length) out.path = pts;
    }
    const S = SUB_DEFAULTS;
    if (isObj(l.shadow)) out.shadow = {color: ncolor(l.shadow.color, S.shadow.color), blur: nnum(l.shadow.blur, 0, 100, S.shadow.blur), dx: nnum(l.shadow.dx, -200, 200, S.shadow.dx), dy: nnum(l.shadow.dy, -200, 200, S.shadow.dy)};
    if (isObj(l.outline)) out.outline = {color: ncolor(l.outline.color, S.outline.color), width: nnum(l.outline.width, 0, 20, S.outline.width)};
    if (isObj(l.loop)) out.loop = {count: Math.round(nnum(l.loop.count, 1, 100, S.loop.count)), mode: npick(l.loop.mode, LOOP_MODES, S.loop.mode)};
    if (isObj(l.enter)) out.enter = {type: npick(l.enter.type, ENTER_TYPES, S.enter.type), from: npick(l.enter.from, SIDES, S.enter.from), duration: nnum(l.enter.duration, 0, MAX_SECONDS, S.enter.duration), ease: npick(l.enter.ease, EASINGS, S.enter.ease)};
    if (isObj(l.exit)) out.exit = {type: npick(l.exit.type, EXIT_TYPES, S.exit.type), to: npick(l.exit.to, SIDES, S.exit.to), duration: nnum(l.exit.duration, 0, MAX_SECONDS, S.exit.duration), ease: npick(l.exit.ease, EASINGS, S.exit.ease)};
    if (isObj(l.emphasis)) out.emphasis = {type: npick(l.emphasis.type, EMPHASIS_TYPES, S.emphasis.type), period: nnum(l.emphasis.period, 0.1, 10, S.emphasis.period), strength: nnum(l.emphasis.strength, 0, 1, S.emphasis.strength)};
    return out;
  }
  /** 實例的配色：只留合法顏色。 */
  function normalizePalette(p) {
    if (!isObj(p)) return null;
    const out = {}; for (const r of ROLES) { const c = ncolor(p[r], null); if (c) out[r] = c; }
    return Object.keys(out).length ? out : null;
  }
  /** 路徑在 t 秒的位置（線性內插；超出首尾就停在首尾）。 */
  function pathAt(path, t) {
    if (t <= path[0].t) return path[0];
    for (let i = 1; i < path.length; i++) {
      if (t <= path[i].t) { const a = path[i - 1], b = path[i], u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1; return {cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u}; }
    }
    return path[path.length - 1];
  }
  /** 錨點在框上的位置（虛擬像素）。 */
  function anchorPoint(box, anchor) {
    const fx = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : 0.5, fy = anchor.includes('top') ? 0 : anchor.includes('bottom') ? 1 : 0.5;
    return [box.x + box.w * fx, box.y + box.h * fy];
  }
  /** 框架動作：以圖層本地時間 tl（整個圖層區間 len 秒）算出淡入淡出、進場、退場、強調合起來的位移、縮放、旋轉、透明度與裁切。
   *  進場的 slide 從畫布外開始（框中心推到邊緣外再多一個框的寬／高，插件可能畫在框外）；wipe 用整個畫布寬的裁切框。 */
  function frameworkMotion(layer, tl, len, {width, height, box}) {
    const E = VM.EASE, m = {dx: 0, dy: 0, scale: 1, rotate: 0, alpha: 1, clip: null};
    const slideOff = (side, u) => {  // u：1＝完全在畫布外、0＝原位
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      if (side === 'left') m.dx -= (cx + box.w) * u; else if (side === 'right') m.dx += (width - cx + box.w) * u;
      else if (side === 'top') m.dy -= (cy + box.h) * u; else m.dy += (height - cy + box.h) * u;
    };
    const wipeClip = (side, u) => {  // u：0～1 露出的比例
      if (side === 'top') m.clip = [0, 0, width, height * u]; else if (side === 'bottom') m.clip = [0, height * (1 - u), width, height * u];
      else if (side === 'left') m.clip = [0, 0, width * u, height]; else m.clip = [width * (1 - u), 0, width * u, height];
    };
    const f = layer.fade;
    if (f.in > 0 && tl < f.in) m.alpha *= E[f.easeIn](Math.max(0, tl / f.in));
    if (f.out > 0 && len - tl < f.out) m.alpha *= E[f.easeOut](Math.max(0, (len - tl) / f.out));
    const en = layer.enter;
    if (en && en.duration > 0 && tl < en.duration) {
      const u = Math.min(1, Math.max(0, tl / en.duration)), e = E[en.ease](u);
      if (en.type === 'fade') m.alpha *= e;
      else if (en.type === 'slide') slideOff(en.from, 1 - e);
      else if (en.type === 'pop') m.scale *= Math.max(0, E.outBack(u));
      else if (en.type === 'bounce') m.scale *= Math.max(0, E.outBounce(u));
      else if (en.type === 'wipe') wipeClip(en.from, e);
    }
    const ex = layer.exit;
    if (ex && ex.duration > 0 && len - tl < ex.duration) {
      const u = Math.min(1, Math.max(0, (len - tl) / ex.duration)), e = E[ex.ease](u);  // e：1＝還沒開始退、0＝退完
      if (ex.type === 'fade') m.alpha *= e;
      else if (ex.type === 'slide') slideOff(ex.to, 1 - e);
      else if (ex.type === 'shrink') m.scale *= Math.max(0, e);
      else if (ex.type === 'wipe') wipeClip(ex.to, e);
    }
    const em = layer.emphasis;
    if (em && em.strength > 0) {
      const w = Math.sin(2 * Math.PI * tl / em.period), k = em.strength;
      if (em.type === 'pulse') m.scale *= 1 + 0.15 * k * w;
      else if (em.type === 'shake') m.dx += 20 * k * w;
      else if (em.type === 'wiggle') m.rotate += 6 * k * w;
      else if (em.type === 'bounce') m.dy -= 30 * k * Math.abs(Math.sin(Math.PI * tl / em.period));
      else if (em.type === 'blink') m.alpha *= 1 - k * (0.5 + 0.5 * w);
    }
    return m;
  }
  const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
  /** 有陰影或描邊的圖層：先畫到離屏畫布，描邊＝把離屏圖染成描邊色（另一張離屏畫布上 source-in）後往 8 個方向偏移疊上，
   *  陰影＝最後畫本體時設 shadow*。全部在裝置像素下合成（寬度與偏移乘 scale）。canvasFactory(w, h, name) 給畫布（anim.js 會重用）。 */
  function compositeLayer(ctx, layer, paint, canvasFactory, scale, alpha, textures) {
    const W = ctx.canvas.width, H = ctx.canvas.height;
    // WordBlade：沙盒 Worker 裡沒有 document，改用 OffscreenCanvas
    const factory = canvasFactory || ((w, h) => { if (typeof document === 'undefined') return new OffscreenCanvas(w, h); const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
    const off = factory(W, H, 'layer'), oc = off.getContext('2d');
    oc.save(); oc.setTransform(1, 0, 0, 1, 0, 0); oc.globalCompositeOperation = 'source-over'; oc.clearRect(0, 0, W, H); oc.restore();
    paint(oc);
    // WordBlade：圖片填色——圖層形狀保留，顏色換成平鋪的材質圖（source-atop 只蓋在已經畫了的地方），在描邊與陰影之前
    const img = layer.fill && textures ? textures[layer.fill.texture] : null;
    if (img && img.width > 0 && img.height > 0) {
      const pattern = oc.createPattern(img, 'repeat');
      if (pattern) {
        const tile = H / layer.fill.repeat / img.height;
        if (pattern.setTransform && typeof DOMMatrix !== 'undefined') pattern.setTransform(new DOMMatrix().scale(tile, tile));
        oc.save(); oc.setTransform(1, 0, 0, 1, 0, 0); oc.globalCompositeOperation = 'source-atop'; oc.globalAlpha = layer.fill.mix;
        oc.fillStyle = pattern; oc.fillRect(0, 0, W, H); oc.restore();
      }
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = alpha;  // 整層透明度在合成時套（插件內重疊的筆畫不會各自半透明）
    try {
      if (layer.outline && layer.outline.width > 0) {
        const tint = factory(W, H, 'tint'), tc = tint.getContext('2d');
        tc.save(); tc.setTransform(1, 0, 0, 1, 0, 0); tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, W, H); tc.drawImage(off, 0, 0);
        tc.globalCompositeOperation = 'source-in'; tc.fillStyle = layer.outline.color; tc.fillRect(0, 0, W, H); tc.globalCompositeOperation = 'source-over'; tc.restore();
        const w = layer.outline.width * scale, steps = Math.min(MAX_OUTLINE_STEPS, Math.max(1, Math.ceil(layer.outline.width / 2)));  // 每步 8 張整畫布的 drawImage，封頂控制輸出時間
        for (let s = 1; s <= steps; s++) { const r = w * s / steps; for (const [ux, uy] of DIRS8) ctx.drawImage(tint, ux * r, uy * r); }
      }
      if (layer.shadow) { ctx.shadowColor = layer.shadow.color; ctx.shadowBlur = layer.shadow.blur * scale; ctx.shadowOffsetX = layer.shadow.dx * scale; ctx.shadowOffsetY = layer.shadow.dy * scale; }
      ctx.drawImage(off, 0, 0);
    } finally { ctx.restore(); }
  }

  // ---- 畫格與音效 ----
  /** env：畫布尺寸（1080p 虛擬座標）、目標框、時間、seed 與 rand(i)。 */
  function makeEnv({width, height, box, duration, fps, frame, seed}) {
    const t = frame / fps, s = seed >>> 0;
    return {width, height, box, duration, fps, frame, t, progress: duration > 0 ? Math.min(1, t / duration) : 1, seed: s,
      rand: VM.hostFunction('env.rand', i => hashRand(s, Math.floor(typeof i === 'number' && Number.isFinite(i) ? i : 0)))};
  }
  /** 畫一段動畫的某一格：ctx 的畫布尺寸是輸出或預覽尺寸，先縮放成 1080p 虛擬座標再依序畫各圖層。
   *  instance 是草稿的動畫；components 是 雜湊 → 元件；frame 是動畫開始後的第幾格；videoW／videoH 決定虛擬畫布寬度；
   *  background 是下層畫面（makeBackground 的 src，可省略）；onError(錯誤, 圖層序號) 給了就略過出錯的圖層繼續畫，否則丟出。 */
  function drawFrame(ctx, instance, components, {frame, fps, duration, videoW, videoH, background, onError, canvasFactory, textures}) {
    const scale = ctx.canvas.height / 1080, width = 1080 * videoW / videoH, height = 1080;
    const b = instance.box || {cx: 0.5, cy: 0.5, w: 0.3, h: 0.2};
    const baseBox = {x: (b.cx - b.w / 2) * width, y: (b.cy - b.h / 2) * height, w: b.w * width, h: b.h * height};
    const palette = normalizePalette(instance.palette);
    const under = background ? {...background, virtualW: width, virtualH: height} : null;
    for (const [i, raw] of (instance.layers || []).entries()) {
      try {
        const comp = components[raw.component];
        if (!comp || comp.kind !== 'visual') throw new AnimError(`找不到圖層 ${i + 1} 的元件`);
        const layer = normalizeLayer(raw);
        const start = layer.start, end = layer.end == null ? duration : layer.end, len = Math.max(0, end - start);
        const tl = frame / fps - start;  // 圖層本地時間（整個區間）
        if (tl < 0 || frame / fps > end) continue;
        // 重播：只重映插件看到的 t 與 env.duration；淡入淡出、進退場、強調仍以整段算
        let t = tl, segDur = len;
        if (layer.loop && layer.loop.count > 1 && len > 0) {
          segDur = len / layer.loop.count;
          const k = Math.min(layer.loop.count - 1, Math.floor(tl / segDur)); let lt = tl - k * segDur;
          if (layer.loop.mode === 'pingpong' && k % 2 === 1) lt = segDur - lt;
          t = lt;
        }
        // 路徑：框中心照時間內插，寬高不變
        const box = {...baseBox};
        if (layer.path) { const c = pathAt(layer.path, tl); box.x = c.cx * width - box.w / 2; box.y = c.cy * height - box.h / 2; }
        const m = frameworkMotion(layer, tl, len, {width, height, box}), tf = layer.transform;
        const program = compileComponent(comp);
        const env = makeEnv({width, height, box, duration: segDur, fps, frame: Math.round(t * fps), seed: hashSeed(instance.id + ':' + i)});
        const params = resolveParams(comp.params, layer.params, palette);
        for (const [key, def] of Object.entries(comp.params || {})) if (def.type === 'point') params[key] = {x: params[key].x * width, y: params[key].y * height};  // 進 draw 前換成虛擬像素
        const [ax, ay] = anchorPoint(box, tf.anchor);
        /** 在某張畫布上畫這個圖層（主畫布或離屏畫布）：縮放成虛擬座標 → 裁切 → 錨點變形 → draw。 */
        const paint = c2 => {
          c2.save(); c2.setTransform(scale, 0, 0, scale, 0, 0);
          try {
            if (m.clip) { c2.beginPath(); c2.rect(...m.clip); c2.clip(); }
            c2.translate(ax + tf.dx + m.dx, ay + tf.dy + m.dy); c2.rotate((tf.rotate + m.rotate) * Math.PI / 180); c2.scale(tf.scale * m.scale, tf.scale * m.scale); c2.translate(-ax, -ay);
            program.call('draw', [makeGraphics(c2), t, params, env, makeBackground(under)]);
          } finally { c2.restore(); }
        };
        const alpha = layer.opacity * m.alpha;
        if (alpha <= 0) continue;
        // 整層透明度、陰影、描邊都要先畫到離屏畫布再合成；都沒有就直接畫在主畫布（和以前一樣快）
        if (alpha < 1 || layer.shadow || layer.fill || (layer.outline && layer.outline.width > 0)) compositeLayer(ctx, layer, paint, canvasFactory, scale, alpha, textures);
        else paint(ctx);
      } catch (e) {
        if (!onError) throw e;
        onError(e, i);
      }
    }
  }
  /** 一段動畫的音效，每個音效圖層一段：[{index, at（相對動畫起點，秒）, seconds（長度）, events（相對這段的起點）, seed}]。
   *  起點在動畫結束之後的整段略過、結尾超過的截短；每段 ≤ 10 秒，輸出時各自合成成 WAV（記憶體有上限）。 */
  function soundClips(instance, components, {duration}) {
    const clips = [];
    for (const [i, s] of (instance.sounds || []).entries()) {
      const comp = components[s.component];
      if (!comp || comp.kind !== 'sound') throw new AnimError(`找不到音效 ${i + 1} 的元件`);
      const at = Math.max(0, typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0), room = round6(duration - at);
      if (room <= 0) continue;
      const seed = hashSeed(instance.id + ':s' + i), raw = [];
      compileComponent(comp).call('sound', [makeAudio(raw), resolveParams(comp.params, s.params), {duration: room, seed}]);
      const events = raw.filter(ev => ev.at < room).map(ev => ({...ev, dur: Math.min(ev.dur, Math.max(0.01, round6(room - ev.at)))}));
      if (!events.length) continue;
      clips.push({index: i, at, seconds: round6(Math.max(...events.map(ev => ev.at + ev.dur))), events, seed});
    }
    return clips;
  }


  // ---- API 清單與 vet 試跑（設計 2026-10-20-anim-plugin-framework-design.md §10.2）----
  /** 每個宿主成員一行說明：apiManifest 由實際成員產生、單元測試要求每個成員都在這裡有文件（規格不再手寫，避免漂移）。
   *  這份清單同時是第三階段給 AI 的 API 參考。 */
  const DOCS = {
    g: {
      begin: 'g.begin()：開始新路徑', moveTo: 'g.moveTo(x, y)', lineTo: 'g.lineTo(x, y)', quadTo: 'g.quadTo(cx, cy, x, y)：二次貝茲', curveTo: 'g.curveTo(c1x, c1y, c2x, c2y, x, y)：三次貝茲',
      arc: 'g.arc(x, y, r, a0, a1, ccw?)：圓弧（弧度）', ellipse: 'g.ellipse(x, y, rx, ry, rot?, a0?, a1?)', rect: 'g.rect(x, y, w, h)', roundRect: 'g.roundRect(x, y, w, h, r)',
      circle: 'g.circle(x, y, r)：整圓', line: 'g.line(x0, y0, x1, y1)：一段線（含 begin）', close: 'g.close()：封閉路徑',
      stroke: 'g.stroke({color, width, cap, join, dash, dashOffset, alpha, progress})：描邊；cap 只能 "butt"|"round"|"square"，join 只能 "miter"|"round"|"bevel"，dash 是數字陣列；progress 0～1 只畫路徑前段（描邊畫出）',
      fill: 'g.fill({color, alpha, gradient:{type:"linear"|"radial", x0,y0,x1,y1 | x,y,r, stops:[[0,"#f00"],[1,"#00f"]]}, rule:"nonzero"|"evenodd"})：填色',
      clip: 'g.clip({rule})：以目前路徑裁切，g.restore 解除；rule 只能 "nonzero"|"evenodd"',
      text: 'g.text(str, x, y, {size, weight, font, color, align, baseline, outline, outlineWidth, shadow, gradient, letterSpacing})：文字（≤ 200 字）；font 只能 "sans"|"display"|"rounded"|"mono"，align 只能 "left"|"center"|"right"，baseline 只能 "top"|"middle"|"alphabetic"|"bottom"，outline 是描邊顏色',
      measure: 'g.measure(str, {size, weight, font}) → 寬度', image: 'g.image(bg, sx, sy, sw, sh, dx, dy, dw, dh)：把下層畫面的一塊畫上來（第一個參數一定是 bg）',
      save: 'g.save()', restore: 'g.restore()', translate: 'g.translate(dx, dy)', rotate: 'g.rotate(rad)', scale: 'g.scale(sx, sy)',
      alpha: 'g.alpha(a)：之後的作畫乘上透明度（到 restore）', glow: 'g.glow({color, blur})：之後的作畫帶發光；g.glow(null) 關閉',
    },
    a: {
      tone: 'a.tone({type:"sine"|"square"|"sawtooth"|"triangle", freq, freqEnd, at, dur, attack, release, gain, pan})：純音；時間都是秒（at 相對音效起點），gain 0～1、pan -1～1',
      noise: 'a.noise({color:"white"|"pink", at, dur, filter:{type:"lowpass"|"highpass"|"bandpass", freq, freqEnd, q}, attack, release, gain, pan})：雜訊',
    },
    bg: {
      available: 'bg.available：有沒有下層畫面（沒有時所有方法回中性值）', sample: 'bg.sample(x, y) → {r, g, b, l}', average: 'bg.average(x, y, w, h) → {r, g, b, l}',
      brightest: 'bg.brightest(x, y, w, h) → {x, y, l}', find: 'bg.find(color, tolerance, x, y, w, h) → {x, y, w, h, count} 或 null（一定要處理 null）',
      edges: 'bg.edges(x, y, w, h, threshold) → [{x, y}]（≤ 512 點）', motion: 'bg.motion(x, y, w, h) → 0～1 與前一格的差異',
    },
    env: {
      width: '虛擬畫布寬（高固定 1080）', height: '虛擬畫布高（1080）', box: '目標框 {x, y, w, h}（虛擬像素；框架已套路徑與偏移）', duration: '這個圖層（或重播的一段）的長度（秒）',
      fps: '每秒格數', frame: '第幾格', t: '動畫開始後的秒數', progress: 't／duration（0～1）', seed: '亂數種子', rand: 'env.rand(i) → 0～1，同一個 i 永遠同一個值（沒有 Math.random）',
    },
    globals: {
      Math: 'Math.abs/ceil/floor/round/trunc/sign/min/max/pow/sqrt/hypot/exp/log/log2/log10/sin/cos/tan/asin/acos/atan/atan2、PI/E/SQRT2/LN2/LN10', ease: 'ease.<名稱>(u)：緩動曲線',
      String: 'String(v)', Number: 'Number(v)', Boolean: 'Boolean(v)', parseInt: 'parseInt(s, radix)', parseFloat: 'parseFloat(s)', isFinite: 'isFinite(v)', isNaN: 'isNaN(v)',
      lerp: 'lerp(a, b, u)', clamp: 'clamp(x, lo, hi)', Object: 'Object.keys/values/entries', Array: 'Array.isArray', Infinity: 'Infinity', NaN: 'NaN',
    },
  };
  /** API 清單（由實際成員產生）：g／a／bg／env／全域／ease、參數型別、圖層框架屬性。 */
  function apiManifest() {
    const fake = {canvas: {width: 1920, height: 1080}};
    const list = (names, docs, where) => names.map(name => {
      if (!docs[name]) throw new AnimError(`${where}.${name} 沒有文件（請補 DOCS）`);
      return {name, doc: docs[name]};
    });
    return {
      runtimeVersion: VERSION,
      g: list(VM.members(makeGraphics(fake)), DOCS.g, 'g'),
      a: list(VM.members(makeAudio([])), DOCS.a, 'a'),
      bg: list(VM.members(makeBackground(null)), DOCS.bg, 'bg'),
      env: list(Object.keys(makeEnv({width: 1920, height: 1080, box: {x: 0, y: 0, w: 1, h: 1}, duration: 1, fps: 30, frame: 0, seed: 1})), DOCS.env, 'env'),
      globals: list(Object.keys(VM.makeGlobals()), DOCS.globals, 'globals'),
      ease: EASINGS.slice(),
      params: {types: [...PARAM_TYPES], roles: ROLES.slice(), fonts: Object.keys(FONTS), directions: DIRECTIONS.slice()},
      categories: CATEGORIES.slice(),
      framework: {anchors: ANCHORS.slice(), sides: SIDES.slice(), enter: ENTER_TYPES.slice(), exit: EXIT_TYPES.slice(), emphasis: EMPHASIS_TYPES.slice(), loop: LOOP_MODES.slice(), maxPathPoints: MAX_PATH_POINTS},
      limits: {code: VM.LIMITS.code, commands: MAX_COMMANDS, text: MAX_TEXT, textPerFrame: MAX_TEXT_PER_FRAME, images: MAX_IMAGES, soundEvents: MAX_SOUND_EVENTS, soundSeconds: MAX_SOUND_SECONDS, bgCalls: MAX_BG_CALLS},
    };
  }
  /** 參數變體：每個 enum／font／easing／direction 值、boolean 反值、text 空字串與兩行、number／angle／duration 的 min 與 max（其餘用預設）。 */
  function paramVariants(params) {
    const out = [{}];
    for (const [key, def] of Object.entries(params || {})) {
      if (def.type === 'enum') for (const v of def.values) out.push({[key]: v});
      if (def.type === 'font') for (const v of Object.keys(FONTS)) out.push({[key]: v});
      if (def.type === 'easing') for (const v of EASINGS) out.push({[key]: v});
      if (def.type === 'direction') for (const v of [...DIRECTIONS, ...(def.allowAuto ? ['auto'] : [])]) out.push({[key]: v});
      if (def.type === 'boolean') out.push({[key]: !def.default});
      if (def.type === 'text') out.push({[key]: ''}, {[key]: '第一行\n第二行'});
      if (def.type === 'number' || def.type === 'angle' || def.type === 'duration') out.push({[key]: def.min}, {[key]: def.max});
    }
    return out;
  }
  /** vet（護欄四，正式流程用）：結構（validateComponent）→ 試跑（smokeTest）→ 每組參數變體在五個時間點各畫一次（音效：合成一次）→ 有畫東西。
   *  失敗丟 AnimError 並帶 stage（schema／compile／smoke／variants／blank）、line／column（有的話）、variant（出錯的參數組）；成功回正規化插件。
   *  ctx 給 1920×1080 的真畫布試跑的時間才準；node 測試用假畫布也能跑。 */
  function vetComponent(ctx, raw, {lintPaths = false} = {}) {
    const tag = (e, stage, extra) => { if (e && e.name === 'AnimError') { if (!e.stage) e.stage = stage; Object.assign(e, extra || {}); } return e; };
    let comp;
    try { comp = validateComponent(raw); }
    catch (e) { throw tag(e, e && e.line ? 'compile' : 'schema'); }
    try { smokeTest(ctx, comp); } catch (e) { throw tag(e, 'smoke'); }
    const width = 1920, height = 1080, box = {x: 760, y: 420, w: 400, h: 240};
    const program = compileComponent(comp);
    const drawWith = (params, t) => {
      const env = makeEnv({width, height, box, duration: 3, fps: 30, frame: Math.round(t * 30), seed: 5});
      const p = resolveParams(comp.params, params);
      for (const [key, def] of Object.entries(comp.params || {})) if (def.type === 'point') p[key] = {x: p[key].x * width, y: p[key].y * height};
      ctx.save();
      try { program.call('draw', [makeGraphics(ctx), t, p, env, makeBackground(null)]); } finally { ctx.restore(); }
    };
    for (const params of paramVariants(comp.params)) {
      try {
        if (comp.kind === 'sound') {
          const clips = soundClips({id: 'vet', sounds: [{component: 'k', params, at: 0}]}, {k: comp}, {duration: 12});
          if (!clips.length || !clips[0].events.length) throw Object.assign(new AnimError('沒有排出任何音源'), {stage: 'blank'});
        } else for (const t of [0, 0.3, 1, 2, 2.9]) drawWith(params, t);
      } catch (e) { throw tag(e, 'variants', {variant: params}); }
    }
    if (comp.kind === 'visual') {
      const seen = [];
      const probe = {canvas: ctx.canvas, save() {}, restore() {}, setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, ellipse() {}, rect() {}, roundRect() {}, closePath() {}, clip() {}, translate() {}, rotate() {}, scale() {}, setLineDash() {}, drawImage() {}, measureText: s => ({width: s.length * 10}),
        createLinearGradient: () => ({addColorStop() {}}), createRadialGradient: () => ({addColorStop() {}}),
        stroke() { seen.push('stroke'); }, fill() { seen.push('fill'); }, fillText() { seen.push('text'); }, strokeText() { seen.push('text'); }};
      const env = makeEnv({width, height, box, duration: 3, fps: 30, frame: 36, seed: 5});
      try { program.call('draw', [makeGraphics(probe), 1.2, resolveParams(comp.params, {}), env, makeBackground(null)]); } catch (e) { throw tag(e, 'variants', {variant: {}}); }
      if (!seen.length) throw Object.assign(new AnimError('進場後（t＝1.2 秒、預設參數）沒有畫任何東西'), {stage: 'blank'});
      if (lintPaths) lintPathReuse(program, comp, {width, height, box});
    }
    return comp;
  }

  /** Vibe特效的程式常寫成 Pixi 式「畫一個形狀、接著 fill／stroke」而沒有 g.begin()：這裡的 g 是 canvas 路徑，
   *  g.begin() 之後畫的所有形狀都留在同一條路徑，後面每次 g.stroke／g.fill 都會連已經畫過的形狀一起重畫（用另一種顏色、粗細蓋上去），
   *  畫面上就是一堆殘影與黑塊。偵測「已經 fill／stroke 過的路徑又長出新形狀、再 fill／stroke」，丟 stage＝path 的錯誤請模型補 g.begin()。
   *  只在 AI 驗證時開（lintPaths）：個人庫與內建插件每次載入都重跑 vet，不能因為新規則把舊插件停用。
   *  同一個形狀先 fill 再 stroke、或一條路徑含多段只描邊一次，都不算。 */
  function lintPathReuse(program, comp, {width, height, box}) {
    for (const t of [0.3, 1.2, 2.5]) {
      let subpaths = 0, painted = false, paintedAt = 0, bad = null;  // subpaths：目前路徑已有幾個形狀；painted：這條路徑已經 fill／stroke 過；paintedAt：那時有幾個形狀
      const paint = what => {
        if (painted && subpaths > paintedAt && !bad) bad = what;
        painted = true; paintedAt = subpaths;
      };
      const shape = () => { subpaths++; };
      const probe = {canvas: {width, height}, save() {}, restore() {}, setTransform() {}, beginPath() { subpaths = 0; painted = false; paintedAt = 0; },
        moveTo: shape, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, ellipse: shape, rect: shape, roundRect: shape, closePath() {}, clip() {},
        translate() {}, rotate() {}, scale() {}, setLineDash() {}, drawImage() {}, measureText: s => ({width: s.length * 10}),
        createLinearGradient: () => ({addColorStop() {}}), createRadialGradient: () => ({addColorStop() {}}),
        stroke() { paint('g.stroke'); }, fill() { paint('g.fill'); }, fillText() {}, strokeText() {}};
      const env = makeEnv({width, height, box, duration: 3, fps: 30, frame: Math.round(t * 30), seed: 5});
      try { program.call('draw', [makeGraphics(probe), t, resolveParams(comp.params, {}), env, makeBackground(null)]); } catch (e) { return; }  // 試跑錯誤在前面的階段已回報
      if (bad) throw Object.assign(new AnimError(`${bad} 會把這條路徑上已經畫過的形狀一起重畫（殘影）：每個獨立的形狀前面都要先呼叫 g.begin()，再畫形狀、再 g.fill／g.stroke`), {stage: 'path'});
    }
  }

  /** 插件縮圖：在 w×h 的畫布上以 preview.t 與 preview.box 畫一格（視覺插件；音效回 false）。ctx 由呼叫端給（anim.js 重用 animCanvas）。 */
  function thumbnail(ctx, plugin, {width = 160, height = 90} = {}) {
    if (!plugin || plugin.kind !== 'visual') return false;
    const pv = plugin.preview || {t: 1, box: {w: 0.3, h: 0.2}};
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height);
    try {
      const hash = componentHash(plugin);
      drawFrame(ctx, {id: 'thumb-' + hash, box: {cx: 0.5, cy: 0.5, w: pv.box.w, h: pv.box.h}, layers: [{component: hash, params: {}}]}, {[hash]: plugin},
        {frame: Math.round(pv.t * 30), fps: 30, duration: Math.max(3, pv.t + 1), videoW: 16, videoH: 9});
    } finally { ctx.restore(); }
    return true;
  }

  /** 字型指紋：各字型量一段測試字的寬度；換一台電腦字型不同時素材鍵就不同，不會沿用舊畫格。 */
  function fontFingerprint(ctx) {
    const parts = [];
    for (const [k, stack] of Object.entries(FONTS)) { ctx.font = `700 100px ${stack}`; parts.push(k + ':' + ctx.measureText('字 WordBlade 0123 ABC').width.toFixed(2)); /* WordBlade：量測字串不放原專案商標 */ }
    return sha256Hex(parts.join('|')).slice(0, 16);
  }

  /** 試跑（護欄四）：視覺元件在 0、¼、½、¾、結尾五個時間點各畫一次，沒有下層畫面與合成的下層畫面各跑一輪；
   *  音效元件合成事件一次。任何錯誤丟 AnimError；畫一格超過 SMOKE_SLOW_MS 的格有兩格以上也不採用
   *  （只慢一格可能是第一次畫的暖機或垃圾回收）。ctx 給一個 1920×1080 的畫布量時間才準。
   *  2026-10-06 以 scripts/anim-frame-probe.js 校準：內建元件最慢一格約 11 毫秒；刻意很重的整張發光（40 個大圓、blur 200）約 410 毫秒。 */
  function smokeTest(ctx, comp) {
    const program = compileComponent(comp);
    if (comp.kind === 'sound') { const ev = []; program.call('sound', [makeAudio(ev), resolveParams(comp.params, {}), {duration: 3, seed: 1}]); return; }
    const width = 1920, height = 1080, box = {x: 760, y: 420, w: 400, h: 240};
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let slow = 0, slowest = 0;
    for (const background of [null, syntheticBackground()]) {
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const env = makeEnv({width, height, box, duration: 3, fps: 30, frame: Math.round(u * 90), seed: 1});
        const began = now();
        ctx.save();
        try { program.call('draw', [makeGraphics(ctx), u * 3, resolveParams(comp.params, {}), env, makeBackground(background)]); }
        finally { ctx.restore(); }
        if (ctx.getImageData) ctx.getImageData(0, 0, 1, 1);  // 逼畫布真的畫完（畫布指令是延後點陣化的），量到的才是實際時間
        const ms = now() - began; slowest = Math.max(slowest, ms);
        if (ms > SMOKE_SLOW_MS && ++slow >= 2) throw new AnimError(`畫一格要 ${Math.round(slowest)} 毫秒，太慢了（上限 ${SMOKE_SLOW_MS} 毫秒）：請減少發光、大範圍漸層或重複作畫`);
      }
    }
  }

  return {VERSION, FONTS, LIMITS: {MAX_COMMANDS, MAX_TEXT, MAX_TEXT_PER_FRAME, MAX_IMAGES, MAX_SOUND_EVENTS, MAX_SOUND_SECONDS, MAX_BG_CALLS, MAX_EDGE_POINTS},
    DENIED_WORDS, makeGraphics, makeAudio, makeBackground, makeEnv, scheduleSound, scheduleClips, renderClip, wavBytes,
    validateComponent, resolveParams, compileComponent, usesBackground, instanceUsesBackground,
    normalizeLayer, normalizePalette, pathAt, FRAMEWORK: {EASINGS, ANCHORS, DIRECTIONS, SIDES, ENTER_TYPES, EXIT_TYPES, EMPHASIS_TYPES, LOOP_MODES, ROLES, CATEGORIES, SUB_DEFAULTS, MAX_PATH_POINTS},
    thumbnail,
    sha256Hex, stableJson, componentHash, frameKey, soundKey, drawFrame, soundClips, fontFingerprint, smokeTest, seeded,
    vetComponent, paramVariants, apiManifest, DOCS};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AnimRuntime;
