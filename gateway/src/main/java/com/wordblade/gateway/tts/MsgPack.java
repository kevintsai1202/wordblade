package com.wordblade.gateway.tts;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * 最小 msgpack 編碼器（只要編碼端，Fish Audio 的 /v1/tts 本體用 msgpack；同原專案 tts.pack，不引第三方套件）。
 * 支援 null、Boolean、整數（Integer／Long）、浮點（Float／Double，一律 float64）、String、byte[]、List、Map（鍵轉字串）。
 */
final class MsgPack {

    private MsgPack() {}

    /** 編碼一個值 */
    static byte[] pack(Object value) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        put(out, value);
        return out.toByteArray();
    }

    private static void put(ByteArrayOutputStream out, Object v) {
        if (v == null) out.write(0xc0);
        else if (v instanceof Boolean b) out.write(b ? 0xc3 : 0xc2);
        else if (v instanceof Integer || v instanceof Long) putInt(out, ((Number) v).longValue());
        else if (v instanceof Number n) {
            out.write(0xcb);
            putBytes(out, Double.doubleToLongBits(n.doubleValue()), 8);
        } else if (v instanceof String s) {
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            if (b.length < 32) out.write(0xa0 | b.length);
            else if (b.length < 0x100) { out.write(0xd9); out.write(b.length); }
            else if (b.length < 0x10000) { out.write(0xda); putBytes(out, b.length, 2); }
            else { out.write(0xdb); putBytes(out, b.length, 4); }
            out.writeBytes(b);
        } else if (v instanceof byte[] b) {
            if (b.length < 0x100) { out.write(0xc4); out.write(b.length); }
            else if (b.length < 0x10000) { out.write(0xc5); putBytes(out, b.length, 2); }
            else { out.write(0xc6); putBytes(out, b.length, 4); }
            out.writeBytes(b);
        } else if (v instanceof List<?> list) {
            if (list.size() < 16) out.write(0x90 | list.size());
            else { out.write(0xdc); putBytes(out, list.size(), 2); }
            for (Object x : list) put(out, x);
        } else if (v instanceof Map<?, ?> map) {
            if (map.size() < 16) out.write(0x80 | map.size());
            else { out.write(0xde); putBytes(out, map.size(), 2); }
            for (Map.Entry<?, ?> e : map.entrySet()) {
                put(out, String.valueOf(e.getKey()));
                put(out, e.getValue());
            }
        } else throw new IllegalArgumentException("msgpack can't encode " + v.getClass().getSimpleName());
    }

    /** 整數：0～127 用 positive fixint，負的小數用 negative fixint，其他用 int64 */
    private static void putInt(ByteArrayOutputStream out, long n) {
        if (n >= 0 && n < 128) out.write((int) n);
        else if (n < 0 && n >= -32) out.write((int) (n & 0xff));
        else { out.write(0xd3); putBytes(out, n, 8); }
    }

    /** 大端序寫 n 個位元組 */
    private static void putBytes(ByteArrayOutputStream out, long v, int n) {
        for (int i = n - 1; i >= 0; i--) out.write((int) (v >>> (8 * i)) & 0xff);
    }
}
