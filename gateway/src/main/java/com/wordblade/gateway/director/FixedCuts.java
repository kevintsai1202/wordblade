package com.wordblade.gateway.director;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 程式決定的剪（docs/plan-10-31-director4.md）：開發者 2026-10-31 要求剪輯結果穩定，所以這三種剪不交給規劃者決定——
 * - 片頭空白：第一個詞之前超過 2 秒，剪到開口前 0.3 秒。
 * - 片尾空白：最後一句之後超過 3 秒，從講完後 0.6 秒剪到片尾；最後孤立的一兩個詞（前面空了 10 秒以上，例如一聲 Yeah）不算講話。
 * - 重講：Jev 確認的候選（重講或放棄的碎片 ≥ 0.6；前面那句不完整時碎片 ≥ 0.5）；重疊或相連的合成一段，剪到最後一次重講的開頭（只留最後一次）；
 *   不太確定（< 0.75）時，保留的那次要講完整才剪。
 * 規劃者的剪若和這些重疊，併成一段（程式的 id 與理由優先）。
 */
public final class FixedCuts {

    /** 片頭空白超過幾秒才剪 */
    static final double HEAD_MIN = 2;
    /** 片尾空白超過幾秒才剪 */
    static final double TAIL_MIN = 3;
    /** 開口前留幾秒 */
    static final double LEAD = 0.3;
    /** 最後一個詞後留幾秒（詞只記開始時間，留一點讓它講完） */
    static final double TRAIL = 0.6;
    /** 孤立詞：前面空了幾秒以上 */
    static final double ISOLATED_GAP = 10;
    /** 孤立詞：最多幾個詞 */
    static final int ISOLATED_WORDS = 2;
    /** 逐字稿至少幾個詞才自動剪（太少看不出哪裡是講話、哪裡是空白） */
    static final int MIN_WORDS = 20;
    /** 留下的那次重講要講完整（機率）才自動剪 */
    static final double COMPLETE_MIN = 0.5;

    private FixedCuts() {}

    /** 依逐字稿與 Jev 的判斷算出程式決定的剪（id f1、f2…，依時間排序） */
    public static List<DirectorRules.Suggestion> build(List<DirectorJobs.Word> words, double duration, List<DirectorJobs.JudgedRetake> retakes) {
        List<DirectorJobs.Word> sorted = words.stream().sorted(Comparator.comparingDouble(DirectorJobs.Word::t)).toList();
        List<DirectorRules.Suggestion> out = new ArrayList<>();
        if (sorted.size() < MIN_WORDS) return out;
        // 片頭
        double first = sorted.get(0).t();
        if (first > HEAD_MIN) out.add(cut("head", 0, round1(first - LEAD), "Remove the silent opening before the speaker starts.", ""));
        // 重講與放棄的碎片：確認過的候選，重疊或相連的合成一段（剪到最後一次重講的開頭）；那一次要講完整，否則不自動剪
        List<DirectorJobs.JudgedRetake> spans = retakes.stream().filter(DirectorJobs.JudgedRetake::isRetake)
                .sorted(Comparator.comparingDouble(r -> r.candidate().start())).toList();
        List<double[]> merged = new ArrayList<>();
        /** 每一段的最後一次重講講完整的機率（以剪的結尾最晚的那個候選為準） */
        List<Double> lastComplete = new ArrayList<>();
        /** 每一段裡最確定的重講機率 */
        List<Double> sure = new ArrayList<>();
        for (DirectorJobs.JudgedRetake r : spans) {
            double s0 = r.candidate().start();
            double s1 = r.candidate().end();
            double[] last = merged.isEmpty() ? null : merged.get(merged.size() - 1);
            if (last != null && s0 <= last[1] + 0.05) {
                if (s1 >= last[1]) lastComplete.set(lastComplete.size() - 1, r.verdict().complete());
                last[1] = Math.max(last[1], s1);
                sure.set(sure.size() - 1, Math.max(sure.get(sure.size() - 1), r.verdict().retake()));
            } else {
                merged.add(new double[] {s0, s1});
                lastComplete.add(r.verdict().complete());
                sure.add(r.verdict().retake());
            }
        }
        for (int i = 0; i < merged.size(); i++) {
            // 不太確定的重講（< 0.75）才要求保留的那次講完整
            if (sure.get(i) < DirectorJobs.SURE_RETAKE && lastComplete.get(i) < COMPLETE_MIN) continue;
            double[] m = merged.get(i);
            String said = RetakeFinder.text(sorted.stream().filter(w -> w.t() >= m[0] && w.t() < m[1]).toList());
            out.add(cut("retake", m[0], m[1], String.format(Locale.ROOT, "Remove the earlier attempt; the speaker says it again at %.1f s.", m[1]),
                    said.length() > 60 ? said.substring(0, 60) : said));
        }
        // 片尾：最後一個不孤立的詞
        int lastSpeech = sorted.size() - 1;
        for (int n = 1; n <= ISOLATED_WORDS && sorted.size() - n - 1 >= 0; n++) {
            int before = sorted.size() - n - 1;
            if (sorted.get(before + 1).t() - sorted.get(before).t() >= ISOLATED_GAP) {
                lastSpeech = before;
                break;
            }
        }
        double tailStart = round1(sorted.get(lastSpeech).t() + TRAIL);
        if (duration - tailStart > TAIL_MIN) out.add(cut("tail", tailStart, duration, "Remove the silent ending after the speaker finishes.", ""));
        out.sort(Comparator.comparingDouble(DirectorRules.Suggestion::start));
        List<DirectorRules.Suggestion> numbered = new ArrayList<>();
        for (int i = 0; i < out.size(); i++) {
            DirectorRules.Suggestion s = out.get(i);
            numbered.add(new DirectorRules.Suggestion("f" + (i + 1), s.kind(), s.start(), s.end(), s.reason(), s.payload(), s.purpose(), s.quote(), -1, null, null));
        }
        return numbered;
    }

    /**
     * 補充的提醒：Jev 判斷後面是補充前面漏講的（兩段都要留），在剪輯腳本列一項「提醒」（kind note，id n1、n2…），不自動做任何編輯。
     */
    public static List<DirectorRules.Suggestion> notes(List<DirectorJobs.JudgedRetake> retakes) {
        List<DirectorJobs.JudgedRetake> sups = retakes.stream().filter(DirectorJobs.JudgedRetake::isSupplement)
                .sorted(Comparator.comparingDouble(r -> r.candidate().end())).toList();
        List<DirectorRules.Suggestion> out = new ArrayList<>();
        for (DirectorJobs.JudgedRetake r : sups) {
            RetakeFinder.Candidate c = r.candidate();
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("relation", "supplement");
            payload.put("earlierStart", round1(c.start()));
            String purpose = String.format(Locale.ROOT, "At %.1f s the speaker adds something left out at %.1f s; both are kept. Consider moving it next to the earlier part.",
                    c.end(), c.start());
            String quote = c.later().length() > 60 ? c.later().substring(0, 60) : c.later();
            out.add(new DirectorRules.Suggestion("n" + (out.size() + 1), "note", round1(c.end()), round1(c.end() + 2), purpose, payload, purpose, quote, -1, null, null));
        }
        return out;
    }

    /** 程式的剪加進規劃者的項目：規劃者的剪和程式的剪重疊就併進程式那段（程式的 id 與理由優先），依時間排序 */
    public static List<DirectorRules.Suggestion> merge(List<DirectorRules.Suggestion> fixed, List<DirectorRules.Suggestion> planned) {
        List<DirectorRules.Suggestion> out = new ArrayList<>(fixed);
        for (DirectorRules.Suggestion p : planned) {
            if (!p.kind().equals("cut")) {
                out.add(p);
                continue;
            }
            int hit = -1;
            for (int i = 0; i < out.size(); i++) {
                DirectorRules.Suggestion f = out.get(i);
                if (f.id().startsWith("f") && f.kind().equals("cut") && p.start() < f.end() && f.start() < p.end()) hit = i;
            }
            if (hit < 0) {
                out.add(p);
                continue;
            }
            DirectorRules.Suggestion f = out.get(hit);
            out.set(hit, new DirectorRules.Suggestion(f.id(), f.kind(), Math.min(f.start(), p.start()), Math.max(f.end(), p.end()), f.reason(), f.payload(),
                    f.purpose(), f.quote(), f.chapter(), f.review(), f.problem()));
        }
        out.sort(Comparator.comparingDouble(DirectorRules.Suggestion::start));
        return out;
    }

    private static DirectorRules.Suggestion cut(String reason, double start, double end, String purpose, String quote) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("reason", reason);
        payload.put("fixed", true);
        return new DirectorRules.Suggestion("", "cut", round1(start), round1(end), purpose, payload, purpose, quote, -1, null, null);
    }

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }
}
