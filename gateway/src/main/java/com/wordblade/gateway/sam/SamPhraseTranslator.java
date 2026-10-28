package com.wordblade.gateway.sam;

/** 任何語言的遮罩目標 → SAM 看得懂的英文名詞片語（不是畫面上看得到的東西回空字串）；測試換成假的 */
@FunctionalInterface
public interface SamPhraseTranslator {
    String translate(long tokenId, String text);
}
