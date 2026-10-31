package com.wordblade.gateway.director;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 重講候選（docs/plan-10-31-director4.md）：不靠模型、同樣的逐字稿每次結果一樣。
 * 1. 詞依停頓（≥ 0.8 秒）或句尾標點分成語句。
 * 2. 每一句和它結束後 60 秒內開始的語句比對開頭：字面相近（兩字組 Jaccard ≥ 0.25，寬鬆，寧可多抓讓 Jev 篩）就列為候選，
 *    剪的範圍＝前一句開頭到後一句開頭（中間講到一半放棄的、空檔一起剪）。
 * 候選再交給 Jev 判斷是不是真的重講（RetakeJudge），確認過的送給規劃者。
 */
public final class RetakeFinder {

    /**
     * 一個候選。
     *
     * @param start   剪的開始（前一句開頭）
     * @param end     剪的結束（重講開頭）
     * @param earlier 剪掉的那段話
     * @param later   重講的那一句（加下一句，讓判斷看得出講完沒有）
     */
    public record Candidate(String id, double start, double end, String earlier, String later, double similarity) {}

    /** 語句：開始時間、詞 */
    private record Utterance(double start, double end, List<DirectorJobs.Word> words) {}

    /** 兩個詞相隔幾秒以上算換一句 */
    static final double PAUSE = 0.8;
    /** 重講要在前一句結束後幾秒內開始 */
    static final double WINDOW = DirectorRules.RESTART_WINDOW;
    /** 候選的相似度門檻（寬鬆） */
    static final double MIN_SIMILARITY = 0.25;
    /** 最多幾個候選（Jev 每個約 0.2 秒、500 tokens） */
    static final int MAX = 20;

    private RetakeFinder() {}

    /** 找候選（詞依時間排序；中文一字一詞、英文一詞一詞都可以） */
    public static List<Candidate> find(List<DirectorJobs.Word> words) {
        List<Utterance> us = utterances(words);
        List<Candidate> out = new ArrayList<>();
        for (int i = 0; i < us.size(); i++) {
            Utterance a = us.get(i);
            for (int j = i + 1; j < us.size(); j++) {
                Utterance b = us.get(j);
                if (b.start() - a.end() > WINDOW) break;
                if (b.start() - a.start() > DirectorRules.RETAKE_MAX) break;
                int k = Math.min(DirectorRules.RETAKE_WORDS, Math.max(a.words().size(), 1));
                double sim = DirectorRules.similarity(a.words(), b.words().subList(0, Math.min(k, b.words().size())));
                if (sim < MIN_SIMILARITY) continue;
                List<DirectorJobs.Word> cut = words.stream().filter(w -> w.t() >= a.start() && w.t() < b.start()).toList();
                List<DirectorJobs.Word> later = new ArrayList<>(b.words());
                if (j + 1 < us.size()) later.addAll(us.get(j + 1).words());
                out.add(new Candidate("", a.start(), b.start(), text(cut), text(later), sim));
            }
        }
        // 相似度高的優先，最多 MAX 個，再依時間排、編號
        List<Candidate> top = out.stream().sorted(Comparator.comparingDouble(Candidate::similarity).reversed()).limit(MAX)
                .sorted(Comparator.comparingDouble(Candidate::start).thenComparingDouble(Candidate::end)).toList();
        List<Candidate> numbered = new ArrayList<>();
        for (int i = 0; i < top.size(); i++) {
            Candidate c = top.get(i);
            numbered.add(new Candidate("r" + (i + 1), c.start(), c.end(), c.earlier(), c.later(), Math.round(c.similarity() * 100) / 100.0));
        }
        return numbered;
    }

    /** 詞分成語句：停頓 ≥ 0.8 秒或句尾標點（含全形）換句 */
    private static List<Utterance> utterances(List<DirectorJobs.Word> words) {
        List<DirectorJobs.Word> sorted = words.stream().sorted(Comparator.comparingDouble(DirectorJobs.Word::t)).toList();
        List<Utterance> out = new ArrayList<>();
        List<DirectorJobs.Word> cur = new ArrayList<>();
        for (int i = 0; i < sorted.size(); i++) {
            DirectorJobs.Word w = sorted.get(i);
            if (!cur.isEmpty() && w.t() - cur.get(cur.size() - 1).t() >= PAUSE) {
                out.add(utterance(cur));
                cur = new ArrayList<>();
            }
            cur.add(w);
            if (w.text().matches(".*[.!?。！？]$")) {
                out.add(utterance(cur));
                cur = new ArrayList<>();
            }
        }
        if (!cur.isEmpty()) out.add(utterance(cur));
        return out;
    }

    private static Utterance utterance(List<DirectorJobs.Word> ws) {
        return new Utterance(ws.get(0).t(), ws.get(ws.size() - 1).t(), List.copyOf(ws));
    }

    /** 詞接成文字：中文字直接相接，其他詞間一個空白 */
    static String text(List<DirectorJobs.Word> words) {
        StringBuilder b = new StringBuilder();
        for (DirectorJobs.Word w : words) {
            String t = w.text().strip();
            if (t.isEmpty()) continue;
            boolean cjk = t.codePoints().allMatch(c -> Character.isIdeographic(c) || Character.getType(c) == Character.OTHER_PUNCTUATION && c > 0x3000);
            boolean prevCjk = b.length() > 0 && (Character.isIdeographic(b.codePointBefore(b.length())) || b.codePointBefore(b.length()) > 0x3000);
            if (b.length() > 0 && !(cjk && prevCjk)) b.append(' ');
            b.append(t);
        }
        return b.toString();
    }
}
