package com.netscope.app.core;

import java.util.List;
import java.util.Map;

/**
 * 极简 JSON 序列化器（零依赖）
 *
 * 只处理本项目实际用到的类型：Map、List、String、Number、Boolean、null。
 * 手写而不用第三方库，理由与项目其它部分一致：保持零第三方依赖。
 */
public final class Json {

    private Json() {
    }

    public static String write(Object value) {
        StringBuilder sb = new StringBuilder();
        writeValue(sb, value);
        return sb.toString();
    }

    private static void writeValue(StringBuilder sb, Object value) {
        if (value == null) {
            sb.append("null");
            return;
        }
        if (value instanceof String) {
            writeString(sb, (String) value);
            return;
        }
        if (value instanceof Boolean) {
            sb.append(((Boolean) value).booleanValue() ? "true" : "false");
            return;
        }
        if (value instanceof Double || value instanceof Float) {
            double d = ((Number) value).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) sb.append("null");
            else sb.append(trimNumber(d));
            return;
        }
        if (value instanceof Number) {
            sb.append(value.toString());
            return;
        }
        if (value instanceof Map) {
            writeMap(sb, (Map<?, ?>) value);
            return;
        }
        if (value instanceof List) {
            writeList(sb, (List<?>) value);
            return;
        }
        if (value instanceof Object[]) {
            Object[] arr = (Object[]) value;
            sb.append('[');
            for (int i = 0; i < arr.length; i += 1) {
                if (i > 0) sb.append(',');
                writeValue(sb, arr[i]);
            }
            sb.append(']');
            return;
        }
        // 其它类型统一转字符串，避免抛异常导致整个响应失败
        writeString(sb, String.valueOf(value));
    }

    private static void writeMap(StringBuilder sb, Map<?, ?> map) {
        sb.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            writeString(sb, String.valueOf(entry.getKey()));
            sb.append(':');
            writeValue(sb, entry.getValue());
        }
        sb.append('}');
    }

    private static void writeList(StringBuilder sb, List<?> list) {
        sb.append('[');
        for (int i = 0; i < list.size(); i += 1) {
            if (i > 0) sb.append(',');
            writeValue(sb, list.get(i));
        }
        sb.append(']');
    }

    /** 数字去掉多余的 .0，让输出更贴近桌面版（例如 20.8 而不是 20.800000000000001） */
    private static String trimNumber(double d) {
        if (d == Math.rint(d) && Math.abs(d) < 1e15) {
            return String.valueOf((long) d);
        }
        String s = String.format(java.util.Locale.US, "%.1f", Double.valueOf(d));
        return s;
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i += 1) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", Integer.valueOf(c)));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    /* ------------------------------------------------------------------ */
    /* 极简解析（只用于读取请求体里的少量字段）                              */
    /* ------------------------------------------------------------------ */

    /** 从 JSON 对象里取出字符串字段；找不到返回 null。支持简单转义。 */
    public static String getString(String json, String key) {
        if (json == null || key == null) return null;
        String needle = "\"" + key + "\"";
        int idx = json.indexOf(needle);
        if (idx < 0) return null;
        int colon = json.indexOf(':', idx + needle.length());
        if (colon < 0) return null;
        int i = colon + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i += 1;
        if (i >= json.length()) return null;
        if (json.charAt(i) == '"') {
            StringBuilder sb = new StringBuilder();
            i += 1;
            while (i < json.length()) {
                char c = json.charAt(i);
                if (c == '\\' && i + 1 < json.length()) {
                    char next = json.charAt(i + 1);
                    if (next == 'n') sb.append('\n');
                    else if (next == 't') sb.append('\t');
                    else if (next == 'r') sb.append('\r');
                    else if (next == '"') sb.append('"');
                    else if (next == '\\') sb.append('\\');
                    else sb.append(next);
                    i += 2;
                    continue;
                }
                if (c == '"') break;
                sb.append(c);
                i += 1;
            }
            return sb.toString();
        }
        // 非字符串：读到 , 或 } 为止
        int start = i;
        while (i < json.length() && json.charAt(i) != ',' && json.charAt(i) != '}') i += 1;
        String raw = json.substring(start, i).trim();
        return raw.isEmpty() || "null".equals(raw) ? null : raw;
    }

    /** 取整数字段 */
    public static int getInt(String json, String key, int fallback) {
        String raw = getString(json, key);
        if (raw == null) return fallback;
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            try {
                return (int) Double.parseDouble(raw.trim());
            } catch (NumberFormatException e2) {
                return fallback;
            }
        }
    }

    /** 取布尔字段 */
    public static boolean getBool(String json, String key, boolean fallback) {
        String raw = getString(json, key);
        if (raw == null) return fallback;
        return "true".equalsIgnoreCase(raw.trim());
    }
}
