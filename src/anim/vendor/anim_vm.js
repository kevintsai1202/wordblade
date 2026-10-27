'use strict';
/** 動畫腳本直譯器（設計 docs/superpowers/specs/2026-10-06-anim-engine-design.md §2、§3）。
 *
 *  元件程式碼一律視為不可信（第三階段起來自 AI，第四階段起來自其他使用者），所以：
 *  1. 以 acorn 解析成語法樹後逐個節點比對白名單，禁止的語法、名稱、屬性一律拒絕（錯誤帶行號）。
 *  2. 程式碼永遠不交給瀏覽器執行（沒有 eval、new Function、<script>），由這裡逐節點直譯；程式碼只拿得到
 *     數字、字串、布林、陣列、沒有原型的資料物件、自己定義的函式，以及執行環境給的宿主物件（繪圖 g、音效 a…）。
 *  3. 每次讀寫屬性都在執行時再檢查（拼出來的 'con'+'structor' 也擋得住）；陣列、字串、數字的方法全部自己實作，
 *     不會把瀏覽器原生的方法交出去。
 *  4. 運算步數、呼叫深度、陣列與字串長度都有上限；模組層的值在初始化後凍結，入口函式不能跨格保留狀態
 *     （否則預覽與逐格輸出的結果會不同）。
 *  這個檔只做直譯：沒有 DOM、沒有全域狀態，node 可直接載入測試（scripts/anim-vm-unit.js）。
 *  檔內出現的 eval、Function 等字樣都只在禁用名單與說明裡，本檔從不呼叫它們；execStatement 是「執行一條敘述」，與 child_process 無關。 */
const AnimVM = (() => {
  /** 資源上限。 */
  const LIMITS = {steps: 50000, depth: 64, array: 10000, string: 2000, code: 20000};

  /** 元件程式碼的錯誤：訊息給人（與第三階段的 AI）看，帶行號與欄位。 */
  class AnimError extends Error {
    constructor(message, node) {
      super(message);
      this.name = 'AnimError';
      this.line = node && node.loc ? node.loc.start.line : null;
      this.column = node && node.loc ? node.loc.start.column + 1 : null;
    }
  }
  /** 自己定義的函式（閉包）。 */
  class Closure {
    constructor(node, scope, name) { this.node = node; this.scope = scope; this.name = name || '（匿名）'; }
  }
  /** 執行環境提供的函式（繪圖、音效、Math…）：收到的參數都是直譯器的值，回傳值也必須是。 */
  class HostFunction {
    constructor(name, fn) { this.name = name; this.fn = fn; }
  }
  /** 執行環境提供的物件：只認建立時給的成員。 */
  class HostObject {
    constructor(name, members) { this.name = name; this.members = new Map(Object.entries(members)); }
  }

  // ---- 白名單與禁用名稱 ----
  const DENIED = new Set(['eval', 'Function', 'globalThis', 'window', 'self', 'top', 'parent', 'frames', 'document', 'location', 'navigator',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'SharedWorker', 'importScripts', 'postMessage', 'setTimeout', 'setInterval',
    'requestAnimationFrame', 'localStorage', 'sessionStorage', 'indexedDB', 'Proxy', 'Reflect', 'Symbol', 'Promise', 'Date',
    'constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
    'arguments', 'require', 'module', 'process', 'exports', 'import']);
  const ARRAY_METHODS = new Set(['push', 'pop', 'slice', 'map', 'filter', 'forEach', 'reduce', 'some', 'every', 'find', 'findIndex',
    'indexOf', 'includes', 'join', 'concat', 'reverse', 'sort', 'fill']);
  const STRING_METHODS = new Set(['slice', 'substring', 'charAt', 'split', 'toUpperCase', 'toLowerCase', 'trim', 'padStart', 'padEnd',
    'repeat', 'includes', 'indexOf', 'startsWith', 'endsWith']);
  const MATH_MEMBERS = new Set(['abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'exp', 'floor', 'hypot', 'log', 'log2', 'log10',
    'max', 'min', 'pow', 'round', 'sign', 'sin', 'sqrt', 'tan', 'trunc', 'PI', 'E', 'SQRT2', 'LN2', 'LN10']);
  const BINARY_OPS = new Set(['+', '-', '*', '/', '%', '**', '==', '!=', '===', '!==', '<', '<=', '>', '>=', '&', '|', '^', '<<', '>>', '>>>']);
  const UNARY_OPS = new Set(['-', '+', '!', '~', 'typeof']);
  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '&&=', '||=', '??=']);

  // ---- 值的工具 ----
  /** 直譯器的資料物件：沒有原型。 */
  const isDataObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === null;
  const newObject = () => Object.create(null);
  /** typeof：函式（閉包與宿主函式）回 'function'，其餘照 JS。 */
  function typeOf(v) {
    if (v instanceof Closure || v instanceof HostFunction) return 'function';
    if (v === null) return 'object';
    return typeof v;
  }
  /** 轉數字（不呼叫物件的 valueOf：資料物件沒有原型，原生轉型會丟例外）。 */
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v === null) return 0;
    if (Array.isArray(v) && v.length === 1) return toNum(v[0]);
    if (Array.isArray(v) && v.length === 0) return 0;
    return NaN;
  }
  /** 轉字串（陣列以逗號接、物件固定字樣），結果受字串上限。 */
  function toStr(v, node, seen) {
    let s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean' || v === undefined || v === null) s = String(v);
    else if (Array.isArray(v)) {
      const visiting = seen || new Set();
      if (visiting.has(v)) return '';  // 自我參照：同 JS 的 join，循環的地方是空字串
      visiting.add(v);
      s = v.map(x => (x === null || x === undefined ? '' : toStr(x, node, visiting))).join(',');
      visiting.delete(v);
    }
    else if (v instanceof Closure || v instanceof HostFunction) s = '[function]';
    else s = '[object]';
    return checkString(s, node);
  }
  function checkString(s, node) {
    if (s.length > LIMITS.string) throw new AnimError(`字串長度超過上限（${LIMITS.string} 字）`, node);
    return s;
  }
  function checkArray(n, node) {
    if (n > LIMITS.array) throw new AnimError(`陣列長度超過上限（${LIMITS.array} 個）`, node);
  }
  /** 從執行環境帶進來的值（入口參數）轉成直譯器的值：一般物件換成沒有原型的副本，宿主物件／函式照原樣。 */
  function fromHost(v, depth = 0) {
    if (depth > 32) throw new AnimError('參數巢狀太深');
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    if (v instanceof HostObject || v instanceof HostFunction || v instanceof Closure) return v;
    if (Array.isArray(v)) { checkArray(v.length); return v.map(x => fromHost(x, depth + 1)); }
    if (typeof v === 'object') {
      const o = newObject();
      for (const k of Object.keys(v)) { if (DENIED.has(k)) continue; o[k] = fromHost(v[k], depth + 1); }
      return o;
    }
    return undefined;  // 原生函式等其他值不帶進去
  }
  /** 直譯器的值轉成一般 JS 值（測試與除錯用）。 */
  function toPlain(v) {
    if (Array.isArray(v)) return v.map(toPlain);
    if (isDataObject(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = toPlain(v[k]); return o; }
    if (v instanceof Closure || v instanceof HostFunction) return '[function]';
    if (v instanceof HostObject) return '[' + v.name + ']';
    return v;
  }

  // ---- 靜態檢查 ----
  /** 逐個節點比對白名單；回傳第一個錯誤（AnimError）或 null。Math.xxx 這種寫死的成員也在這裡先查。 */
  function checkNode(node, parent, key) {
    if (!node || typeof node.type !== 'string') return null;
    const fail = msg => new AnimError(msg, node);
    switch (node.type) {
      case 'Program': case 'BlockStatement': case 'ExpressionStatement': case 'IfStatement': case 'ForStatement': case 'ForOfStatement':
      case 'WhileStatement': case 'DoWhileStatement': case 'ReturnStatement': case 'EmptyStatement': case 'VariableDeclarator':
      case 'TemplateLiteral': case 'TemplateElement': case 'ArrayExpression': case 'ObjectExpression': case 'SpreadElement':
      case 'RestElement': case 'AssignmentPattern': case 'ArrayPattern': case 'ObjectPattern': case 'LogicalExpression':
      case 'ConditionalExpression': case 'UpdateExpression': case 'CallExpression': case 'ChainExpression': case 'SequenceExpression':
        break;
      case 'BreakStatement': case 'ContinueStatement':
        if (node.label) return fail('不能使用 label（標籤）');
        break;
      case 'ForOfStatement_await': break;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        if (node.async) return fail('不能使用 async 函式');
        if (node.generator) return fail('不能使用 generator 函式');
        break;
      case 'VariableDeclaration':
        if (node.kind === 'var') return fail('不能使用 var，請改用 const 或 let');
        break;
      case 'Identifier':
        if (DENIED.has(node.name) && !isPropertyKey(parent, key)) return fail(`不能使用「${node.name}」`);
        break;
      case 'Literal':
        if (node.regex) return fail('不能使用正規表示式');
        if (typeof node.bigint === 'string') return fail('不能使用 BigInt');
        break;
      case 'Property':
        if (node.kind === 'get' || node.kind === 'set') return fail('不能使用 getter／setter');
        if (!node.computed && propertyName(node.key) !== null && DENIED.has(propertyName(node.key))) return fail(`不能使用「${propertyName(node.key)}」`);
        break;
      case 'MemberExpression': {
        // 先報物件本身（window.location 先說 window 不能用，比先說 location 直覺）
        if (node.object.type === 'Identifier' && DENIED.has(node.object.name)) return new AnimError(`不能使用「${node.object.name}」`, node.object);
        const name = node.computed ? (node.property.type === 'Literal' ? String(node.property.value) : null) : node.property.name;
        if (name !== null && DENIED.has(name)) return fail(`不能使用「${name}」`);
        if (node.object.type === 'Identifier' && node.object.name === 'Math' && name !== null && !MATH_MEMBERS.has(name)) return fail(`「Math」沒有「${name}」`);
        break;
      }
      case 'UnaryExpression':
        if (node.operator === 'delete') return fail('不能使用 delete');
        if (node.operator === 'void') return fail('不能使用 void');
        if (!UNARY_OPS.has(node.operator)) return fail(`不能使用 ${node.operator} 運算子`);
        break;
      case 'BinaryExpression':
        if (node.operator === 'in') return fail('不能使用 in 運算子');
        if (node.operator === 'instanceof') return fail('不能使用 instanceof');
        if (!BINARY_OPS.has(node.operator)) return fail(`不能使用 ${node.operator} 運算子`);
        break;
      case 'AssignmentExpression':
        if (!ASSIGN_OPS.has(node.operator)) return fail(`不能使用 ${node.operator} 運算子`);
        break;
      case 'ThisExpression': return fail('不能使用 this');
      case 'NewExpression': return fail('不能使用 new');
      case 'ClassDeclaration': case 'ClassExpression': return fail('不能使用 class');
      case 'TryStatement': return fail('不能使用 try／catch');
      case 'ThrowStatement': return fail('不能使用 throw');
      case 'LabeledStatement': return fail('不能使用 label（標籤）');
      case 'DebuggerStatement': return fail('不能使用 debugger');
      case 'WithStatement': return fail('不能使用 with');
      case 'ForInStatement': return fail('不能使用 for…in，請改用 for…of 或 Object.keys');
      case 'TaggedTemplateExpression': return fail('不能使用 tagged template');
      case 'YieldExpression': return fail('不能使用 generator 函式');
      case 'AwaitExpression': return fail('不能使用 async 函式');
      case 'ImportExpression': case 'ImportDeclaration': case 'ExportNamedDeclaration': case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration': case 'MetaProperty': return fail('不能使用 import／export');
      case 'SwitchStatement': case 'SwitchCase': break;
      default: return fail(`不能使用這種語法（${node.type}）`);
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'type' || k === 'range') continue;
      const child = node[k];
      if (Array.isArray(child)) { for (const c of child) { const e = checkNode(c, node, k); if (e) return e; } }
      else if (child && typeof child.type === 'string') { const e = checkNode(child, node, k); if (e) return e; }
    }
    return null;
  }
  /** Identifier 是否只是屬性名（obj.name 的 name、{name: 1} 的 name），而不是讀變數。 */
  function isPropertyKey(parent, key) {
    if (!parent) return false;
    if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return true;
    if (parent.type === 'Property' && key === 'key' && !parent.computed) return true;
    return false;
  }
  function propertyName(keyNode) {
    if (keyNode.type === 'Identifier') return keyNode.name;
    if (keyNode.type === 'Literal') return String(keyNode.value);
    return null;
  }

  // ---- 作用域 ----
  class Scope {
    constructor(parent, kind) { this.parent = parent; this.vars = new Map(); this.kind = kind || 'block'; }
    declare(name, value, mutable, node) {
      if (this.vars.has(name)) throw new AnimError(`「${name}」重複宣告`, node);
      this.vars.set(name, {value, mutable});
    }
    find(name) { for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s; return null; }
  }

  // ---- 控制流程 ----
  const BREAK = {}, CONTINUE = {};
  class Return { constructor(value) { this.value = value; } }

  /** 一份編譯好的程式：模組層初始化一次並凍結，之後可重複呼叫入口函式。 */
  class Program {
    constructor(ast, globals) {
      this.ast = ast; this.steps = 0; this.limit = LIMITS.steps; this.depth = 0;
      this.frozen = new WeakSet(); this.locked = false;
      this.globalScope = new Scope(null, 'global');
      for (const [name, value] of Object.entries(globals)) this.globalScope.declare(name, value, false);
      this.module = new Scope(this.globalScope, 'module');
      this.execBody(ast.body, this.module);
      // 模組層的值凍結：入口函式不能改它們（跨格保留狀態會讓預覽與逐格輸出不同）
      for (const binding of this.module.vars.values()) this.freeze(binding.value);
      this.locked = true;
    }
    freeze(v) {
      if ((Array.isArray(v) || isDataObject(v)) && !this.frozen.has(v)) {
        this.frozen.add(v);
        for (const x of (Array.isArray(v) ? v : Object.values(v))) this.freeze(x);
      }
    }
    /** 呼叫模組層的函式；每次呼叫重新計算步數。參數先轉成直譯器的值。 */
    call(name, args, options = {}) {
      const binding = this.module.vars.get(name);
      if (!binding || !(binding.value instanceof Closure)) throw new AnimError(`找不到函式「${name}」`, {loc: {start: {line: 1, column: 0}}});
      this.steps = 0; this.limit = options.steps || LIMITS.steps; this.depth = 0;
      return this.callFunction(binding.value, (args || []).map(a => fromHost(a)), this.ast);
    }
    /** 大量運算（複製陣列、展開、產生長字串）依處理量計步：原生的 slice／concat 一次可以處理上萬個元素，
     *  只算 1 步的話，反覆呼叫就能在步數上限內吃掉大量記憶體。字串每 16 字算 1 步。 */
    charge(n, node) {
      this.steps += n;
      if (this.steps > this.limit) throw new AnimError(`運算步數超過上限（每次 ${this.limit} 步），可能有無窮迴圈或處理太多資料`, node);
    }
    tick(node) {
      if (++this.steps > this.limit) throw new AnimError(`運算步數超過上限（每次 ${this.limit} 步），可能有無窮迴圈`, node);
    }
    stateError(node, name) {
      return new AnimError(name ? `動畫不能在不同格之間保留狀態：不能改模組層的「${name}」，請在函式裡另外建立` : '動畫不能在不同格之間保留狀態：模組層的陣列與物件是唯讀的，請在函式裡另外複製一份', node);
    }

    // ---- 敘述 ----
    hoist(body, scope) {
      for (const st of body) if (st.type === 'FunctionDeclaration') scope.declare(st.id.name, new Closure(st, scope, st.id.name), true, st);
    }
    execBody(body, scope) {
      this.hoist(body, scope);
      for (const st of body) {
        if (st.type === 'FunctionDeclaration') continue;
        const r = this.execStatement(st, scope);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    execStatement(node, scope) {
      this.tick(node);
      switch (node.type) {
        case 'ExpressionStatement': this.eval(node.expression, scope); return undefined;
        case 'VariableDeclaration':
          for (const d of node.declarations) this.bind(d.id, d.init ? this.eval(d.init, scope) : undefined, scope, node.kind === 'let', true);
          return undefined;
        case 'BlockStatement': return this.execBody(node.body, new Scope(scope));
        case 'EmptyStatement': return undefined;
        case 'IfStatement':
          if (this.eval(node.test, scope)) return this.execStatement(node.consequent, scope);
          return node.alternate ? this.execStatement(node.alternate, scope) : undefined;
        case 'ReturnStatement': return new Return(node.argument ? this.eval(node.argument, scope) : undefined);
        case 'BreakStatement': return BREAK;
        case 'ContinueStatement': return CONTINUE;
        case 'WhileStatement':
          while (this.eval(node.test, scope)) {
            const r = this.execStatement(node.body, scope);
            if (r === BREAK) break; if (r === CONTINUE) continue; if (r !== undefined) return r;
          }
          return undefined;
        case 'DoWhileStatement':
          do {
            const r = this.execStatement(node.body, scope);
            if (r === BREAK) break; if (r === CONTINUE) continue; if (r !== undefined) return r;
          } while (this.eval(node.test, scope));
          return undefined;
        case 'ForStatement': {
          let loop = new Scope(scope);
          if (node.init) { if (node.init.type === 'VariableDeclaration') this.execStatement(node.init, loop); else this.eval(node.init, loop); }
          while (!node.test || this.eval(node.test, loop)) {
            const r = this.execStatement(node.body, new Scope(loop));
            if (r === BREAK) break; if (r !== undefined && r !== CONTINUE) return r;
            // 每一輪複製一份迴圈變數（JS 的 let 語意：閉包抓到的是當輪的值）
            const next = new Scope(scope); for (const [k, b] of loop.vars) next.vars.set(k, {...b}); loop = next;
            if (node.update) this.eval(node.update, loop);
          }
          return undefined;
        }
        case 'ForOfStatement': {
          const items = this.eval(node.right, scope);
          const list = typeof items === 'string' ? [...items] : items;
          if (Array.isArray(list)) this.charge(list.length, node.right);
          if (!Array.isArray(list)) throw new AnimError('for…of 只能走陣列或字串', node.right);
          for (const item of list.slice()) {
            const inner = new Scope(scope);
            if (node.left.type === 'VariableDeclaration') this.bind(node.left.declarations[0].id, item, inner, node.left.kind === 'let', true);
            else this.assignTo(node.left, item, inner);
            const r = this.execStatement(node.body, inner);
            if (r === BREAK) break; if (r !== undefined && r !== CONTINUE) return r;
          }
          return undefined;
        }
        case 'SwitchStatement': {
          const v = this.eval(node.discriminant, scope); const inner = new Scope(scope);
          let matched = false;
          for (const c of node.cases) {
            if (!matched && (c.test === null || this.eval(c.test, inner) === v)) matched = true;
            if (!matched) continue;
            for (const st of c.consequent) {
              const r = this.execStatement(st, inner);
              if (r === BREAK) return undefined; if (r !== undefined) return r;
            }
          }
          return undefined;
        }
        default: throw new AnimError(`不能使用這種語法（${node.type}）`, node);
      }
    }

    // ---- 宣告與指定（含解構） ----
    bind(pattern, value, scope, mutable, declare) {
      switch (pattern.type) {
        case 'Identifier':
          if (declare) scope.declare(pattern.name, value, mutable, pattern); else this.setVar(pattern.name, value, scope, pattern);
          return;
        case 'AssignmentPattern':
          return this.bind(pattern.left, value === undefined ? this.eval(pattern.right, scope) : value, scope, mutable, declare);
        case 'ArrayPattern': {
          if (!Array.isArray(value)) throw new AnimError('只能從陣列解構', pattern);
          pattern.elements.forEach((el, i) => {
            if (!el) return;
            if (el.type === 'RestElement') this.bind(el.argument, value.slice(i), scope, mutable, declare);
            else this.bind(el, value[i], scope, mutable, declare);
          });
          return;
        }
        case 'ObjectPattern': {
          const used = [];
          for (const p of pattern.properties) {
            if (p.type === 'RestElement') {
              const rest = newObject();
              if (isDataObject(value)) for (const k of Object.keys(value)) if (!used.includes(k)) rest[k] = value[k];
              this.bind(p.argument, rest, scope, mutable, declare);
              continue;
            }
            const key = p.computed ? toStr(this.eval(p.key, scope), p) : propertyName(p.key);
            used.push(key);
            this.bind(p.value, this.getMember(value, key, p), scope, mutable, declare);
          }
          return;
        }
        default: throw new AnimError(`不能這樣宣告（${pattern.type}）`, pattern);
      }
    }
    setVar(name, value, scope, node) {
      const found = scope.find(name);
      if (!found) throw new AnimError(`「${name}」沒有宣告`, node);
      const b = found.vars.get(name);
      if (this.locked && (found === this.module || found === this.globalScope)) throw this.stateError(node, name);
      if (!b.mutable) throw new AnimError(`「${name}」是常數，不能重新指定`, node);
      b.value = value;
    }
    assignTo(target, value, scope) {
      if (target.type === 'Identifier') return this.setVar(target.name, value, scope, target);
      if (target.type === 'MemberExpression') {
        const obj = this.eval(target.object, scope);
        const key = target.computed ? this.eval(target.property, scope) : target.property.name;
        return this.setMember(obj, key, value, target);
      }
      if (target.type === 'ArrayPattern' || target.type === 'ObjectPattern') return this.bind(target, value, scope, true, false);
      throw new AnimError('不能指定給這個目標', target);
    }

    // ---- 屬性存取（執行時的關卡） ----
    getMember(obj, key, node) {
      if (obj === null || obj === undefined) throw new AnimError(`不能讀取 ${obj} 的屬性「${String(key)}」`, node);
      if (typeof key === 'symbol') throw new AnimError('不能使用 Symbol', node);
      const name = typeof key === 'number' ? String(key) : toStr(key, node);
      if (DENIED.has(name)) throw new AnimError(`不能使用「${name}」`, node);
      if (Array.isArray(obj)) {
        if (isIndex(name)) return Number(name) < obj.length ? obj[Number(name)] : undefined;
        if (name === 'length') return obj.length;
        if (ARRAY_METHODS.has(name)) return this.arrayMethod(obj, name, node);
        throw new AnimError(`陣列沒有「${name}」`, node);
      }
      if (typeof obj === 'string') {
        if (isIndex(name)) return obj.charAt(Number(name)) || undefined;
        if (name === 'length') return obj.length;
        if (STRING_METHODS.has(name)) return this.stringMethod(obj, name, node);
        throw new AnimError(`字串沒有「${name}」`, node);
      }
      if (typeof obj === 'number') {
        if (name === 'toFixed') return new HostFunction('toFixed', d => checkString(obj.toFixed(Math.max(0, Math.min(20, toNum(d) | 0))), node));
        throw new AnimError(`數字沒有「${name}」`, node);
      }
      if (obj instanceof HostObject) {
        if (obj.members.has(name)) return obj.members.get(name);
        throw new AnimError(`「${obj.name}」沒有「${name}」`, node);
      }
      if (obj instanceof Closure || obj instanceof HostFunction) throw new AnimError(`函式沒有屬性「${name}」`, node);
      if (isDataObject(obj)) return Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : undefined;
      throw new AnimError(`不能讀取這個值的屬性「${name}」`, node);
    }
    setMember(obj, key, value, node) {
      const name = typeof key === 'number' ? String(key) : toStr(key, node);
      if (DENIED.has(name)) throw new AnimError(`不能使用「${name}」`, node);
      if (this.frozen.has(obj)) throw this.stateError(node);
      if (Array.isArray(obj)) {
        if (!isIndex(name) || Number(name) > obj.length) throw new AnimError(`陣列只能以 0～${obj.length} 的整數下標指定`, node);
        checkArray(Number(name) + 1, node);
        obj[Number(name)] = value; return;
      }
      if (isDataObject(obj)) {
        if (!Object.prototype.hasOwnProperty.call(obj, name)) checkArray(Object.keys(obj).length + 1, node);
        obj[name] = value; return;
      }
      throw new AnimError(`不能設定這個值的屬性「${name}」`, node);
    }
    /** 陣列方法：全部自己實作（不交出原生方法）；會改陣列的方法先檢查凍結。 */
    arrayMethod(arr, name, node) {
      const fn = (f, ...a) => this.callValue(f, a, node);
      const mutate = () => { if (this.frozen.has(arr)) throw this.stateError(node); };
      const impl = {
        push: (...xs) => { mutate(); checkArray(arr.length + xs.length, node); this.charge(xs.length, node); for (const x of xs) arr[arr.length] = x; return arr.length; },
        pop: () => { mutate(); return arr.length ? arr.splice(arr.length - 1, 1)[0] : undefined; },
        slice: (s, e) => { const out = Array.prototype.slice.call(arr, s === undefined ? 0 : toNum(s), e === undefined ? undefined : toNum(e)); this.charge(out.length, node); return out; },
        map: f => { const out = []; for (let i = 0; i < arr.length; i++) { this.tick(node); out[i] = fn(f, arr[i], i); } return out; },
        filter: f => { const out = []; for (let i = 0; i < arr.length; i++) { this.tick(node); if (fn(f, arr[i], i)) out[out.length] = arr[i]; } return out; },
        forEach: f => { for (let i = 0; i < arr.length; i++) { this.tick(node); fn(f, arr[i], i); } return undefined; },
        reduce: (f, ...init) => {
          let i = 0, acc;
          if (init.length) acc = init[0]; else { if (!arr.length) throw new AnimError('空陣列的 reduce 要給初始值', node); acc = arr[0]; i = 1; }
          for (; i < arr.length; i++) { this.tick(node); acc = fn(f, acc, arr[i], i); }
          return acc;
        },
        some: f => { for (let i = 0; i < arr.length; i++) { this.tick(node); if (fn(f, arr[i], i)) return true; } return false; },
        every: f => { for (let i = 0; i < arr.length; i++) { this.tick(node); if (!fn(f, arr[i], i)) return false; } return true; },
        find: f => { for (let i = 0; i < arr.length; i++) { this.tick(node); if (fn(f, arr[i], i)) return arr[i]; } return undefined; },
        findIndex: f => { for (let i = 0; i < arr.length; i++) { this.tick(node); if (fn(f, arr[i], i)) return i; } return -1; },
        indexOf: x => { this.charge(arr.length, node); for (let i = 0; i < arr.length; i++) if (arr[i] === x) return i; return -1; },
        includes: x => { this.charge(arr.length, node); for (let i = 0; i < arr.length; i++) if (arr[i] === x || (x !== x && arr[i] !== arr[i])) return true; return false; },
        join: sep => { this.charge(arr.length, node); const seen = new Set([arr]); const out = checkString(arr.map(x => (x === null || x === undefined ? '' : toStr(x, node, seen))).join(sep === undefined ? ',' : toStr(sep, node)), node); this.charge(out.length >> 4, node); return out; },
        concat: (...xs) => { let n = arr.length; for (const x of xs) n += Array.isArray(x) ? x.length : 1; checkArray(n, node); this.charge(n, node); const out = arr.slice(); for (const x of xs) { if (Array.isArray(x)) for (const y of x) out[out.length] = y; else out[out.length] = x; } return out; },
        reverse: () => { mutate(); this.charge(arr.length, node); arr.reverse(); return arr; },
        sort: f => { mutate(); const sorted = this.stableSort(arr, f, node); for (let i = 0; i < sorted.length; i++) arr[i] = sorted[i]; return arr; },
        fill: (v, s, e) => { mutate(); this.charge(arr.length, node); const n = arr.length, a = s === undefined ? 0 : toNum(s) | 0, b = e === undefined ? n : toNum(e) | 0; for (let i = Math.max(0, a); i < Math.min(n, b); i++) arr[i] = v; return arr; },
      };
      return new HostFunction(name, impl[name]);
    }
    /** 穩定排序（合併排序）：比較函式相等時保持原順序；沒給比較函式時照字串比。 */
    stableSort(arr, f, node) {
      const cmp = f === undefined ? (x, y) => { const a = toStr(x, node), b = toStr(y, node); return a < b ? -1 : a > b ? 1 : 0; }
        : (x, y) => toNum(this.callValue(f, [x, y], node));
      const merge = list => {
        if (list.length < 2) return list;
        const mid = list.length >> 1, l = merge(list.slice(0, mid)), r = merge(list.slice(mid)), out = [];
        let i = 0, j = 0;
        while (i < l.length && j < r.length) { this.tick(node); out.push(cmp(r[j], l[i]) < 0 ? r[j++] : l[i++]); }
        return out.concat(l.slice(i), r.slice(j));
      };
      return merge(arr.slice());
    }
    /** 字串方法：全部自己包一層，結果受字串上限。 */
    stringMethod(s, name, node) {
      const impl = {
        slice: (a, b) => s.slice(a === undefined ? 0 : toNum(a), b === undefined ? undefined : toNum(b)),
        substring: (a, b) => s.substring(toNum(a), b === undefined ? undefined : toNum(b)),
        charAt: i => s.charAt(toNum(i)),
        split: sep => { if (sep !== undefined && typeof sep !== 'string') throw new AnimError('split 只收字串分隔', node); this.charge(s.length, node); const out = sep === undefined ? [s] : s.split(sep); checkArray(out.length, node); return out; },
        toUpperCase: () => s.toUpperCase(),
        toLowerCase: () => s.toLowerCase(),
        trim: () => s.trim(),
        padStart: (n, p) => checkString(s.padStart(Math.min(toNum(n), LIMITS.string + 1), p === undefined ? ' ' : toStr(p, node)), node),
        padEnd: (n, p) => checkString(s.padEnd(Math.min(toNum(n), LIMITS.string + 1), p === undefined ? ' ' : toStr(p, node)), node),
        repeat: n => { const k = Math.max(0, toNum(n) | 0); if (s.length * k > LIMITS.string) throw new AnimError(`字串長度超過上限（${LIMITS.string} 字）`, node); this.charge((s.length * k) >> 4, node); return s.repeat(k); },
        includes: x => s.includes(toStr(x, node)),
        indexOf: x => s.indexOf(toStr(x, node)),
        startsWith: x => s.startsWith(toStr(x, node)),
        endsWith: x => s.endsWith(toStr(x, node)),
      };
      return new HostFunction(name, impl[name]);
    }

    // ---- 函式呼叫 ----
    callValue(f, args, node) {
      if (f instanceof Closure) return this.callFunction(f, args, node);
      if (f instanceof HostFunction) {
        try { return f.fn(...args); }
        catch (e) {
          if (e && e.name === 'AnimError') { if (e.line == null && node && node.loc) { e.line = node.loc.start.line; e.column = node.loc.start.column + 1; } throw e; }
          throw new AnimError(`「${f.name}」執行失敗：${e && e.message ? e.message : e}`, node);
        }
      }
      throw new AnimError('這個值不是函式', node);
    }
    callFunction(fn, args, node) {
      if (++this.depth > LIMITS.depth) throw new AnimError(`呼叫深度超過上限（${LIMITS.depth} 層），可能有無限遞迴`, node);
      try {
        const f = fn.node, scope = new Scope(fn.scope, 'function');
        f.params.forEach((p, i) => {
          if (p.type === 'RestElement') this.bind(p.argument, args.slice(i), scope, true, true);
          else this.bind(p, args[i], scope, true, true);
        });
        if (f.type === 'ArrowFunctionExpression' && f.expression) return this.eval(f.body, scope);
        const r = this.execBody(f.body.body, scope);
        return r instanceof Return ? r.value : undefined;
      } finally { this.depth--; }
    }

    // ---- 運算式 ----
    eval(node, scope) {
      this.tick(node);
      switch (node.type) {
        case 'Literal': return node.value;
        case 'Identifier': {
          if (node.name === 'undefined') return undefined;
          const s = scope.find(node.name);
          if (!s) throw new AnimError(`「${node.name}」沒有定義`, node);
          return s.vars.get(node.name).value;
        }
        case 'TemplateLiteral': {
          let out = '';
          node.quasis.forEach((q, i) => { out += q.value.cooked; if (i < node.expressions.length) out += toStr(this.eval(node.expressions[i], scope), node); checkString(out, node); });
          return out;
        }
        case 'ArrayExpression': {
          const out = [];
          for (const el of node.elements) {
            if (el === null) out[out.length] = undefined;
            else if (el.type === 'SpreadElement') { const v = this.eval(el.argument, scope); const list = typeof v === 'string' ? [...v] : v; if (!Array.isArray(list)) throw new AnimError('只能展開陣列或字串', el); checkArray(out.length + list.length, node); this.charge(list.length, el); for (const x of list) out[out.length] = x; }
            else out[out.length] = this.eval(el, scope);
            checkArray(out.length, node);
          }
          return out;
        }
        case 'ObjectExpression': {
          const o = newObject();
          for (const p of node.properties) {
            if (p.type === 'SpreadElement') { const v = this.eval(p.argument, scope); if (isDataObject(v)) for (const k of Object.keys(v)) o[k] = v[k]; continue; }
            const key = p.computed ? toStr(this.eval(p.key, scope), p) : propertyName(p.key);
            if (DENIED.has(key)) throw new AnimError(`不能使用「${key}」`, p);
            o[key] = p.method ? new Closure(p.value, scope, key) : this.eval(p.value, scope);
          }
          checkArray(Object.keys(o).length, node);
          return o;
        }
        case 'FunctionExpression': case 'ArrowFunctionExpression': return new Closure(node, scope, node.id ? node.id.name : null);
        case 'UnaryExpression': {
          if (node.operator === 'typeof') {
            if (node.argument.type === 'Identifier' && !scope.find(node.argument.name)) return 'undefined';
            return typeOf(this.eval(node.argument, scope));
          }
          const v = this.eval(node.argument, scope);
          switch (node.operator) { case '-': return -toNum(v); case '+': return toNum(v); case '!': return !v; case '~': return ~toNum(v); }
          throw new AnimError(`不能使用 ${node.operator} 運算子`, node);
        }
        case 'BinaryExpression': return this.binary(node.operator, this.eval(node.left, scope), this.eval(node.right, scope), node);
        case 'LogicalExpression': {
          const l = this.eval(node.left, scope);
          if (node.operator === '&&') return l ? this.eval(node.right, scope) : l;
          if (node.operator === '||') return l ? l : this.eval(node.right, scope);
          return l === null || l === undefined ? this.eval(node.right, scope) : l;
        }
        case 'ConditionalExpression': return this.eval(node.test, scope) ? this.eval(node.consequent, scope) : this.eval(node.alternate, scope);
        case 'SequenceExpression': { let v; for (const e of node.expressions) v = this.eval(e, scope); return v; }
        case 'AssignmentExpression': return this.assignment(node, scope);
        case 'UpdateExpression': {
          const old = toNum(this.readTarget(node.argument, scope));
          const next = node.operator === '++' ? old + 1 : old - 1;
          this.assignTo(node.argument, next, scope);
          return node.prefix ? next : old;
        }
        case 'MemberExpression': return this.member(node, scope).value;
        case 'ChainExpression': return this.chain(node.expression, scope).value;
        case 'CallExpression': return this.evalCall(node, scope).value;
        default: throw new AnimError(`不能使用這種語法（${node.type}）`, node);
      }
    }
    readTarget(target, scope) {
      if (target.type === 'Identifier' || target.type === 'MemberExpression') return this.eval(target, scope);
      throw new AnimError('不能指定給這個目標', target);
    }
    assignment(node, scope) {
      const op = node.operator;
      if (op === '=') { const v = this.eval(node.right, scope); this.assignTo(node.left, v, scope); return v; }
      const cur = this.readTarget(node.left, scope);
      if (op === '&&=') { if (!cur) return cur; const v = this.eval(node.right, scope); this.assignTo(node.left, v, scope); return v; }
      if (op === '||=') { if (cur) return cur; const v = this.eval(node.right, scope); this.assignTo(node.left, v, scope); return v; }
      if (op === '??=') { if (cur !== null && cur !== undefined) return cur; const v = this.eval(node.right, scope); this.assignTo(node.left, v, scope); return v; }
      const v = this.binary(op.slice(0, -1), cur, this.eval(node.right, scope), node);
      this.assignTo(node.left, v, scope);
      return v;
    }
    binary(op, a, b, node) {
      switch (op) {
        case '+':
          if (typeof a === 'number' && typeof b === 'number') return a + b;
          if (typeof a === 'string' || typeof b === 'string' || (a !== null && typeof a === 'object') || (b !== null && typeof b === 'object')) { const out = checkString(toStr(a, node) + toStr(b, node), node); this.charge(out.length >> 4, node); return out; }
          return toNum(a) + toNum(b);
        case '-': return toNum(a) - toNum(b);
        case '*': return toNum(a) * toNum(b);
        case '/': return toNum(a) / toNum(b);
        case '%': return toNum(a) % toNum(b);
        case '**': return toNum(a) ** toNum(b);
        case '===': return a === b;
        case '!==': return a !== b;
        case '==': return looseEqual(a, b);
        case '!=': return !looseEqual(a, b);
        case '<': return typeof a === 'string' && typeof b === 'string' ? a < b : toNum(a) < toNum(b);
        case '<=': return typeof a === 'string' && typeof b === 'string' ? a <= b : toNum(a) <= toNum(b);
        case '>': return typeof a === 'string' && typeof b === 'string' ? a > b : toNum(a) > toNum(b);
        case '>=': return typeof a === 'string' && typeof b === 'string' ? a >= b : toNum(a) >= toNum(b);
        case '&': return toNum(a) & toNum(b);
        case '|': return toNum(a) | toNum(b);
        case '^': return toNum(a) ^ toNum(b);
        case '<<': return toNum(a) << toNum(b);
        case '>>': return toNum(a) >> toNum(b);
        case '>>>': return toNum(a) >>> toNum(b);
      }
      throw new AnimError(`不能使用 ${op} 運算子`, node);
    }
    /** 讀成員；回 {value, short}，short 表示可選串連在這裡短路（值是 null／undefined）。 */
    member(node, scope) {
      const base = node.object.type === 'MemberExpression' || node.object.type === 'CallExpression' ? this.chainPart(node.object, scope) : {value: this.eval(node.object, scope), short: false};
      if (base.short) return base;
      if (node.optional && (base.value === null || base.value === undefined)) return {value: undefined, short: true};
      const key = node.computed ? this.eval(node.property, scope) : node.property.name;
      return {value: this.getMember(base.value, key, node), short: false};
    }
    /** 函式呼叫運算式（與對外的 call(name, args) 分開命名，免得互相蓋掉）。 */
    evalCall(node, scope) {
      let callee;
      if (node.callee.type === 'MemberExpression' || node.callee.type === 'CallExpression') {
        callee = this.chainPart(node.callee, scope);
        if (callee.short) return callee;
      } else callee = {value: this.eval(node.callee, scope), short: false};
      if (node.optional && (callee.value === null || callee.value === undefined)) return {value: undefined, short: true};
      const args = [];
      for (const a of node.arguments) {
        if (a.type === 'SpreadElement') { const v = this.eval(a.argument, scope); if (!Array.isArray(v)) throw new AnimError('只能展開陣列', a); this.charge(v.length, a); for (const x of v) args.push(x); }
        else args.push(this.eval(a, scope));
      }
      if (!(callee.value instanceof Closure) && !(callee.value instanceof HostFunction)) throw new AnimError(`「${calleeName(node.callee)}」不是函式`, node);
      return {value: this.callValue(callee.value, args, node), short: false};
    }
    chainPart(node, scope) {
      if (node.type === 'MemberExpression') { this.tick(node); return this.member(node, scope); }
      if (node.type === 'CallExpression') { this.tick(node); return this.evalCall(node, scope); }
      return {value: this.eval(node, scope), short: false};
    }
    chain(node, scope) {
      const r = this.chainPart(node, scope);
      return r.short ? {value: undefined} : r;
    }
  }
  /** 呼叫目標的名稱（錯誤訊息用）。 */
  function calleeName(node) {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression' && !node.computed) return calleeName(node.object) + '.' + node.property.name;
    if (node.type === 'MemberExpression' && node.property.type === 'Literal') return calleeName(node.object) + '[' + JSON.stringify(node.property.value) + ']';
    return '這個值';
  }
  function isIndex(name) { return /^(0|[1-9][0-9]{0,8})$/.test(name); }
  function looseEqual(a, b) {
    if (a === b) return true;
    if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
    if (typeof a === 'number' && typeof b === 'string') return a === Number(b);
    if (typeof a === 'string' && typeof b === 'number') return Number(a) === b;
    if (typeof a === 'boolean' || typeof b === 'boolean') return toNum(a) === toNum(b);
    return false;
  }

  // ---- 內建全域 ----
  /** 緩動函式（0～1 → 0～1）。 */
  const EASE = {
    linear: u => u, inQuad: u => u * u, outQuad: u => 1 - (1 - u) * (1 - u),
    inOutQuad: u => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2),
    inCubic: u => u * u * u, outCubic: u => 1 - Math.pow(1 - u, 3),
    inOutCubic: u => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
    outBack: u => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); },
    outElastic: u => (u === 0 ? 0 : u === 1 ? 1 : Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * (2 * Math.PI) / 3) + 1),
    outBounce: u => { const n1 = 7.5625, d1 = 2.75;
      if (u < 1 / d1) return n1 * u * u; if (u < 2 / d1) return n1 * (u -= 1.5 / d1) * u + 0.75;
      if (u < 2.5 / d1) return n1 * (u -= 2.25 / d1) * u + 0.9375; return n1 * (u -= 2.625 / d1) * u + 0.984375; },
  };
  function makeGlobals(extra) {
    const math = {};
    for (const k of MATH_MEMBERS) math[k] = typeof Math[k] === 'function' ? new HostFunction('Math.' + k, (...a) => Math[k](...a.map(toNum))) : Math[k];
    const ease = {};
    for (const [k, f] of Object.entries(EASE)) ease[k] = new HostFunction('ease.' + k, u => f(Math.min(1, Math.max(0, toNum(u)))));
    const keysOf = o => (isDataObject(o) ? Object.keys(o) : Array.isArray(o) ? o.map((_, i) => String(i)) : []);
    return Object.assign({
      Math: new HostObject('Math', math),
      ease: new HostObject('ease', ease),
      String: new HostFunction('String', v => toStr(v)),
      Number: new HostFunction('Number', v => toNum(v)),
      Boolean: new HostFunction('Boolean', v => !!v),
      parseInt: new HostFunction('parseInt', (v, r) => parseInt(toStr(v), r === undefined ? 10 : toNum(r))),
      parseFloat: new HostFunction('parseFloat', v => parseFloat(toStr(v))),
      isFinite: new HostFunction('isFinite', v => isFinite(toNum(v))),
      isNaN: new HostFunction('isNaN', v => isNaN(toNum(v))),
      lerp: new HostFunction('lerp', (a, b, u) => toNum(a) + (toNum(b) - toNum(a)) * toNum(u)),
      clamp: new HostFunction('clamp', (x, lo, hi) => Math.min(toNum(hi), Math.max(toNum(lo), toNum(x)))),
      Object: new HostObject('Object', {
        keys: new HostFunction('Object.keys', o => keysOf(o)),
        values: new HostFunction('Object.values', o => keysOf(o).map(k => (Array.isArray(o) ? o[Number(k)] : o[k]))),
        entries: new HostFunction('Object.entries', o => keysOf(o).map(k => [k, Array.isArray(o) ? o[Number(k)] : o[k]])),
      }),
      Array: new HostObject('Array', {
        isArray: new HostFunction('Array.isArray', v => Array.isArray(v)),
      }),
      Infinity, NaN,
    }, extra || {});
  }

  /** 編譯：解析、白名單檢查、初始化模組層並凍結；entry 是入口函式名稱（draw、sound…），必須是模組層的函式。
   *  globals 可再加執行環境要給的全域（例如 rand）。回傳可重複呼叫的 Program。 */
  function compile(code, {entry, globals} = {}) {
    if (typeof code !== 'string') throw new AnimError('程式碼必須是字串', {loc: {start: {line: 1, column: 0}}});
    if (code.length > LIMITS.code) throw new AnimError(`程式碼太長（上限 ${LIMITS.code} 字）`, {loc: {start: {line: 1, column: 0}}});
    let ast;
    try {
      ast = acorn.parse(code, {ecmaVersion: 2022, sourceType: 'script', locations: true, allowHashBang: false, allowReserved: false});
    } catch (e) {
      const loc = e && e.loc ? {loc: {start: {line: e.loc.line, column: e.loc.column}}} : {loc: {start: {line: 1, column: 0}}};
      throw new AnimError('語法錯誤：' + String(e && e.message || e).replace(/\s*\(\d+:\d+\)$/, ''), loc);
    }
    const error = checkNode(ast, null, null);
    if (error) throw error;
    const program = new Program(ast, makeGlobals(globals));
    if (entry && !(program.module.vars.get(entry) && program.module.vars.get(entry).value instanceof Closure)) {
      throw new AnimError(`找不到入口函式「${entry}」：元件要在最外層定義 function ${entry}(…)`, {loc: {start: {line: 1, column: 0}}});
    }
    return program;
  }

  return {
    compile, toPlain, LIMITS, AnimError, EASE, makeGlobals,
    /** 宿主物件的成員名稱（API 清單與測試用）。 */
    members: o => (o instanceof HostObject ? [...o.members.keys()] : Object.keys(o || {})),
    /** 建立宿主物件（只認給定的成員）。 */
    hostObject: (name, members) => new HostObject(name, members),
    /** 建立宿主函式。 */
    hostFunction: (name, fn) => new HostFunction(name, fn),
    /** 是否為直譯器的資料物件（宿主函式檢查參數用）。 */
    isDataObject,
    /** 是否為禁用名稱（元件參數名稱這類外來的鍵用：入口參數轉換時會略過禁用的鍵，參數表先擋下才不會安靜消失）。 */
    isDeniedName: name => DENIED.has(name),
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AnimVM;
