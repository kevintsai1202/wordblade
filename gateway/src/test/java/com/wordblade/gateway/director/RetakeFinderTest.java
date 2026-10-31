package com.wordblade.gateway.director;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 重講候選（docs/plan-10-31-director4.md）：本機把詞分成語句，60 秒內字面相近的後續語句列為候選（剪的範圍＝前一句開頭到重講開頭）；
 * 不呼叫模型，同樣的逐字稿每次結果一樣。
 */
class RetakeFinderTest {

    /** 中文逐字：每字 0.25 秒 */
    static List<DirectorJobs.Word> zh(double start, String text, String prefix) {
        List<DirectorJobs.Word> out = new ArrayList<>();
        int i = 0;
        for (int cp : text.codePoints().toArray()) out.add(new DirectorJobs.Word(prefix + i, start + (i++) * 0.25, new String(Character.toChars(cp))));
        return out;
    }

    /** OBS 中文錄影：19 秒講一半、23.5 秒第一次開場、66 秒重錄、80 秒往下講新內容 */
    static List<DirectorJobs.Word> lecture() {
        List<DirectorJobs.Word> w = new ArrayList<>();
        w.addAll(zh(19, "好我們接下來這個章節", "a"));
        w.addAll(zh(23.5, "我們接下來這個章節主要介紹框架它是很核心的功能。", "b"));
        w.addAll(zh(40, "那以前為什麼會叫做這個名字我們後面會講。", "d"));
        w.addAll(zh(66, "好我們接下來這個章節會介紹一個很核心的套件叫做框架。", "c"));
        w.addAll(zh(80, "首先打開專案的資料夾看看裡面的結構。", "e"));
        return w;
    }

    @Test
    void 中文錄影_講一半的開場與整段重錄都列為候選_往下講的新內容不是() {
        List<RetakeFinder.Candidate> c = RetakeFinder.find(lecture());
        assertThat(c).anySatisfy(x -> {
            assertThat(x.start()).isEqualTo(19.0);
            assertThat(x.end()).isEqualTo(23.5);
        });
        assertThat(c).anySatisfy(x -> {
            assertThat(x.start()).isEqualTo(23.5);
            assertThat(x.end()).isEqualTo(66.0);
            assertThat(x.earlier()).contains("主要介紹").contains("後面會講");
            assertThat(x.later()).startsWith("好我們接下來這個章節會介紹");
        });
        assertThat(c).noneMatch(x -> x.end() == 80.0);
        assertThat(c).extracting(RetakeFinder.Candidate::id).doesNotHaveDuplicates().allMatch(id -> id.startsWith("r"));
    }

    @Test
    void 英文逐詞_空白分詞_沒有相近的句子就沒有候選() {
        List<DirectorJobs.Word> w = new ArrayList<>();
        double t = 0;
        int i = 0;
        for (String s : "First create a folder. Then install two packages. Now open the editor.".split(" ")) {
            w.add(new DirectorJobs.Word("w" + (i++), t, s));
            t += 0.4;
        }
        assertThat(RetakeFinder.find(w)).isEmpty();
    }

    @Test
    void 不完整的句子不看字面相似_和後面三句內配成候選() {
        List<DirectorJobs.Word> w = new ArrayList<>(zh(10, "那其實", "a"));
        w.addAll(zh(14, "我們要", "b"));
        w.addAll(zh(18, "好這個章節會介紹一個核心的套件。", "c"));
        w.addAll(zh(30, "首先打開資料夾。", "d"));
        assertThat(RetakeFinder.find(w)).isEmpty();
        List<RetakeFinder.Utterance> us = RetakeFinder.utterances(w);
        assertThat(us).hasSize(4);
        // 第 0、1 句不完整
        List<RetakeFinder.Candidate> c = RetakeFinder.find(w, java.util.Set.of(0, 1));
        assertThat(c).anySatisfy(x -> {
            assertThat(x.start()).isEqualTo(10.0);
            assertThat(x.end()).isEqualTo(14.0);
        }).anySatisfy(x -> {
            assertThat(x.start()).isEqualTo(14.0);
            assertThat(x.end()).isEqualTo(18.0);
        });
        assertThat(c).noneMatch(x -> x.start() == 18.0);
    }
}
