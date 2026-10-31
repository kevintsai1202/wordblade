package com.wordblade.gateway.director;

import java.util.ArrayList;
import java.util.List;

/**
 * Jev 問好幾次取平均（2026-10-31 開發者決定，預設 3 次）：Jev 沒有溫度或種子可調（API 回 400），
 * 同一請求連送 6 次的重講機率在 0.61～0.66 之間；平均可以消掉這種小雜訊，讓門檻附近的判斷穩一點。
 * 四個機率與每一句的完整度都平均；tokens 加總（費用照實記）。
 */
public class AveragingRetakeJudge implements DirectorJobs.RetakeJudge {

    private final DirectorJobs.RetakeJudge inner;
    /** 每題問幾次 */
    private final int times;

    public AveragingRetakeJudge(DirectorJobs.RetakeJudge inner, int times) {
        this.inner = inner;
        this.times = Math.max(1, times);
    }

    @Override
    public DirectorJobs.RetakeVerdict judge(String earlier, String later) {
        double r = 0, f = 0, s = 0, c = 0;
        long tokens = 0;
        String model = null;
        for (int i = 0; i < times; i++) {
            DirectorJobs.RetakeVerdict v = inner.judge(earlier, later);
            r += v.retake();
            f += v.falseStart();
            s += v.supplement();
            c += v.complete();
            tokens += v.inputTokens();
            model = v.model();
        }
        return new DirectorJobs.RetakeVerdict(r / times, f / times, s / times, c / times, tokens, model);
    }

    @Override
    public DirectorJobs.Completeness completeness(List<String> sentences) {
        double[] sum = new double[sentences.size()];
        long tokens = 0;
        String model = null;
        for (int i = 0; i < times; i++) {
            DirectorJobs.Completeness c = inner.completeness(sentences);
            if (c == null) return null;
            for (int k = 0; k < sum.length && k < c.probabilities().size(); k++) sum[k] += c.probabilities().get(k);
            tokens += c.inputTokens();
            model = c.model();
        }
        List<Double> avg = new ArrayList<>();
        for (double v : sum) avg.add(v / times);
        return new DirectorJobs.Completeness(avg, tokens, model);
    }
}
