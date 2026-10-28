// JSON Schema 的小子集（D27）：只支援宣告式音訊 schema 用到的關鍵字——type、properties、required、items、minItems／maxItems、
// minimum／maximum、enum、pattern、anyOf、$ref（只有 #/$defs/…）。和閘道的 SchemaLite.java 同一套規則：
// 物件的多餘欄位直接丟掉（不算錯，模型常多回 explanation 之類的欄位），其他不合就回中文錯誤（帶路徑，閘道拿去回饋給模型）。

/** schema 節點（只列用得到的關鍵字） */
export interface JsonSchema {
  type?: "object" | "array" | "number" | "integer" | "string" | "boolean";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  pattern?: string;
  anyOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: string;
  [key: string]: unknown;
}

/** 檢查結果：value 是清理過的複本（丟掉多餘欄位）；errors 空＝合格 */
export interface SchemaCheck {
  value: unknown;
  errors: string[];
}

/** 解析 #/$defs/name 這種參照 */
function resolve(root: JsonSchema, ref: string): JsonSchema {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  const target = m ? root.$defs?.[m[1]] : undefined;
  if (!target) throw new Error(`schema 參照找不到：${ref}`);
  return target;
}

/** 有限的數字（NaN、Infinity 不算） */
function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 普通物件（不是陣列、不是 null） */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * anyOf 挑錯誤訊息用：值的形狀和這個分支對不對得上（型別相同；物件分支有 type 列舉時，值的 type 也要在列舉裡）。
 * 例如曲線寫成陣列但點超出範圍，要回陣列分支的錯，而不是「要是數字」。
 */
function sameShape(root: JsonSchema, schema: JsonSchema, value: unknown): boolean {
  const s = schema.$ref ? resolve(root, schema.$ref) : schema;
  switch (s.type) {
    case "number":
    case "integer":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object": {
      if (!isObject(value)) return false;
      const tag = s.properties?.type?.enum;
      return !tag || tag.includes(value.type);
    }
    default:
      return true;
  }
}

/** 路徑的顯示文字（根節點顯示「回應」） */
function label(path: string): string {
  return path || "回應";
}

/** 檢查一個節點；path 是目前的路徑（例如 voices[0].env） */
function check(root: JsonSchema, schema: JsonSchema, value: unknown, path: string): SchemaCheck {
  if (schema.$ref) return check(root, resolve(root, schema.$ref), value, path);
  if (schema.anyOf) {
    // 任一分支通過就用它；都不過就回「形狀對得上」的分支裡錯得最少的（通常是模型想寫的那一種）
    let best: { r: SchemaCheck; shape: boolean } | null = null;
    for (const branch of schema.anyOf) {
      const r = check(root, branch, value, path);
      if (r.errors.length === 0) return r;
      const shape = sameShape(root, branch, value);
      if (!best || (shape && !best.shape) || (shape === best.shape && r.errors.length < best.r.errors.length)) best = { r, shape };
    }
    return best!.r;
  }
  const errors: string[] = [];
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    return { value, errors: [`${label(path)} 只能是 ${schema.enum.map(String).join("、")}`] };
  }
  switch (schema.type) {
    case "number":
    case "integer": {
      if (!isNumber(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        return { value, errors: [`${label(path)} 要是${schema.type === "integer" ? "整數" : "數字"}`] };
      }
      const lo = schema.minimum ?? -Infinity;
      const hi = schema.maximum ?? Infinity;
      if (value < lo || value > hi) errors.push(`${label(path)} 要在 ${lo}～${hi} 之間`);
      return { value, errors };
    }
    case "string":
      if (typeof value !== "string") return { value, errors: [`${label(path)} 要是字串`] };
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${label(path)} 格式不對（${schema.pattern}）`);
      return { value, errors };
    case "boolean":
      return typeof value === "boolean" ? { value, errors } : { value, errors: [`${label(path)} 要是 true 或 false`] };
    case "array": {
      if (!Array.isArray(value)) return { value, errors: [`${label(path)} 要是陣列`] };
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${label(path)} 至少要 ${schema.minItems} 個`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${label(path)} 最多 ${schema.maxItems} 個`);
      const out = value.map((item, i) => {
        if (!schema.items) return item;
        const r = check(root, schema.items, item, `${path}[${i}]`);
        errors.push(...r.errors);
        return r.value;
      });
      return { value: out, errors };
    }
    case "object": {
      if (!isObject(value)) return { value, errors: [`${label(path)} 要是物件`] };
      const src = value;
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) if (!(key in src)) errors.push(`${label(path)} 缺少 ${key}`);
      // 只留 schema 列出的欄位（多餘欄位丟掉）
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (!(key in src)) continue;
        const r = check(root, sub, src[key], path ? `${path}.${key}` : key);
        errors.push(...r.errors);
        out[key] = r.value;
      }
      return { value: out, errors };
    }
    default:
      return { value, errors };
  }
}

/**
 * 依 schema 檢查 value。ref 是入口（例如 "#/$defs/sound"）；回傳清理過的複本與錯誤清單（最多 30 則，夠回饋就好）。
 */
export function checkSchema(root: JsonSchema, ref: string, value: unknown): SchemaCheck {
  const r = check(root, { $ref: ref }, value, "");
  return { value: r.value, errors: r.errors.slice(0, 30) };
}
