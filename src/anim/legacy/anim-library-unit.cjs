// 移植自 transcript-review（字導字演）scripts/ 的單元測試（2026-10-27，commit 7d4badc），由 src/anim/legacy.test.ts 交給 Vitest 執行；
// 只改了檔案路徑，以及 test() 在 Vitest 下改成登記測試（globalThis.__animCollect）。
'use strict';
// 內建動畫元件庫（frontend/anim-library.json）的單元測試，不需瀏覽器（設計 docs/superpowers/specs/2026-10-06-anim-engine-design.md §9、§12）：
//   1. 每個元件通過結構驗證（AnimRuntime.validateComponent）與試跑（smokeTest：五個時間點、有／沒有下層畫面）；
//   2. 每個列舉值、每個是非參數都切換過一輪再畫五個時間點（分支裡的錯字或禁用語法要在這裡抓到）；
//   3. 視覺元件在進場後真的有畫東西（stroke／fill／text），音效元件真的排出音源；
//   4. 範本引用的元件存在、種類相符，參數名稱都在元件的參數表裡、值合型別。
// 用法：node scripts/anim-library-unit.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONTEND = path.join(__dirname, '..');  // WordBlade：src/anim（直譯器與執行環境在 vendor/）
const sandbox = {console, TextEncoder, performance};
vm.createContext(sandbox);
for (const f of ['vendor/acorn.js', 'vendor/anim_vm.js', 'vendor/anim_runtime.js']) vm.runInContext(fs.readFileSync(path.join(FRONTEND, f), 'utf8'), sandbox, {filename: f});
const RT = vm.runInContext('AnimRuntime', sandbox);
const LIBRARY = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'anim-library.json'), 'utf8'));
/** 元件庫檔裡的 code 是一行一個字串的陣列，載入時接起來（同 anim.js 的 loadAnimLibrary）。 */
const components = LIBRARY.components.map(c => ({...c, code: Array.isArray(c.code) ? c.code.join('\n') : c.code}));

/** 記錄指令的假畫布：只記下名稱，measureText 依字數估寬度。 */
function fakeCtx() {
  const calls = [], record = name => () => { calls.push(name); };
  const gradient = () => ({addColorStop() {}});
  return {
    calls, canvas: {width: 1920, height: 1080},
    beginPath: record('beginPath'), moveTo: record('moveTo'), lineTo: record('lineTo'), quadraticCurveTo: record('quadraticCurveTo'),
    bezierCurveTo: record('bezierCurveTo'), arc: record('arc'), ellipse: record('ellipse'), rect: record('rect'), roundRect: record('roundRect'),
    closePath: record('closePath'), fill: record('fill'), stroke: record('stroke'), strokeText: record('strokeText'), fillText: record('fillText'),
    clip: record('clip'), save: record('save'), restore: record('restore'), translate: record('translate'), rotate: record('rotate'), scale: record('scale'),
    setTransform: record('setTransform'), drawImage: record('drawImage'), setLineDash: record('setLineDash'),
    measureText: s => ({width: [...s].length * 40}), createLinearGradient: gradient, createRadialGradient: gradient,
    letterSpacing: '0px',
  };
}
/** 畫一格（元件、參數、t 秒、整段 3 秒），回傳畫布指令。 */
function drawAt(comp, params, t) {
  const ctx = fakeCtx(), program = RT.compileComponent(comp);
  const env = RT.makeEnv({width: 1920, height: 1080, box: {x: 760, y: 420, w: 400, h: 240}, duration: 3, fps: 30, frame: Math.round(t * 30), seed: 5});
  program.call('draw', [RT.makeGraphics(ctx), t, RT.resolveParams(comp.params, params), env, RT.makeBackground(null)]);
  return ctx.calls;
}
/** 每個列舉值與是非值各一組參數（其餘用預設）。 */
function variants(comp) {
  const out = [{}];
  for (const [key, def] of Object.entries(comp.params || {})) {
    if (def.type === 'enum') for (const v of def.values) out.push({[key]: v});
    if (def.type === 'boolean') out.push({[key]: !def.default});
    if (def.type === 'text') out.push({[key]: ''}, {[key]: '第一行\n第二行'});
    if (def.type === 'number') out.push({[key]: def.min}, {[key]: def.max});
  }
  return out;
}

let passed = 0; const failures = [];
function test(name, fn) { if (globalThis.__animCollect) return globalThis.__animCollect(name, fn);
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('FAIL  ' + name + '\n      ' + String(e && e.message || e).split('\n').join('\n      ')); }
}

console.log('— 元件');
test('schema 2：每個插件都有 schema、category；視覺插件有 preview、顏色參數有 role', () => {
  for (const c of components) {
    assert.strictEqual(c.schema, 2, c.id); assert.ok(RT.FRAMEWORK.CATEGORIES.includes(c.category), c.id + ' category');
    if (c.kind === 'visual') { assert.ok(c.preview && c.preview.box, c.id + ' preview'); for (const [k, d] of Object.entries(c.params)) if (d.type === 'color') assert.ok(RT.FRAMEWORK.ROLES.includes(d.role), `${c.id}.${k} 沒有 role`); }
    else assert.strictEqual(c.category, 'sound');
  }
});
test('元件 id 不重複，視覺 14 個、音效 8 個', () => {
  assert.strictEqual(new Set(components.map(c => c.id)).size, components.length);
  assert.strictEqual(components.filter(c => c.kind === 'visual').length, 14);
  assert.strictEqual(components.filter(c => c.kind === 'sound').length, 8);
});
for (const comp of components) {
  test(`${comp.name}（${comp.id}）：結構驗證與試跑`, () => {
    const clean = RT.vetComponent(fakeCtx(), comp);  // vet：結構、試跑、參數變體、有畫東西（§10.2）
    assert.strictEqual(clean.code, comp.code);
  });
  if (comp.kind === 'visual') {
    test(`${comp.name}：每個形狀都有自己的 g.begin()（AI 驗證的 lintPaths 不會誤判內建插件，內建插件常被當底稿）`, () => {
      RT.vetComponent(fakeCtx(), comp, {lintPaths: true});
    });
    test(`${comp.name}：每個選項都畫得出來，進場後有作畫`, () => {
      for (const params of variants(comp)) {
        for (const t of [0, 0.3, 1, 2, 2.9]) {
          try { drawAt(comp, params, t); }
          catch (e) { throw new Error(`參數 ${JSON.stringify(params)}、t=${t}：${e.message}（第 ${e.line} 行）`); }
        }
      }
      const calls = drawAt(comp, {}, 1.2);
      assert.ok(calls.some(c => c === 'stroke' || c === 'fill' || c === 'fillText'), `t=1.2 沒有作畫：${calls.join(',')}`);
    });
  } else {
    test(`${comp.name}：每個選項都排得出音源`, () => {
      for (const params of variants(comp)) {
        const clips = RT.soundClips({id: 'an-lib', sounds: [{component: 'k', params, at: 0}]}, {k: comp}, {duration: 12});
        assert.ok(clips.length === 1 && clips[0].events.length > 0, JSON.stringify(params));
        assert.ok(clips[0].seconds <= 10, `${clips[0].seconds} 秒`);
      }
    });
  }
}

console.log('— 範本');
const byId = Object.fromEntries(components.map(c => [c.id, c]));
test('範本 10 個、id 不重複', () => {
  assert.strictEqual(LIBRARY.templates.length, 10);
  assert.strictEqual(new Set(LIBRARY.templates.map(t => t.id)).size, 10);
});
for (const tpl of LIBRARY.templates) {
  test(`範本「${tpl.name}」引用的元件與參數都對`, () => {
    assert.ok(typeof tpl.name === 'string' && [...tpl.name].length <= 30 && typeof tpl.title === 'string' && [...tpl.title].length <= 30);
    assert.ok(tpl.box && tpl.box.w >= 0.02 && tpl.box.w <= 1 && tpl.box.h >= 0.02 && tpl.box.h <= 1, JSON.stringify(tpl.box));
    assert.ok(tpl.layers.length + tpl.sounds.length > 0 && tpl.layers.length <= 8 && tpl.sounds.length <= 8);
    for (const [list, kind] of [[tpl.layers, 'visual'], [tpl.sounds, 'sound']]) {
      for (const item of list) {
        const comp = byId[item.component];
        assert.ok(comp && comp.kind === kind, `${item.component} 不是${kind}元件`);
        const resolved = RT.resolveParams(comp.params, item.params);
        for (const [key, value] of Object.entries(item.params || {})) {
          assert.ok(Object.prototype.hasOwnProperty.call(comp.params, key), `${comp.id} 沒有參數 ${key}`);
          assert.deepStrictEqual(JSON.parse(JSON.stringify(resolved[key])), value, `${comp.id}.${key} 的值不合型別或超出範圍`);
        }
        if (kind === 'sound') assert.ok(typeof item.at === 'number' && item.at >= 0, '音效起點');
      }
    }
  });
}

console.log(`\n${passed}/${passed + failures.length} 通過`);
if (failures.length) { console.log('失敗：' + failures.join('、')); process.exit(1); }
