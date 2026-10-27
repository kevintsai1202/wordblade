// 移植自 transcript-review（字導字演）scripts/ 的單元測試（2026-10-27，commit 7d4badc），由 src/anim/legacy.test.ts 交給 Vitest 執行；
// 只改了檔案路徑，以及 test() 在 Vitest 下改成登記測試（globalThis.__animCollect）。
'use strict';
// 動畫執行環境（frontend/anim_runtime.js）的單元測試，不需瀏覽器：以記錄指令的假畫布代替 CanvasRenderingContext2D。
// 設計見 docs/superpowers/specs/2026-10-06-anim-engine-design.md §4～§6、§5.1。
// 驗：繪圖參數邊界與上限、描邊畫出（progress→虛線）、文字字數與每格總量、音效事件記錄與檢查、env.rand 決定性、
//     圖層時間範圍、參數表驗證、讀下層畫面 bg（取色、平均、最亮點、找顏色、邊緣、移動量、呼叫上限）與 g.image、元件有沒有用到 bg。
// 用法：node scripts/anim-runtime-unit.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONTEND = path.join(__dirname, '..');  // WordBlade：src/anim（直譯器與執行環境在 vendor/）
const sandbox = {console, TextEncoder};
vm.createContext(sandbox);
for (const f of ['vendor/acorn.js', 'vendor/anim_vm.js', 'vendor/anim_runtime.js']) vm.runInContext(fs.readFileSync(path.join(FRONTEND, f), 'utf8'), sandbox, {filename: f});
const AnimVM = vm.runInContext('AnimVM', sandbox);
const RT = vm.runInContext('AnimRuntime', sandbox);

/** 記錄指令的假畫布（只實作執行環境用得到的部分）。 */
function fakeCtx(width = 1920, height = 1080) {
  const calls = [], state = {};
  const record = name => (...args) => { calls.push([name, ...args]); };
  const gradient = kind => (...args) => { const g = {kind, args, stops: [], addColorStop: (o, c) => g.stops.push([o, c])}; calls.push([kind, ...args]); return g; };
  return {
    calls, state, canvas: {width, height},
    beginPath: record('beginPath'), moveTo: record('moveTo'), lineTo: record('lineTo'), quadraticCurveTo: record('quadraticCurveTo'),
    bezierCurveTo: record('bezierCurveTo'), arc: record('arc'), ellipse: record('ellipse'), rect: record('rect'), roundRect: record('roundRect'),
    closePath: record('closePath'), fill() { calls.push(['fill']); calls.push(['fillAlpha', this.globalAlpha]); }, strokeText: record('strokeText'), fillText: record('fillText'),
    stroke() { calls.push(['stroke', {style: this.strokeStyle, width: this.lineWidth, dash: this.dash ? [...this.dash] : null}]); },
    clip: record('clip'), fillRect: record('fillRect'), clearRect: record('clearRect'),
    save: record('save'), restore: record('restore'), translate: record('translate'), rotate: record('rotate'), scale: record('scale'),
    setTransform: record('setTransform'), drawImage(...a) { calls.push(['drawImage', ...a]); calls.push(['drawAlpha', this.globalAlpha]); },
    get shadowColor() { return this._sc || 'transparent'; }, set shadowColor(v) { this._sc = v; calls.push(['shadow', v]); },
    get globalCompositeOperation() { return this._gco || 'source-over'; }, set globalCompositeOperation(v) { this._gco = v; calls.push(['composite', v]); },
    setLineDash(d) { this.dash = d; calls.push(['setLineDash', [...d]]); },
    measureText(s) { return {width: s.length * 10}; },
    createLinearGradient: gradient('linearGradient'), createRadialGradient: gradient('radialGradient'),
    strokeStyle: '#000', fillStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, lineDashOffset: 0,
    font: '', textAlign: 'left', textBaseline: 'alphabetic', letterSpacing: '0px', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
  };
}
/** 編譯一段 draw 並以假畫布執行一次；回傳假畫布（看指令）。 */
function draw(code, {t = 0, p = {}, env = {}, bg} = {}) {
  const ctx = fakeCtx(); const program = AnimVM.compile(code, {entry: 'draw'});
  const e = RT.makeEnv({width: 1920, height: 1080, box: {x: 760, y: 420, w: 400, h: 240}, duration: 3, fps: 30, frame: Math.round(t * 30), seed: 7, ...env});
  program.call('draw', [RT.makeGraphics(ctx), t, p, e, bg || RT.makeBackground(null)]);
  return ctx;
}
/** 沙箱（vm context）建立的陣列與物件原型不同，deepStrictEqual 前先轉成本地的普通值。 */
const plain = v => JSON.parse(JSON.stringify(v));
function throwsAnim(fn, hint) {
  let error = null; try { fn(); } catch (e) { error = e; }
  assert.ok(error && error.name === 'AnimError', '應丟 AnimError：' + (error && error.stack));
  if (hint) assert.ok(String(error.message).includes(hint), `訊息「${error && error.message}」應包含「${hint}」`);
}
/** 合成一張 W×H 的分析畫面：左半黑、右半白，(x0..x1, y0..y1) 是紅色方塊。 */
function syntheticFrame(W = 480, H = 270, red = {x0: 100, y0: 50, x1: 160, y1: 90}) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, inRed = x >= red.x0 && x < red.x1 && y >= red.y0 && y < red.y1;
    const v = x < W / 2 ? 0 : 255;
    data[i] = inRed ? 255 : v; data[i + 1] = inRed ? 0 : v; data[i + 2] = inRed ? 0 : v; data[i + 3] = 255;
  }
  return {width: W, height: H, data};
}

let passed = 0; const failures = [];
function test(name, fn) { if (globalThis.__animCollect) return globalThis.__animCollect(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('FAIL  ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')); }
}

console.log('— 繪圖 g');
test('路徑與描邊照順序下指令', () => {
  const ctx = draw('function draw(g){ g.begin(); g.moveTo(0, 0); g.lineTo(100, 0); g.stroke({color: "#ff0000", width: 8}) }');
  const names = ctx.calls.map(c => c[0]);
  assert.deepStrictEqual(names.filter(n => ['beginPath', 'moveTo', 'lineTo', 'stroke'].includes(n)), ['beginPath', 'moveTo', 'lineTo', 'stroke']);
  const stroke = ctx.calls.find(c => c[0] === 'stroke')[1];
  assert.strictEqual(stroke.style, '#ff0000'); assert.strictEqual(stroke.width, 8);
});
test('描邊畫出：progress 0.5 畫路徑前一半（虛線長＝路徑長×0.5）', () => {
  const ctx = draw('function draw(g){ g.begin(); g.moveTo(0, 0); g.lineTo(200, 0); g.stroke({color: "#ffffff", progress: 0.5}) }');
  const dash = ctx.calls.find(c => c[0] === 'setLineDash')[1];
  assert.ok(Math.abs(dash[0] - 100) < 1e-6 && dash[1] > 200, JSON.stringify(dash));
});
test('progress 0 什麼都不畫', () => {
  const ctx = draw('function draw(g){ g.begin(); g.moveTo(0, 0); g.lineTo(200, 0); g.stroke({color: "#ffffff", progress: 0}) }');
  assert.ok(!ctx.calls.some(c => c[0] === 'stroke'));
});
test('顏色只收 #RRGGBB', () => throwsAnim(() => draw('function draw(g){ g.begin(); g.rect(0, 0, 10, 10); g.fill({color: "url(javascript:alert(1))"}) }'), '顏色'));
test('數字參數要有限', () => throwsAnim(() => draw('function draw(g){ g.begin(); g.moveTo(1 / 0, 0) }'), '有限'));
test('漸層要 2～8 個色標', () => {
  const ctx = draw('function draw(g){ g.begin(); g.rect(0, 0, 10, 10); g.fill({gradient: {type: "linear", x0: 0, y0: 0, x1: 10, y1: 0, stops: [[0, "#ff0000"], [1, "#0000ff"]]}}) }');
  assert.ok(ctx.calls.some(c => c[0] === 'linearGradient'));
  throwsAnim(() => draw('function draw(g){ g.fill({gradient: {stops: [[0, "#ff0000"]]}}) }'), 'stops');
});
// 迴圈每圈要十步上下，步數上限（50,000）通常先到；用陣列字面值＋forEach 直接呼叫宿主函式，才量得到指令上限本身
test('每格繪圖指令有上限', () => throwsAnim(() => draw('function draw(g){ [' + '0,'.repeat(6000) + '].forEach(g.translate) }'), '指令'));
test('文字每段最多 200 字', () => throwsAnim(() => draw('function draw(g){ g.text("字".repeat(201), 0, 0, {}) }'), '200'));
test('每格文字總量最多 600 字（不能拿來排版長文）', () => throwsAnim(() => draw('function draw(g){ for (let i = 0; i < 4; i++) g.text("字".repeat(180), 0, i * 50, {}) }'), '600'));
test('字型只收白名單', () => throwsAnim(() => draw('function draw(g){ g.text("x", 0, 0, {font: "Comic Sans"}) }'), '字型'));
test('save 巢狀上限', () => throwsAnim(() => draw('function draw(g){ for (let i = 0; i < 40; i++) g.save() }'), '巢狀'));

console.log('— 音效 a');
test('tone／noise 記錄成事件，參數夾在範圍內', () => {
  const events = []; const program = AnimVM.compile('function sound(a){ a.tone({type: "square", freq: 880, freqEnd: 440, at: 0.1, dur: 0.2, gain: 2}); a.noise({color: "pink", dur: 0.3, filter: {type: "bandpass", freq: 2000, freqEnd: 500}}) }', {entry: 'sound'});
  program.call('sound', [RT.makeAudio(events), {}, {}]);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].kind, 'tone'); assert.strictEqual(events[0].wave, 'square'); assert.strictEqual(events[0].gain, 1);
  assert.strictEqual(events[1].kind, 'noise'); assert.strictEqual(events[1].filter.type, 'bandpass');
});
test('音效最長 10 秒、最多 32 個音源', () => {
  const run = code => { const ev = []; AnimVM.compile(code, {entry: 'sound'}).call('sound', [RT.makeAudio(ev), {}, {}]); return ev; };
  throwsAnim(() => run('function sound(a){ a.tone({at: 8, dur: 5}) }'), '10');
  throwsAnim(() => run('function sound(a){ for (let i = 0; i < 40; i++) a.tone({at: 0, dur: 0.1}) }'), '32');
});
test('波形只收白名單', () => throwsAnim(() => { const ev = []; AnimVM.compile('function sound(a){ a.tone({type: "custom"}) }', {entry: 'sound'}).call('sound', [RT.makeAudio(ev), {}, {}]); }, 'type'));

console.log('— env 與元件');
test('env.rand(i) 同一個 i 永遠同一個值、與呼叫順序無關', () => {
  const p = AnimVM.compile('function draw(g, t, p, env){ return [env.rand(3), env.rand(1), env.rand(3)] }', {entry: 'draw'});
  const e = RT.makeEnv({width: 1920, height: 1080, box: {x: 0, y: 0, w: 1, h: 1}, duration: 1, fps: 30, frame: 0, seed: 42});
  const [a, b, c] = AnimVM.toPlain(p.call('draw', [null, 0, {}, e]));
  assert.strictEqual(a, c); assert.notStrictEqual(a, b); assert.ok(a >= 0 && a < 1);
});
test('參數表：型別錯誤用預設、數字夾在範圍、不認得的鍵丟掉', () => {
  const r = RT.resolveParams({w: {type: 'number', min: 1, max: 10, default: 4}, c: {type: 'color', default: '#ffffff'}, m: {type: 'enum', values: ['a', 'b'], default: 'a'}},
    {w: 99, c: 'red', m: 'b', extra: 1});
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), {w: 10, c: '#ffffff', m: 'b'});
});
test('元件雜湊只由內容決定', () => {
  const c = {kind: 'visual', params: {a: {type: 'number', default: 1}}, code: 'function draw(g){}'};
  assert.strictEqual(RT.componentHash(c), RT.componentHash({code: c.code, params: c.params, kind: 'visual'}));
  assert.notStrictEqual(RT.componentHash(c), RT.componentHash({...c, code: 'function draw(g){ }'}));
});
test('drawFrame：圖層只在自己的起訖內畫，座標縮放成 1080p 虛擬座標', () => {
  const comp = {kind: 'visual', params: {}, code: 'function draw(g, t, p, env){ g.begin(); g.rect(env.box.x, env.box.y, env.box.w, env.box.h); g.fill({color: "#ff0000"}) }'};
  const key = RT.componentHash(comp), comps = {[key]: comp};
  const inst = {id: 'an-1', box: {cx: 0.5, cy: 0.5, w: 0.25, h: 0.25}, layers: [{component: key, params: {}, start: 1, end: 2}]};
  const before = fakeCtx(960, 540); RT.drawFrame(before, inst, comps, {frame: 15, fps: 30, duration: 3, videoW: 1920, videoH: 1080});
  assert.ok(!before.calls.some(c => c[0] === 'fill'), '起點之前不畫');
  const inside = fakeCtx(960, 540); RT.drawFrame(inside, inst, comps, {frame: 45, fps: 30, duration: 3, videoW: 1920, videoH: 1080});
  const rect = inside.calls.find(c => c[0] === 'rect'); const transform = inside.calls.find(c => c[0] === 'setTransform');
  assert.deepStrictEqual(rect.slice(1), [720, 405, 480, 270]); assert.strictEqual(transform[1], 0.5);
});
test('soundClips：每個音效圖層各自一段（起點相對動畫），起點超過動畫長度的略過、結尾超過的截短', () => {
  const comp = {kind: 'sound', params: {}, code: 'function sound(a){ a.tone({at: 0, dur: 0.5}); a.tone({at: 0.4, dur: 1}) }'};
  const key = RT.componentHash(comp);
  const clips = RT.soundClips({id: 'an-1', sounds: [{component: key, params: {}, at: 0.25}, {component: key, params: {}, at: 5}, {component: key, params: {}, at: 2.5}]}, {[key]: comp}, {duration: 3});
  assert.deepStrictEqual(plain(clips.map(c => [c.index, c.at])), [[0, 0.25], [2, 2.5]]);
  assert.strictEqual(clips[0].events.length, 2); assert.strictEqual(clips[0].seconds, 1.4);
  assert.deepStrictEqual(plain(clips[1].events.map(e => e.dur)), [0.5, 0.1]);  // 第二個音源 0.4 秒起、只剩 0.1 秒
  assert.ok(Math.abs(clips[1].seconds - 0.5) < 1e-9);
  assert.notStrictEqual(clips[0].seed, clips[1].seed);
});
test('env.rand 大致均勻（不是兩個亂數相加的三角分布）', () => {
  const e = RT.makeEnv({width: 1920, height: 1080, box: {x: 0, y: 0, w: 1, h: 1}, duration: 1, fps: 30, frame: 0, seed: 9});
  const p = AnimVM.compile('function draw(g, t, p, env){ let s = 0, lo = 0; for (let i = 0; i < 2000; i++) { const r = env.rand(i); s += r; if (r < 0.1) lo++ } return [s / 2000, lo / 2000] }', {entry: 'draw'});
  const [mean, low] = AnimVM.toPlain(p.call('draw', [null, 0, {}, e]));
  assert.ok(Math.abs(mean - 0.5) < 0.03 && Math.abs(low - 0.1) < 0.03, `${mean} ${low}`);
});

console.log('— 讀下層畫面 bg 與 g.image');
const frame = syntheticFrame();
const bgOf = () => RT.makeBackground({analysis: frame, previous: null, virtualW: 1920, virtualH: 1080, full: {tag: 'full', width: 1920, height: 1080}});
const call = (code, bg) => { const p = AnimVM.compile(code, {entry: 'draw'}); return AnimVM.toPlain(p.call('draw', [RT.makeGraphics(fakeCtx()), 0, {}, RT.makeEnv({width: 1920, height: 1080, box: {x: 0, y: 0, w: 1, h: 1}, duration: 1, fps: 30, frame: 0, seed: 1}), bg])); };
test('sample：左半黑、右半白、紅色方塊（虛擬座標換到分析縮圖）', () => {
  const r = call('function draw(g, t, p, env, bg){ return [bg.sample(100, 900), bg.sample(1800, 900), bg.sample(520, 280)] }', bgOf());
  assert.strictEqual(r[0].l, 0); assert.strictEqual(r[1].l, 1); assert.deepStrictEqual([r[2].r, r[2].g, r[2].b], [255, 0, 0]);
});
test('average：整張畫面的平均亮度約一半', () => {
  const r = call('function draw(g, t, p, env, bg){ return bg.average(0, 0, 1920, 1080) }', bgOf());
  assert.ok(r.l > 0.45 && r.l < 0.55, JSON.stringify(r));
});
test('find：找到紅色方塊的外框（虛擬座標）', () => {
  const r = call('function draw(g, t, p, env, bg){ return bg.find("#ff0000", 30, 0, 0, 1920, 1080) }', bgOf());
  assert.ok(Math.abs(r.x - 400) <= 4 && Math.abs(r.y - 200) <= 4 && Math.abs(r.w - 240) <= 8 && Math.abs(r.h - 160) <= 8, JSON.stringify(r));
});
test('brightest：只看左半黑區時找到紅色方塊（亮度最高）', () => {
  const r = call('function draw(g, t, p, env, bg){ return bg.brightest(0, 0, 900, 1080) }', bgOf());
  assert.ok(r.x >= 400 && r.x <= 640 && r.y >= 200 && r.y <= 360, JSON.stringify(r));
});
test('edges：黑白交界與紅框邊緣有邊緣點', () => {
  const r = call('function draw(g, t, p, env, bg){ return bg.edges(0, 0, 1920, 1080, 0.3) }', bgOf());
  assert.ok(r.length > 10 && r.length <= 512 && r.some(pt => Math.abs(pt.x - 960) < 20), r.length);
});
test('motion：沒有前一格時是 0，有變化時大於 0', () => {
  assert.strictEqual(call('function draw(g, t, p, env, bg){ return bg.motion(0, 0, 1920, 1080) }', bgOf()), 0);
  const moved = RT.makeBackground({analysis: frame, previous: syntheticFrame(480, 270, {x0: 300, y0: 50, x1: 360, y1: 90}).data, virtualW: 1920, virtualH: 1080, full: null});
  assert.ok(call('function draw(g, t, p, env, bg){ return bg.motion(0, 0, 1920, 1080) }', moved) > 0);
});
test('每格分析呼叫有上限', () => throwsAnim(() => call('function draw(g, t, p, env, bg){ for (let i = 0; i < 70; i++) bg.sample(0, 0) }', bgOf()), '64'));
test('沒有下層畫面時 bg 回中性值、不會讓元件壞掉', () => {
  const r = call('function draw(g, t, p, env, bg){ return [bg.available, bg.sample(0, 0).l, bg.find("#ff0000", 30, 0, 0, 10, 10)] }', RT.makeBackground(null));
  assert.deepStrictEqual(plain(r), [false, 0, null]);
});
test('g.image 把下層畫面的一塊畫上去（來源換成原尺寸像素）', () => {
  const ctx = fakeCtx(); const p = AnimVM.compile('function draw(g, t, p, env, bg){ g.image(bg, 100, 100, 200, 100, 0, 0, 400, 200) }', {entry: 'draw'});
  p.call('draw', [RT.makeGraphics(ctx), 0, {}, RT.makeEnv({width: 1920, height: 1080, box: {x: 0, y: 0, w: 1, h: 1}, duration: 1, fps: 30, frame: 0, seed: 1}), bgOf()]);
  const img = ctx.calls.find(c => c[0] === 'drawImage');
  assert.ok(img && img[1].tag === 'full' && img.slice(2).join(',') === '100,100,200,100,0,0,400,200', JSON.stringify(img));
});
test('看得出元件有沒有用到 bg（只有用到的才要準備下層畫面）', () => {
  assert.strictEqual(RT.usesBackground({kind: 'visual', code: 'function draw(g, t, p, env, bg){ return bg.sample(0, 0) }'}), true);
  assert.strictEqual(RT.usesBackground({kind: 'visual', code: 'function draw(g, t, p, env){ return 1 }'}), false);
  assert.strictEqual(RT.usesBackground({kind: 'visual', code: 'function draw(g, t, p, env, bg){ return 1 }'}), false);
});

test('g.image 每格最多 16 次、第一個參數一定要是 bg', () => {
  const run = code => AnimVM.compile(code, {entry: 'draw'}).call('draw', [RT.makeGraphics(fakeCtx()), 0, {}, {}, bgOf()]);
  throwsAnim(() => run('function draw(g, t, p, env, bg){ for (let i = 0; i < 20; i++) g.image(bg, 0, 0, 10, 10, 0, 0, 10, 10) }'), '16');
  throwsAnim(() => run('function draw(g, t, p, env, bg){ g.image({}, 0, 0, 10, 10, 0, 0, 10, 10) }'), 'bg');
});
test('drawFrame 把下層畫面交給用到 bg 的圖層；一個圖層出錯時 onError 收到、其他圖層照畫', () => {
  const uses = {kind: 'visual', params: {}, code: 'function draw(g, t, p, env, bg){ if (!bg.available) return; g.begin(); g.rect(0, 0, 10, 10); g.fill({}) }'};
  const broken = {kind: 'visual', params: {}, code: 'function draw(g){ g.moveTo(1 / 0, 0) }'};
  const comps = {[RT.componentHash(uses)]: uses, [RT.componentHash(broken)]: broken};
  const inst = {id: 'an-2', box: {cx: 0.5, cy: 0.5, w: 0.2, h: 0.2}, layers: [{component: RT.componentHash(broken), params: {}, start: 0, end: null}, {component: RT.componentHash(uses), params: {}, start: 0, end: null}]};
  const errors = [], ctx = fakeCtx();
  RT.drawFrame(ctx, inst, comps, {frame: 0, fps: 30, duration: 2, videoW: 1920, videoH: 1080, background: {analysis: frame, previous: null, virtualW: 1920, virtualH: 1080, full: null}, onError: (e, i) => errors.push([i, e.name])});
  assert.deepStrictEqual(errors, [[0, 'AnimError']]); assert.ok(ctx.calls.some(c => c[0] === 'fill'));
  assert.strictEqual(RT.instanceUsesBackground(inst, comps), true);
});
test('g.text 只收字串或數字', () => throwsAnim(() => draw('function draw(g){ g.text({a: 1}, 0, 0, {}) }'), '文字'));

console.log('— 雜湊、元件驗證、素材鍵、試跑');
test('sha256Hex 與 node 的 crypto 一致（含中文與跨區塊長度）', () => {
  const crypto = require('node:crypto');
  for (const s of ['', 'abc', '字導 SubTutor', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), '動'.repeat(300)])
    assert.strictEqual(RT.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'), JSON.stringify(s.slice(0, 10)));
});
test('元件雜湊是 32 位十六進位（SHA-256 前 128 位元）', () => assert.match(RT.componentHash({kind: 'visual', params: {}, code: 'function draw(g){}'}), /^[0-9a-f]{32}$/));
const goodComp = {id: 'my-arrow', kind: 'visual', name: '箭頭', description: '說明', tags: ['指向'], extra: 1,
  params: {w: {type: 'number', min: 1, max: 9, default: 3, label: '粗細'}, c: {type: 'color', default: '#FF0000'}, m: {type: 'enum', values: ['a', 'b'], default: 'b'},
    on: {type: 'boolean', default: true}, s: {type: 'text', default: '標題', maxLength: 20}, at: {type: 'point', default: {x: 0.2, y: 0.8}}},
  code: 'function draw(g, t, p){ }'};
test('validateComponent：正規化並只留認得的欄位', () => {
  const c = RT.validateComponent(goodComp);
  assert.deepStrictEqual(Object.keys(c).sort(), ['code', 'description', 'id', 'kind', 'name', 'params', 'tags', 'version']);
  assert.strictEqual(c.params.c.default, '#ff0000'); assert.strictEqual(c.version, 1);
});
test('validateComponent：結構不對就擋（附原因）', () => {
  const ok = {id: 'x', kind: 'visual', name: 'x', params: {}, code: 'function draw(g){}'};
  for (const [bad, hint] of [
    [{...ok, kind: 'script'}, 'kind'],
    [{...ok, id: '../x'}, 'id'],
    [{...ok, name: ''}, '名稱'],
    [{...ok, name: '字'.repeat(31)}, '30'],
    [{...ok, description: '字'.repeat(121)}, '120'],
    [{...ok, tags: Array(9).fill('a')}, '標籤'],
    [{...ok, params: {w: {type: 'number', min: 5, max: 1, default: 3}}}, 'min'],
    [{...ok, params: {w: {type: 'number', min: 0, max: 10, default: 30}}}, '預設'],
    [{...ok, params: {m: {type: 'enum', values: ['a'], default: 'b'}}}, '預設'],
    [{...ok, params: {c: {type: 'color', default: 'red'}}}, '預設'],
    [{...ok, params: {constructor: {type: 'boolean', default: true}}}, '參數名稱'],
    [{...ok, params: {w: {type: 'function'}}}, 'type'],
    [{...ok, params: Object.fromEntries(Array.from({length: 17}, (_, i) => ['p' + i, {type: 'boolean', default: false}]))}, '16'],
    [{...ok, code: 'function paint(g){}'}, 'draw'],
    [{...ok, kind: 'sound', code: 'function draw(g){}'}, 'sound'],
    [{...ok, code: 'x'.repeat(20001)}, '20000'],
    [{...ok, code: 'function draw(g){ window.alert(1) }'}, 'window'],
  ]) throwsAnim(() => RT.validateComponent(bad), hint);
});
// WordBlade：沒有原專案的 Python 引擎（backend/core.py），所以只留「出現禁用字詞就擋」，拿掉和 core.ANIM_DENIED_WORDS 的比對
test('validateComponent：程式碼裡（含字串）出現禁用字詞就擋', () => {
  throwsAnim(() => RT.validateComponent({id: 'x', kind: 'visual', name: 'x', params: {}, code: 'function draw(g){ g.text("window", 0, 0, {}) }'}), '不能出現');
});
test('素材鍵：內容、尺寸、id、字型、（用到 bg 時）下層內容任一改變就換畫格鍵', () => {
  const plain = {kind: 'visual', params: {}, code: 'function draw(g){ }'}, withBg = {kind: 'visual', params: {}, code: 'function draw(g, t, p, env, bg){ bg.sample(0, 0) }'};
  const comps = {[RT.componentHash(plain)]: plain, [RT.componentHash(withBg)]: withBg};
  const inst = {id: 'an-1', box: {cx: 0.5, cy: 0.5, w: 0.2, h: 0.2}, layers: [{component: RT.componentHash(plain), params: {}, start: 0, end: null}], sounds: []};
  const opts = {width: 1920, height: 1080, fps: '30', frames: 90, fonts: 'f1', under: 'u1'};
  const k = RT.frameKey(inst, comps, opts);
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.strictEqual(RT.frameKey(inst, comps, {...opts, under: 'u2'}), k, '沒用到 bg 時下層內容不影響');
  for (const changed of [{...opts, width: 1280}, {...opts, frames: 91}, {...opts, fonts: 'f2'}]) assert.notStrictEqual(RT.frameKey(inst, comps, changed), k);
  assert.notStrictEqual(RT.frameKey({...inst, id: 'an-2'}, comps, opts), k);
  assert.notStrictEqual(RT.frameKey({...inst, box: {cx: 0.4, cy: 0.5, w: 0.2, h: 0.2}}, comps, opts), k);
  const bgInst = {...inst, layers: [{component: RT.componentHash(withBg), params: {}, start: 0, end: null}]};
  assert.notStrictEqual(RT.frameKey(bgInst, comps, {...opts, under: 'u2'}), RT.frameKey(bgInst, comps, opts), '用到 bg 時下層內容要進鍵');
  const snd = {kind: 'sound', params: {}, code: 'function sound(a){ a.tone({dur: 0.2}) }'};
  const clip = RT.soundClips({id: 'an-1', sounds: [{component: RT.componentHash(snd), params: {}, at: 0}]}, {[RT.componentHash(snd)]: snd}, {duration: 3})[0];
  assert.match(RT.soundKey(clip), /^[0-9a-f]{32}$/);
  assert.notStrictEqual(RT.soundKey({...clip, seed: clip.seed + 1}), RT.soundKey(clip));
});
test('試跑：用了 bg 卻沒處理「找不到」（null）的元件擋下', () => {
  throwsAnim(() => RT.smokeTest(fakeCtx(), {kind: 'visual', params: {}, code: 'function draw(g, t, p, env, bg){ const r = bg.find("#00ff00", 10); g.begin(); g.rect(r.x, r.y, r.w, r.h); g.stroke({}) }'}));
});
test('試跑：正確處理 bg 的元件通過（有下層畫面與沒有下層畫面都跑過）', () => {
  const ctx = fakeCtx();
  RT.smokeTest(ctx, {kind: 'visual', params: {}, code: 'function draw(g, t, p, env, bg){ const r = bg.find("#ff0000", 40); if (!r) return; g.begin(); g.rect(r.x, r.y, r.w, r.h); g.stroke({}); g.image(bg, r.x, r.y, r.w, r.h, 0, 0, r.w * 2, r.h * 2) }'});
  assert.ok(ctx.calls.some(c => c[0] === 'rect'), '合成的下層畫面要找得到紅色區塊');
});
test('試跑：音效元件合成事件', () => {
  RT.smokeTest(fakeCtx(), {kind: 'sound', params: {}, code: 'function sound(a){ a.tone({dur: 0.2}) }'});
  throwsAnim(() => RT.smokeTest(fakeCtx(), {kind: 'sound', params: {}, code: 'function sound(a){ a.tone({at: 9.9, dur: 1}) }'}), '10');
});


console.log('— 框架屬性（設計 2026-10-20-anim-plugin-framework-design.md §8）與新參數型別');
/** 把 draw 當下看到的 env.box 與 t 畫成一個 rect，測框架屬性時從 rect 指令讀回。 */
const PROBE = {kind: 'visual', params: {}, code: 'function draw(g, t, p, env){ g.begin(); g.rect(env.box.x, env.box.y, env.box.w, t); g.fill({color: "#ff0000"}) }'};
const PROBE_KEY = RT.componentHash(PROBE), PROBE_COMPS = {[PROBE_KEY]: PROBE};
function probeInst(layer, extra) { return {id: 'an-1', box: {cx: 0.5, cy: 0.5, w: 0.25, h: 0.25}, layers: [{component: PROBE_KEY, params: {}, start: 0, end: null, ...layer}], sounds: [], ...extra}; }
/** 離屏畫布工廠（假畫布）：記下建立的每張，測陰影／描邊／透明度的合成。 */
const fxMade = [];
const fxFactory = (w, h) => { const c = fakeCtx(w, h); const canvas = {width: w, height: h, getContext: () => c}; c.canvas = canvas; fxMade.push(c); return canvas; };
function probeDraw(layer, t, extra, opts) { const ctx = fakeCtx(1920, 1080); fxMade.length = 0; RT.drawFrame(ctx, probeInst(layer, extra), PROBE_COMPS, {frame: Math.round(t * 30), fps: 30, duration: 3, videoW: 1920, videoH: 1080, canvasFactory: fxFactory, ...opts}); return ctx; }
const rectOf = ctx => { const r = ctx.calls.find(c => c[0] === 'rect'); return r ? r.slice(1) : null; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
test('normalizeLayer：省略欄位與明寫預設值相同、超範圍夾住、不認得的鍵丟掉', () => {
  const base = plain(RT.normalizeLayer({component: 'k', params: {}, start: 0, end: null}));
  const explicit = plain(RT.normalizeLayer({component: 'k', params: {}, start: 0, end: null, transform: {dx: 0, dy: 0, anchor: 'center', scale: 1, rotate: 0}, opacity: 1,
    fade: {in: 0, out: 0, easeIn: 'outCubic', easeOut: 'linear'}, path: null, shadow: null, outline: null, loop: null, enter: null, exit: null, emphasis: null, junk: 1}));
  assert.deepStrictEqual(explicit, base);
  const n = plain(RT.normalizeLayer({component: 'k', transform: {dx: 99999, scale: 0, rotate: 720, anchor: 'nowhere'}, opacity: 2, loop: {count: 0, mode: 'x'}, enter: {type: 'slide', from: 'up', duration: 99}}));
  assert.deepStrictEqual(n.transform, {dx: 2000, dy: 0, anchor: 'center', scale: 0.1, rotate: 360});
  assert.strictEqual(n.opacity, 1); assert.deepStrictEqual(n.loop, {count: 1, mode: 'restart'}); assert.deepStrictEqual(n.enter, {type: 'slide', from: 'left', duration: 60, ease: 'outCubic'});
});
test('frameKey：省略與明寫預設值同一個鍵；框架屬性或配色一改就換鍵', () => {
  const opts = {width: 1920, height: 1080, fps: '30', frames: 90, fonts: 'f1'};
  const k = RT.frameKey(probeInst({}), PROBE_COMPS, opts);
  assert.strictEqual(RT.frameKey(probeInst({transform: {dx: 0}, opacity: 1, shadow: null}), PROBE_COMPS, opts), k);
  for (const l of [{transform: {dx: 1}}, {opacity: 0.5}, {fade: {out: 0.3}}, {path: [{t: 0, cx: 0.1, cy: 0.1}]}, {shadow: {}}, {outline: {}}, {loop: {count: 2}}, {enter: {type: 'fade'}}, {exit: {type: 'fade'}}, {emphasis: {type: 'pulse'}}])
    assert.notStrictEqual(RT.frameKey(probeInst(l), PROBE_COMPS, opts), k, JSON.stringify(l));
  assert.notStrictEqual(RT.frameKey(probeInst({}, {palette: {primary: '#0000ff'}}), PROBE_COMPS, opts), k);
});
test('新型別 font／easing／angle／duration／direction：驗證、預設與夾範圍', () => {
  const c = RT.validateComponent({id: 'x', kind: 'visual', name: 'x', code: 'function draw(g){}', params: {
    f: {type: 'font', default: 'display'}, e: {type: 'easing', default: 'outBack'}, a: {type: 'angle', default: 45}, d: {type: 'duration', default: 0.5}, dir: {type: 'direction', default: 'top', allowAuto: true}}});
  assert.deepStrictEqual(plain(c.params.a), {type: 'angle', min: -360, max: 360, default: 45});
  assert.deepStrictEqual(plain(c.params.d), {type: 'duration', min: 0, max: 60, default: 0.5});
  assert.deepStrictEqual(plain(c.params.dir), {type: 'direction', default: 'top', allowAuto: true});
  const r = plain(RT.resolveParams(c.params, {f: 'comic', e: 'bounce', a: 400, d: -1, dir: 'auto'}));
  assert.deepStrictEqual(r, {f: 'display', e: 'outBack', a: 360, d: 0, dir: 'auto'});
  assert.strictEqual(RT.resolveParams({dir: {type: 'direction', default: 'top'}}, {dir: 'auto'}).dir, 'top', '沒 allowAuto 就不收 auto');
  const ok = {id: 'x', kind: 'visual', name: 'x', code: 'function draw(g){}'};
  throwsAnim(() => RT.validateComponent({...ok, params: {f: {type: 'font', default: 'comic'}}}), '預設');
  throwsAnim(() => RT.validateComponent({...ok, params: {e: {type: 'easing', default: 'zoom'}}}), '預設');
  throwsAnim(() => RT.validateComponent({...ok, params: {a: {type: 'angle', default: 400}}}), '預設');
  throwsAnim(() => RT.validateComponent({...ok, params: {d: {type: 'duration', default: 61}}}), '預設');
  throwsAnim(() => RT.validateComponent({...ok, params: {dir: {type: 'direction', default: 'auto'}}}), '預設');
});
test('配色 palette：參數定義有 role 且 palette 有該鍵時覆蓋圖層的值', () => {
  const defs = {color: {type: 'color', role: 'primary', default: '#ff0000'}, textColor: {type: 'color', role: 'text', default: '#ffffff'}, other: {type: 'color', default: '#000000'}};
  const r = plain(RT.resolveParams(defs, {color: '#00ff00', other: '#111111'}, {primary: '#0000ff', outline: '#123456'}));
  assert.deepStrictEqual(r, {color: '#0000ff', textColor: '#ffffff', other: '#111111'});
  assert.strictEqual(RT.validateComponent({id: 'x', kind: 'visual', name: 'x', code: 'function draw(g){}', params: {c: {type: 'color', role: 'primary', default: '#ff0000'}}}).params.c.role, 'primary');
  throwsAnim(() => RT.validateComponent({id: 'x', kind: 'visual', name: 'x', code: 'function draw(g){}', params: {c: {type: 'color', role: 'rainbow', default: '#ff0000'}}}), 'role');
});
test('point 參數進 draw 前換成 1080p 虛擬像素', () => {
  const comp = {kind: 'visual', params: {at: {type: 'point', default: {x: 0.5, y: 0.5}}}, code: 'function draw(g, t, p){ g.begin(); g.rect(p.at.x, p.at.y, 1, 1); g.fill({}) }'};
  const key = RT.componentHash(comp); const ctx = fakeCtx(1920, 1080);
  RT.drawFrame(ctx, {id: 'a', box: {cx: 0.5, cy: 0.5, w: 0.2, h: 0.2}, layers: [{component: key, params: {at: {x: 0.25, y: 1}}}]}, {[key]: comp}, {frame: 0, fps: 30, duration: 1, videoW: 1920, videoH: 1080});
  assert.deepStrictEqual(rectOf(ctx).slice(0, 2), [480, 1080]);
});
test('transform：偏移、錨點旋轉、縮放套在 draw 之前（translate→rotate→scale）', () => {
  const ctx = probeDraw({transform: {dx: 100, dy: -50, scale: 2, rotate: 90, anchor: 'top-left'}}, 1);
  const names = ctx.calls.map(c => c[0]); const i = names.indexOf('rotate');
  assert.ok(i > 0 && names[i - 1] === 'translate' && names[i + 1] === 'scale' && names.indexOf('rect') > i, names.join(','));
  assert.ok(near(ctx.calls[i][1], Math.PI / 2)); assert.deepStrictEqual(ctx.calls[i + 1].slice(1), [2, 2]);
  assert.deepStrictEqual(ctx.calls[i - 1].slice(1), [720 + 100, 405 - 50], '錨點＝框左上角，加上偏移');
  const back = ctx.calls.slice(i + 2).find(c => c[0] === 'translate'); assert.deepStrictEqual(back.slice(1), [-720, -405]);
  assert.deepStrictEqual(rectOf(probeDraw({}, 1)), [720, 405, 480, 1], '沒有框架屬性時和以前一樣');
});
test('path：框中心照時間線性內插，寬高不變', () => {
  const path = [{t: 0, cx: 0.25, cy: 0.25}, {t: 2, cx: 0.75, cy: 0.25}];
  assert.deepStrictEqual(rectOf(probeDraw({path}, 0)).slice(0, 3), [240, 135, 480]);
  assert.deepStrictEqual(rectOf(probeDraw({path}, 1)).slice(0, 3), [720, 135, 480]);
  assert.deepStrictEqual(rectOf(probeDraw({path}, 2.5)).slice(0, 3), [1200, 135, 480], '超過最後一點停在最後一點');
});
test('loop：重映插件的 t 與 env.duration；pingpong 單數段倒轉', () => {
  assert.ok(near(rectOf(probeDraw({loop: {count: 3}}, 1.2))[3], 0.2));
  assert.ok(near(rectOf(probeDraw({loop: {count: 3, mode: 'pingpong'}}, 1.2))[3], 0.8));
  assert.ok(near(rectOf(probeDraw({loop: {count: 3, mode: 'pingpong'}}, 2.2))[3], 0.2));
  const dur = {kind: 'visual', params: {}, code: 'function draw(g, t, p, env){ g.begin(); g.rect(env.duration, 0, 1, 1); g.fill({}) }'}; const k = RT.componentHash(dur);
  const ctx = fakeCtx(); RT.drawFrame(ctx, {id: 'a', box: {cx: 0.5, cy: 0.5, w: 0.2, h: 0.2}, layers: [{component: k, params: {}, loop: {count: 3}}]}, {[k]: dur}, {frame: 0, fps: 30, duration: 3, videoW: 1920, videoH: 1080});
  assert.strictEqual(rectOf(ctx)[0], 1);
});
test('opacity 與 fade：整層先畫到離屏畫布、合成時套 globalAlpha（插件內重疊的筆畫不會各自半透明）', () => {
  const alphaOf = ctx => { const d = ctx.calls.find(c => c[0] === 'drawAlpha'); return d ? d[1] : ctx.calls.find(c => c[0] === 'fillAlpha')[1]; };
  assert.ok(near(alphaOf(probeDraw({opacity: 0.5}, 1)), 0.5));
  assert.ok(near(alphaOf(probeDraw({fade: {in: 1, easeIn: 'linear'}}, 0.5)), 0.5));
  assert.ok(near(alphaOf(probeDraw({fade: {out: 1, easeOut: 'linear'}}, 2.5)), 0.5));
  assert.ok(near(alphaOf(probeDraw({fade: {out: 1, easeOut: 'linear'}, end: 2}, 1.5)), 0.5), '圖層有終點時以終點算淡出');
  assert.ok(near(alphaOf(probeDraw({}, 1)), 1)); assert.ok(!probeDraw({}, 1).calls.some(c => c[0] === 'drawImage'), '不透明時直接畫在主畫布');
  assert.ok(!probeDraw({opacity: 0}, 1).calls.some(c => c[0] === 'drawImage' || c[0] === 'rect'), '完全透明就不畫');
});
test('enter／exit：滑入從畫布外開始、進場結束後沒有偏移；退場淡出到 0；彈出從 0 放大；wipe 用裁切', () => {
  const t0 = probeDraw({enter: {type: 'slide', from: 'left', duration: 1, ease: 'linear'}}, 0);
  const tr = t0.calls.find(c => c[0] === 'translate'); assert.ok(tr && tr[1] <= -(240 + 1e-6), '一開始整個框在畫布左外側：' + tr[1]);
  const t1 = probeDraw({enter: {type: 'slide', from: 'left', duration: 1, ease: 'linear'}}, 1.5);
  assert.deepStrictEqual(rectOf(t1).slice(0, 2), [720, 405]);
  assert.ok(!probeDraw({exit: {type: 'fade', duration: 1, ease: 'linear'}}, 3).calls.some(c => c[0] === 'drawImage'), '退場淡到 0 就不畫');
  assert.ok(near(probeDraw({exit: {type: 'fade', duration: 1, ease: 'linear'}}, 2.5).calls.find(c => c[0] === 'drawAlpha')[1], 0.5));
  const pop = probeDraw({enter: {type: 'pop', duration: 1}}, 0); const sc = pop.calls.find(c => c[0] === 'scale'); assert.ok(sc && sc[1] < 0.05, '彈出從 0 開始');
  const wipe = probeDraw({enter: {type: 'wipe', from: 'top', duration: 1, ease: 'linear'}}, 0.5);
  assert.ok(wipe.calls.some(c => c[0] === 'clip'), 'wipe 要有裁切');
  const r = wipe.calls.find(c => c[0] === 'rect'); assert.ok(r[2] === 0 && r[4] >= 540 - 1e-6 && r[4] <= 1080 && r[3] >= 1920, 'wipe 的裁切框從畫布頂端往下、整個畫布寬：' + r.slice(1));
});
test('emphasis：脈動改縮放、搖晃改位移、閃爍改透明度', () => {
  const sc = probeDraw({emphasis: {type: 'pulse', period: 1, strength: 1}}, 0.25).calls.find(c => c[0] === 'scale'); assert.ok(sc && Math.abs(sc[1] - 1) > 0.01);
  const tr = probeDraw({emphasis: {type: 'shake', period: 1, strength: 1}}, 0.25).calls.filter(c => c[0] === 'translate'); assert.ok(tr.some(c => Math.abs(c[1] - 960) > 0.5));
  const bl = probeDraw({emphasis: {type: 'blink', period: 1, strength: 1}}, 0.5).calls.find(c => c[0] === 'drawAlpha'); assert.ok(bl && bl[1] < 0.99);
});
test('shadow／outline：圖層先畫到離屏畫布再合成；描邊以 8 方向偏移染色疊上', () => {
  const made = fxMade;
  const ctx = probeDraw({shadow: {color: '#000000', blur: 10, dx: 2, dy: 3}}, 1);
  assert.ok(made.length >= 1 && made[0].calls.some(c => c[0] === 'rect'), '圖層畫在離屏畫布');
  assert.strictEqual(ctx.calls.filter(c => c[0] === 'drawImage').length, 1);
  assert.ok(ctx.calls.some(c => c[0] === 'shadow' && c[1] === '#000000'), JSON.stringify(ctx.calls.filter(c => c[0] === 'shadow')));
  const ctx2 = probeDraw({outline: {color: '#ffffff', width: 4}}, 1);
  const di2 = ctx2.calls.filter(c => c[0] === 'drawImage'); assert.ok(di2.length >= 8 * 2 + 1, '8 方向 × ⌈寬/2⌉ 步＋本體：' + di2.length);
  assert.ok(made.some(c => c.calls.some(x => x[0] === 'composite' && x[1] === 'source-in')), '染色用 source-in');
  assert.ok(!made[0].calls.some(x => x[0] === 'composite' && x[1] === 'source-in'), '不能在圖層本身的離屏畫布上 source-in');
});


console.log('— vet 試跑與 API 清單（§10.2）');
test('validateComponent 冪等：正規化兩次的雜湊相同（個人庫重新載入不會改雜湊）', () => {
  const x = {id: 'x', kind: 'visual', name: 'x', code: 'function draw(g){ g.begin(); g.rect(0,0,1,1); g.fill({}) }', params: {f: {type: 'font', default: 'display'}, e: {type: 'easing', default: 'outBack'}, a: {type: 'angle', default: 45}, d: {type: 'duration', default: 0.5},
    dir: {type: 'direction', default: 'top', allowAuto: true}, c: {type: 'color', role: 'primary', default: '#FF0000'}, n: {type: 'number', min: 0, max: 1, default: 0.5, step: 0.1}, en: {type: 'enum', values: ['a', 'b'], labels: ['甲', '乙'], default: 'a'}, t: {type: 'text', default: 'x', maxLength: 10}, p: {type: 'point', default: {x: 0.1, y: 0.2}}, b: {type: 'boolean', default: false}}};
  const a = RT.validateComponent(x), b = RT.validateComponent(a);
  assert.strictEqual(RT.componentHash(a), RT.componentHash(b)); assert.deepStrictEqual(plain(a), plain(b));
});
test('vetComponent：每個階段的失敗都帶 stage；通過回正規化插件', () => {
  const ok = {id: 'x', kind: 'visual', name: 'x', params: {m: {type: 'enum', values: ['a', 'b'], default: 'a'}}, code: 'function draw(g, t, p){ g.begin(); g.rect(0, 0, 10, 10); g.fill({}) }'};
  assert.strictEqual(RT.vetComponent(fakeCtx(), ok).id, 'x');
  const stage = raw => { try { RT.vetComponent(fakeCtx(), raw); } catch (e) { return [e.stage, e]; } return [null]; };
  assert.strictEqual(stage({...ok, kind: 'script'})[0], 'schema');
  const [s2, e2] = stage({...ok, code: 'function draw(g){ g.rect( }'}); assert.strictEqual(s2, 'compile'); assert.ok(e2.line >= 1);
  assert.strictEqual(stage({...ok, code: 'function draw(g, t, p, env, bg){ const r = bg.find("#00ff00", 10); g.begin(); g.rect(r.x, 0, 1, 1); g.fill({}) }'})[0], 'smoke');
  const [s4, e4] = stage({...ok, code: 'function draw(g, t, p){ if (p.m === "b") { const z = null; g.rect(z.x, 0, 1, 1) } g.begin(); g.rect(0, 0, 1, 1); g.fill({}) }'});
  assert.strictEqual(s4, 'variants'); assert.deepStrictEqual(plain(e4.variant), {m: 'b'});
  assert.strictEqual(stage({...ok, code: 'function draw(g, t){ if (t > 5) { g.begin(); g.rect(0, 0, 1, 1); g.fill({}) } }'})[0], 'blank');
  assert.strictEqual(stage({id: 's', kind: 'sound', name: 's', params: {}, code: 'function sound(a){ }'})[0], 'blank');
  assert.strictEqual(RT.vetComponent(fakeCtx(), {id: 's', kind: 'sound', name: 's', params: {}, code: 'function sound(a){ a.tone({dur: 0.2}) }'}).kind, 'sound');
});
test('vetComponent lintPaths：沒有 g.begin() 就連畫多個形狀會重畫前面的形狀（Vibe特效殘影），只在 AI 驗證時開', () => {
  const base = {id: 'x', kind: 'visual', name: 'x', params: {}};
  const vet = (code, opts) => { try { RT.vetComponent(fakeCtx(), {...base, code}, opts); } catch (e) { return [e.stage, e.message]; } return [null]; };
  // Pixi 式寫法：圓填色後直接畫線描邊，沒有 g.begin()，描邊會連同圓一起重畫
  const reuse = 'function draw(g, t){ g.circle(10, 10, 5); g.fill({color: "#999"}); g.line(0, 0, 50, 50); g.stroke({color: "#000", width: 8}); }';
  const [stage, message] = vet(reuse, {lintPaths: true});
  assert.strictEqual(stage, 'path'); assert.ok(/g\.begin/.test(message), message);
  assert.strictEqual(vet(reuse)[0], null, '沒開 lintPaths 時照舊通過（我的插件載入、內建插件都不受影響）');
  // 每個形狀前都 g.begin()：通過
  assert.strictEqual(vet('function draw(g, t){ g.begin(); g.circle(10, 10, 5); g.fill({color: "#999"}); g.begin(); g.line(0, 0, 50, 50); g.stroke({color: "#000", width: 8}); }', {lintPaths: true})[0], null);
  // 同一個形狀先填色再描邊：不算重畫
  assert.strictEqual(vet('function draw(g, t){ g.begin(); g.rect(0, 0, 40, 20); g.fill({color: "#999"}); g.stroke({color: "#000", width: 2}); }', {lintPaths: true})[0], null);
  // 一條路徑含多段（moveTo／lineTo）只描邊一次：不算重畫
  assert.strictEqual(vet('function draw(g, t){ g.begin(); g.moveTo(0, 0); g.lineTo(10, 10); g.moveTo(20, 0); g.lineTo(30, 10); g.stroke({color: "#000", width: 2}); }', {lintPaths: true})[0], null);
});
test('schema 2 欄位：category／preview 驗證並保留，不影響雜湊', () => {
  const base = {id: 'x', kind: 'visual', name: 'x', params: {}, code: 'function draw(g){}'};
  const c = RT.validateComponent({...base, schema: 2, category: 'pointer', preview: {t: 0.5, box: {w: 0.2, h: 0.1}}});
  assert.deepStrictEqual(plain([c.schema, c.category, c.preview]), [2, 'pointer', {t: 0.5, box: {w: 0.2, h: 0.1}}]);
  assert.strictEqual(RT.componentHash(c), RT.componentHash(RT.validateComponent(base)));
  assert.deepStrictEqual(plain(RT.validateComponent({...base, preview: {}}).preview), {t: 1, box: {w: 0.3, h: 0.2}});
  throwsAnim(() => RT.validateComponent({...base, category: 'magic'}), 'category');
  throwsAnim(() => RT.validateComponent({...base, preview: {t: 99}}), 'preview');
  throwsAnim(() => RT.validateComponent({...base, schema: 3}), 'schema');
  const ctx = fakeCtx(160, 90); assert.strictEqual(RT.thumbnail(ctx, {...c, code: 'function draw(g, t, p, env){ g.begin(); g.rect(env.box.x, env.box.y, env.box.w, env.box.h); g.fill({}) }'}), true);
  assert.ok(ctx.calls.some(x => x[0] === 'rect'), '縮圖要畫得出來'); assert.strictEqual(RT.thumbnail(ctx, {kind: 'sound'}), false);
});
test('paramVariants：新型別每個值都有一組', () => {
  const v = RT.paramVariants({f: {type: 'font', default: 'sans'}, d: {type: 'direction', default: 'left', allowAuto: true}, a: {type: 'angle', min: -90, max: 90, default: 0}});
  assert.strictEqual(v.length, 1 + 4 + 9 + 2);
});
test('apiManifest：由實際成員產生、每個成員都有文件、沒有不存在的成員', () => {
  const m = RT.apiManifest();
  assert.deepStrictEqual(plain(m.g.map(x => x.name)), plain(AnimVM.members(RT.makeGraphics(fakeCtx()))));
  assert.deepStrictEqual(plain(m.bg.map(x => x.name)), plain(AnimVM.members(RT.makeBackground(null))));
  assert.deepStrictEqual(plain(m.a.map(x => x.name)), ['tone', 'noise']);
  assert.ok(m.env.some(x => x.name === 'rand') && m.globals.some(x => x.name === 'lerp'));
  for (const sec of ['g', 'a', 'bg', 'env', 'globals']) for (const x of m[sec]) assert.ok(typeof x.doc === 'string' && x.doc.length > 2, sec + '.' + x.name);
  const actual = {g: AnimVM.members(RT.makeGraphics(fakeCtx())), a: ['tone', 'noise'], bg: AnimVM.members(RT.makeBackground(null)), env: m.env.map(x => x.name), globals: Object.keys(AnimVM.makeGlobals())};
  for (const sec of Object.keys(actual)) for (const name of Object.keys(RT.DOCS[sec])) assert.ok(actual[sec].includes(name), `DOCS.${sec}.${name} 不存在於實際成員`);
  assert.deepStrictEqual(plain(m.ease), Object.keys(AnimVM.EASE)); assert.ok(m.params.types.includes('direction') && m.framework.enter.includes('wipe') && m.limits.code > 0);
});

test('frontend/anim_api_manifest.json 與 runtime 的 apiManifest() 一致（改了 API 要重跑 node scripts/anim-vet-cli.js --write-manifest）', () => {
  const file = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'anim_api_manifest.json'), 'utf8'));
  assert.deepStrictEqual(file, plain(RT.apiManifest()));
});

console.log(`\n${passed}/${passed + failures.length} 通過`);
if (failures.length) { console.log('失敗：' + failures.join('、')); process.exit(1); }
