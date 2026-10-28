package com.wordblade.gateway.sam;

import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 送給 SAM 3.1 的名詞片語（spec §5.3；照原專案 face_track._valid_phrase）：英數開頭、2～40 字元、只有英數空白撇號連字號、1～6 個字，
 * 而且不能全是冠詞介系詞。SAM 看不懂中文（原專案實測「人臉」0 次偵測、human face 226 次），不合格的要先翻譯。
 */
public final class SamPhrase {

    private static final Pattern FORM = Pattern.compile("[A-Za-z0-9][A-Za-z0-9 '\\-]{1,39}");
    private static final Set<String> STOPWORDS = Set.of("a", "an", "the", "of", "and", "or", "to", "in", "on", "at", "with", "for", "by", "from", "this", "that");

    private SamPhrase() {}

    /** 是不是可以直接送給 SAM 的英文名詞片語 */
    public static boolean valid(String text) {
        if (text == null || !FORM.matcher(text).matches()) return false;
        String[] words = text.trim().split("\\s+");
        if (words.length < 1 || words.length > 6) return false;
        return !Arrays.stream(words).allMatch(w -> STOPWORDS.contains(w.toLowerCase(Locale.ROOT)));
    }
}
