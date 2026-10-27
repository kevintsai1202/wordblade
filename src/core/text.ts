// 文字分詞（spec §5.2、§4）：ASR 的詞級時間與改字即剪共用同一套規則。

/** 中日韓文字（逐字成詞） */
export const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** 標點（黏到前一個詞） */
const PUNCT = /^[\p{P}\p{S}]+$/u;

/** 文字切成詞：英文以空白分，標點黏前一個詞（開頭的標點黏後一個）；中日韓逐字 */
export function tokenize(text: string): string[] {
  // 先拆出單字：中日韓字元各自一個，其他連續的非空白字元一個
  const pieces = text.match(new RegExp(`${CJK.source}|[^\\s${CJK.source.slice(1, -1)}]+`, "gu")) ?? [];
  const out: string[] = [];
  let lead = "";
  for (const p of pieces) {
    if (PUNCT.test(p)) {
      if (out.length) out[out.length - 1] += p;
      else lead += p;
      continue;
    }
    out.push(lead + p);
    lead = "";
  }
  if (lead && out.length) out[out.length - 1] += lead;
  return out;
}

