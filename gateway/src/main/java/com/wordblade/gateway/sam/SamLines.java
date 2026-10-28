package com.wordblade.gateway.sam;

import java.util.ArrayList;
import java.util.List;

/**
 * SAM 逐格輸出的切行：delta 文字串起來後一格一行（換行結尾；遮罩編碼的字元集不含換行），收完整的行才交出去。
 * 行內容不在閘道解析（桌面 src/sam/stream.ts 解析），閘道只負責累積與分批交給輪詢。
 */
public class SamLines {

    /** 還沒收到換行的部分 */
    private final StringBuilder buf = new StringBuilder();

    /** 收一段文字，回傳這次收完整的行（不含換行；空行略過） */
    public List<String> feed(String text) {
        buf.append(text);
        List<String> out = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < buf.length(); i++) {
            if (buf.charAt(i) != '\n') continue;
            String line = buf.substring(start, i).strip();
            if (!line.isEmpty()) out.add(line);
            start = i + 1;
        }
        buf.delete(0, start);
        return out;
    }

    /** 剩下還沒收到換行的部分 */
    public String rest() {
        return buf.toString();
    }
}
