// 移植自 transcript-review（字導字演）scripts/ 的單元測試（2026-10-27，commit 7d4badc），由 src/anim/legacy.test.ts 交給 Vitest 執行；
// 只改了檔案路徑，以及 test() 在 Vitest 下改成登記測試（globalThis.__animCollect）。
'use strict';
// 動畫腳本直譯器（frontend/anim_vm.js）的單元測試，不需瀏覽器。設計見 docs/superpowers/specs/2026-10-06-anim-engine-design.md §2、§3。
// 護欄是這一層的核心：元件程式碼（之後來自 AI、其他使用者）一律不可信，所以每一類禁止的語法、拼出來的危險屬性、
// 無窮迴圈、無限遞迴、超大陣列與字串、跨格保留狀態都要被擋下，而且錯誤訊息要帶行號（第三階段會丟回給 AI 修正）。
// 用法：node scripts/anim-vm-unit.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONTEND = path.join(__dirname, '..');  // WordBlade：src/anim（直譯器與執行環境在 vendor/）
const sandbox = {console};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'vendor', 'acorn.js'), 'utf8'), sandbox, {filename: 'acorn.js'});
vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'vendor', 'anim_vm.js'), 'utf8'), sandbox, {filename: 'anim_vm.js'});
const AnimVM = vm.runInContext('AnimVM', sandbox);

let passed = 0;
const failures = [];
/** 執行一項測試並記錄結果（失敗不中斷，最後一起列出）。 */
function test(name, fn) { if (globalThis.__animCollect) return globalThis.__animCollect(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('FAIL  ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')); }
}
/** 編譯後呼叫 entry，回傳轉成一般 JSON 的結果（跨 vm 領域比較用 JSON）。 */
function run(code, entry = 'main', args = []) {
  const program = AnimVM.compile(code, {entry});
  return JSON.parse(JSON.stringify(AnimVM.toPlain(program.call(entry, args)) ?? null));
}
/** 斷言編譯（或執行）會失敗，而且錯誤訊息包含 hint（有給的話）、帶行號。 */
function rejects(code, hint, entry = 'main', args = []) {
  let error = null;
  try { AnimVM.compile(code, {entry}).call(entry, args); } catch (e) { error = e; }
  assert.ok(error, '應該被擋下：' + code);
  assert.ok(error.name === 'AnimError', '應是 AnimError 而不是程式本身的例外：' + (error && error.stack));
  if (hint) assert.ok(String(error.message).includes(hint), `錯誤訊息「${error.message}」應包含「${hint}」`);
  assert.ok(typeof error.line === 'number' && error.line >= 1, '錯誤要帶行號：' + error.message);
}

console.log('— 語法白名單（靜態）');
// 下列字串是「直譯器必須拒絕」的輸入範例（含 eval、fetch、Function 等），只交給 AnimVM.compile 檢查，
// 本測試從不以 JavaScript 的 eval／Function 執行它們。
const STATIC_REJECTS = [
  ['eval', 'function main(){ return eval("1") }', 'eval'],
  ['window', 'function main(){ return window.location }', 'window'],
  ['document', 'function main(){ return document }', 'document'],
  ['globalThis', 'function main(){ return globalThis }', 'globalThis'],
  ['fetch', 'function main(){ fetch("http://x") }', 'fetch'],
  ['Function', 'function main(){ return Function("return 1")() }', 'Function'],
  ['arguments', 'function main(){ return arguments.length }', 'arguments'],
  ['Date', 'function main(){ return Date.now() }', 'Date'],
  ['setTimeout', 'function main(){ setTimeout(main, 1) }', 'setTimeout'],
  ['this', 'function main(){ return this }', 'this'],
  ['new', 'function main(){ return new Array(3) }', 'new'],
  ['class', 'class A {} function main(){ return 1 }', 'class'],
  ['var', 'var x = 1; function main(){ return x }', 'var'],
  ['delete', 'function main(){ const o = {a: 1}; delete o.a; return o }', 'delete'],
  ['void', 'function main(){ return void 0 }', 'void'],
  ['in', 'function main(){ return "a" in {a: 1} }', 'in'],
  ['instanceof', 'function main(){ return [] instanceof Object }', 'instanceof'],
  ['try', 'function main(){ try { return 1 } catch (e) { return 2 } }', 'try'],
  ['throw', 'function main(){ throw 1 }', 'throw'],
  ['label', 'function main(){ outer: for (let i = 0; i < 1; i++) {} }', 'label'],
  ['debugger', 'function main(){ debugger }', 'debugger'],
  ['正規表示式', 'function main(){ return /a+/.test("aa") }', '正規表示式'],
  ['async', 'async function main(){ return 1 }', 'async'],
  ['generator', 'function* main(){ yield 1 }', 'generator'],
  ['tagged template', 'function tag(s){ return s } function main(){ return tag`x` }', 'tagged'],
  ['getter', 'function main(){ return {get a(){ return 1 }} }', 'getter'],
  ['constructor 屬性', 'function main(){ return [].constructor }', 'constructor'],
  ['__proto__ 屬性', 'function main(){ return ({}).__proto__ }', '__proto__'],
  ['字串索引 __proto__', 'function main(){ return ({})["__proto__"] }', '__proto__'],
  ['prototype', 'function f(){} function main(){ return f.prototype }', 'prototype'],
  ['Math.random', 'function main(){ return Math.random() }', 'random'],
  ['import 語法', 'import x from "y"; function main(){ return 1 }', null],
];
for (const [name, code, hint] of STATIC_REJECTS) test('拒絕 ' + name, () => rejects(code, hint));

test('語法錯誤也回 AnimError 並帶行號', () => rejects('function main(){\n  return 1 +\n}', null));
test('沒有入口函式時拒絕', () => rejects('function draw(){ return 1 }', 'main'));

console.log('— 執行時的關卡（拼出來的危險屬性、原生方法）');
test('拼出來的 constructor 被擋下', () => rejects('function main(){ const k = "con" + "structor"; return [1][k] }', 'constructor'));
test('拼出來的 __proto__ 被擋下', () => rejects('function main(){ const k = "__pro" + "to__"; const o = {}; return o[k] }', '__proto__'));
test('物件沒有 toString（只有自己的鍵）', () => rejects('function main(){ const o = {}; return o.toString() }', '函式'));
test('物件的 hasOwnProperty 拿不到', () => rejects('function main(){ const o = {a: 1}; return o.hasOwnProperty("a") }', '函式'));
test('陣列的白名單外方法拿不到', () => rejects('function main(){ return [1, 2].copyWithin(0, 1) }', 'copyWithin'));
test('陣列以字串下標取非白名單名稱被擋下', () => rejects('function main(){ const k = "valueOf"; return [1][k]() }', 'valueOf'));
test('函式沒有屬性', () => rejects('function f(){} function main(){ return f.call }', 'call'));
test('字串的白名單外方法拿不到', () => rejects('function main(){ return "abc".localeCompare("b") }', 'localeCompare'));
test('Math 白名單外成員拿不到（拼出來的）', () => rejects('function main(){ const k = "ran" + "dom"; return Math[k]() }', 'random'));
test('呼叫不是函式的值', () => rejects('function main(){ const x = 3; return x() }', '函式'));
test('未定義的名稱', () => rejects('function main(){ return nope + 1 }', 'nope'));

console.log('— 資源上限');
test('無窮迴圈被步數上限中止', () => rejects('function main(){ while (true) {} }', '上限'));
test('無限遞迴被呼叫深度上限中止', () => rejects('function f(n){ return f(n + 1) } function main(){ return f(0) }', '上限'));
test('超大陣列被擋下', () => rejects('function main(){ const a = []; for (let i = 0; i < 20000; i++) a.push(i); return a.length }', '上限'));
test('字串炸彈被擋下', () => rejects('function main(){ let s = "a"; for (let i = 0; i < 20; i++) s = s + s; return s.length }', '上限'));
test('repeat 也受字串上限', () => rejects('function main(){ return "ab".repeat(5000) }', '上限'));
test('大量複製（slice／concat）依元素數計步，不能在步數內灌爆記憶體', () => rejects(
  'function main(){ let a = [1]; for (let i = 0; i < 13; i++) a = a.concat(a); let n = 0; for (let k = 0; k < 100; k++) n += a.slice().length; return n }', '上限'));
test('展開大量元素也計步', () => rejects(
  'function main(){ let a = [1]; for (let i = 0; i < 13; i++) a = a.concat(a); let n = 0; for (let k = 0; k < 100; k++) n += [...a].length; return n }', '上限'));
test('自我參照的陣列轉字串不會無限遞迴', () => assert.strictEqual(JSON.stringify(run(
  'function main(){ const a = [1]; a.push(a); return String(a) + "|" + a.join("-") }')), JSON.stringify('1,|1-')));
test('入口函式不能改模組層的變數（跨格保留狀態）', () => rejects('let n = 0; function main(){ n++; return n }', '狀態'));
test('入口函式不能改模組層的陣列', () => rejects('const xs = [1]; function main(){ xs.push(2); return xs.length }', '狀態'));
test('入口函式不能改模組層的物件', () => rejects('const o = {a: 1}; function main(){ o.a = 2; return o.a }', '狀態'));

console.log('— 語意');
test('四則、比較、邏輯、三元、nullish', () => assert.strictEqual(JSON.stringify(run(
  'function main(){ const a = 7, b = 2; return [a + b, a - b, a * b, a / b, a % b, a ** b, a > b, a === 7 && b !== 3, null ?? 5, a > 5 ? "大" : "小"] }')),
  JSON.stringify([9, 5, 14, 3.5, 1, 49, true, true, 5, '大'])));
test('閉包、箭頭函式、預設參數、解構', () => assert.strictEqual(JSON.stringify(run(
  'function mk(k = 2){ return x => x * k } function main(){ const {a, b: [c, d]} = {a: 1, b: [2, 3]}; const f = mk(); const g = mk(10); return [f(a), g(c), d] }')),
  JSON.stringify([2, 20, 3])));
test('樣板字串、spread、for…of、複合指定、++', () => assert.strictEqual(JSON.stringify(run(
  'function main(){ const xs = [1, 2, ...[3, 4]]; let s = 0; for (const x of xs) s += x; let i = 0; i++; ++i; return `${s}-${i}` }')),
  JSON.stringify('10-2')));
test('陣列方法（map／filter／reduce／some／every／find／indexOf／includes／join／slice／concat）', () => assert.strictEqual(JSON.stringify(run(
  'function main(){ const xs = [3, 1, 2]; return [xs.map(x => x * 2), xs.filter(x => x > 1), xs.reduce((s, x) => s + x, 0), xs.some(x => x > 2), xs.every(x => x > 0), xs.find(x => x < 3), xs.indexOf(2), xs.includes(5), xs.join("-"), xs.slice(1), xs.concat([9])] }')),
  JSON.stringify([[6, 2, 4], [3, 2], 6, true, true, 1, 2, false, '3-1-2', [1, 2], [3, 1, 2, 9]])));
test('sort 是穩定排序（比較函式相等時保持原順序）', () => assert.strictEqual(JSON.stringify(run(
  'function main(){ const xs = [{k: 1, n: "a"}, {k: 0, n: "b"}, {k: 1, n: "c"}, {k: 0, n: "d"}]; return xs.slice().sort((p, q) => p.k - q.k).map(x => x.n).join("") }')),
  JSON.stringify('bdac')));
test('字串方法與 String／Number／parseInt／parseFloat', () => assert.strictEqual(JSON.stringify(run(
  'function main(){ const s = " Hello "; return [s.trim().toUpperCase(), "a,b".split(","), "abc".slice(1), "7".padStart(3, "0"), String(12), Number("3.5") + 1, parseInt("42px"), parseFloat("1.5e1"), (1.234).toFixed(2), "abc".length, "abc"[1]] }')),
  JSON.stringify(['HELLO', ['a', 'b'], 'bc', '007', '12', 4.5, 42, 15, '1.23', 3, 'b'])));
test('Math 白名單與輔助函式 lerp／clamp／ease', () => assert.strictEqual(JSON.stringify(run(
  'function main(){ return [Math.round(Math.PI * 100), Math.max(1, 5, 3), Math.hypot(3, 4), lerp(0, 10, 0.25), clamp(12, 0, 10), ease.inOutQuad(0.5), ease.linear(0.3)] }')),
  JSON.stringify([314, 5, 5, 2.5, 10, 0.5, 0.3])));
test('可選串連與 typeof', () => assert.strictEqual(JSON.stringify(run(
  'function main(){ const o = {a: {b: 2}}; return [o?.a?.b, o?.x?.y ?? "無", typeof o, typeof 1, typeof "s", typeof main] }')),
  JSON.stringify([2, '無', 'object', 'number', 'string', 'function'])));
test('入口函式收得到參數，模組層常數可以讀', () => assert.strictEqual(JSON.stringify(run(
  'const BASE = 10; function main(t, p){ return BASE + t * p.k }', 'main', [2, {k: 3}])),
  JSON.stringify(16)));
test('入口函式自己建的陣列可以改（只有模組層的值凍結）', () => assert.strictEqual(JSON.stringify(run(
  'const SEED = [1, 2]; function main(){ const xs = SEED.slice(); xs.push(3); xs[0] = 9; return xs }')),
  JSON.stringify([9, 2, 3])));
test('同一個程式重複呼叫結果相同（不保留跨格狀態）', () => {
  const program = AnimVM.compile('function main(t){ const xs = []; for (let i = 0; i < 3; i++) xs.push(t + i); return xs }', {entry: 'main'});
  const a = JSON.stringify(AnimVM.toPlain(program.call('main', [1])));
  const b = JSON.stringify(AnimVM.toPlain(program.call('main', [1])));
  assert.strictEqual(a, b);
});

console.log('— 宿主物件與宿主函式（繪圖 g、音效 a 由執行環境提供）');
test('宿主物件只認白名單成員', () => {
  const calls = [];
  const g = AnimVM.hostObject('g', {line: AnimVM.hostFunction('line', (x1, y1) => { calls.push([x1, y1]); return null; })});
  const program = AnimVM.compile('function main(g){ g.line(1, 2); g.line(3, 4); return g.nope }', {entry: 'main'});
  let error = null; try { program.call('main', [g]); } catch (e) { error = e; }
  assert.ok(error && error.name === 'AnimError' && error.message.includes('nope'), '白名單外成員要被擋下：' + (error && error.message));
  assert.strictEqual(JSON.stringify(calls), JSON.stringify([[1, 2], [3, 4]]));
});
test('宿主函式丟出的 AnimError 帶呼叫處的行號', () => {
  const g = AnimVM.hostObject('g', {stroke: AnimVM.hostFunction('stroke', () => { throw new AnimVM.AnimError('顏色格式不對'); })});
  const program = AnimVM.compile('function main(g){\n  return g.stroke({color: "red"})\n}', {entry: 'main'});
  let error = null; try { program.call('main', [g]); } catch (e) { error = e; }
  assert.ok(error && error.message.includes('顏色格式不對') && error.line === 2, '應在第 2 行：' + JSON.stringify(error && {m: error.message, l: error.line}));
});
test('宿主函式收到的物件參數沒有原型（不會漏出 Object.prototype）', () => {
  let seen = null;
  const g = AnimVM.hostObject('g', {take: AnimVM.hostFunction('take', o => { seen = o; return null; })});
  AnimVM.compile('function main(g){ g.take({a: 1}) }', {entry: 'main'}).call('main', [g]);
  assert.ok(seen && Object.getPrototypeOf(seen) === null && seen.a === 1);
});

console.log(`\n${passed}/${passed + failures.length} 通過`);
if (failures.length) { console.log('失敗：' + failures.join('、')); process.exit(1); }
