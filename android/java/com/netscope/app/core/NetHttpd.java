package com.netscope.app.core;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 手机端内置 HTTP 服务（纯 Java 实现）
 *
 * 这是「手机独立运行」的关键：WebView 直接加载 http://127.0.0.1:<port>/，
 * 前端页面与桌面版**完全一致**（同一套 public/ 资源），只是后端换成了本类。
 *
 * 实现要点：
 *   · 用 ServerSocket + 线程池手写极简 HTTP/1.1（只支持 GET/POST + Content-Length，
 *     足够承载本项目的前端与 API）；
 *   · 静态资源由外部注入的 AssetProvider 提供（Android 侧从 assets 读）；
 *   · API 路由与桌面版保持一致，见 handleApi()。
 */
public final class NetHttpd implements ServerInfo {

    /** 静态资源提供者：由 Android 侧实现（从 assets 读取） */
    public interface AssetProvider {
        /** 读取资源；不存在返回 null */
        byte[] read(String path);

        /** 资源是否存在 */
        boolean exists(String path);
    }

    /** API 处理器：与桌面版同名的接口实现 */
    public interface ApiHandler {
        Map<String, Object> handle(String method, String path, Map<String, String> query, String body) throws Exception;
    }

    public static final String VERSION = "1.0.0";

    private final AssetProvider assets;
    private final ApiHandler api;
    private ServerSocket server;
    private Thread acceptThread;
    private ExecutorService pool;
    private volatile boolean running;
    private int port;
    private final long startedAt = System.currentTimeMillis();

    public NetHttpd(AssetProvider assets, ApiHandler api) {
        this.assets = assets;
        this.api = api;
    }

    @Override
    public int getPort() {
        return port;
    }

    public boolean isRunning() {
        return running;
    }

    /** 启动服务（阻塞直到端口就绪） */
    public synchronized void start(int preferredPort) throws Exception {
        if (running) return;
        ServerSocket ss = null;
        int p = preferredPort;
        for (int attempt = 0; attempt < 12; attempt += 1) {
            try {
                ss = new ServerSocket();
                ss.setReuseAddress(true);
                ss.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), p), 64);
                break;
            } catch (Exception e) {
                ss = null;
                p += 1; // 端口被占用时顺延
            }
        }
        if (ss == null) throw new IllegalStateException("无法在 127.0.0.1 上绑定端口（已尝试 " + preferredPort + " 起的 12 个端口）");
        server = ss;
        port = p;
        running = true;
        pool = Executors.newFixedThreadPool(8);
        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "netscope-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    public synchronized void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (Exception ignored) {
            /* ignore */
        }
        server = null;
        if (pool != null) pool.shutdownNow();
        pool = null;
    }

    private void acceptLoop() {
        while (running) {
            Socket socket = null;
            try {
                socket = server.accept();
            } catch (Exception e) {
                if (!running) return;
                continue;
            }
            final Socket s = socket;
            try {
                pool.execute(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            serve(s);
                        } catch (Exception ignored) {
                            /* 单个连接失败不影响服务 */
                        } finally {
                            try {
                                s.close();
                            } catch (Exception ignored) {
                                /* ignore */
                            }
                        }
                    }
                });
            } catch (Exception ignored) {
                try {
                    socket.close();
                } catch (Exception ignored2) {
                    /* ignore */
                }
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* HTTP 解析与响应                                                     */
    /* ------------------------------------------------------------------ */

    private void serve(Socket socket) throws Exception {
        socket.setSoTimeout(15000);
        PushbackInputStream in = new PushbackInputStream(socket.getInputStream(), 8192);
        OutputStream out = socket.getOutputStream();

        String requestLine = LocalNet.readLine(in);
        if (requestLine == null) return;
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) {
            writeText(out, 400, "Bad Request", "bad request");
            return;
        }
        String method = parts[0];
        String rawPath = parts[1];

        Map<String, String> headers = new LinkedHashMap<String, String>();
        String line;
        while ((line = LocalNet.readLine(in)) != null && line.length() > 0) {
            int colon = line.indexOf(':');
            if (colon > 0) {
                headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US),
                        line.substring(colon + 1).trim());
            }
        }

        int contentLength = 0;
        String cl = headers.get("content-length");
        if (cl != null) {
            try {
                contentLength = Integer.parseInt(cl.trim());
            } catch (NumberFormatException ignored) {
                contentLength = 0;
            }
        }
        String body = "";
        if (contentLength > 0) {
            byte[] buf = new byte[Math.min(contentLength, 4 * 1024 * 1024)];
            int read = 0;
            while (read < buf.length) {
                int n = in.read(buf, read, buf.length - read);
                if (n < 0) break;
                read += n;
            }
            body = new String(buf, 0, read, "UTF-8");
        }

        String pathOnly = rawPath;
        Map<String, String> query = new LinkedHashMap<String, String>();
        int q = rawPath.indexOf('?');
        if (q >= 0) {
            pathOnly = rawPath.substring(0, q);
            query = parseQuery(rawPath.substring(q + 1));
        }

        // CORS：方便从其它来源调试
        if ("OPTIONS".equalsIgnoreCase(method)) {
            writeEmpty(out, 204, null);
            return;
        }

        if (pathOnly.startsWith("/api/")) {
            handleApi(method, pathOnly, query, body, out);
            return;
        }
        serveAsset(pathOnly, out);
    }

    private void handleApi(String method, String path, Map<String, String> query, String body, OutputStream out) {
        Map<String, Object> result;
        try {
            result = api.handle(method, path, query, body);
        } catch (Throwable t) {
            result = new LinkedHashMap<String, Object>();
            result.put("ok", Boolean.FALSE);
            result.put("error", String.valueOf(t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage()));
        }
        if (result == null) {
            result = new LinkedHashMap<String, Object>();
            result.put("ok", Boolean.FALSE);
            result.put("error", "接口未实现：" + path);
        }
        writeJson(out, 200, result);
    }

    private void serveAsset(String path, OutputStream out) throws Exception {
        String key = path.startsWith("/") ? path.substring(1) : path;
        if (key.isEmpty()) key = "index.html";
        if (!assets.exists(key)) {
            // 单页应用回退：无扩展名时返回 index.html
            if (key.indexOf('.') < 0 && assets.exists("index.html")) {
                key = "index.html";
            } else {
                writeText(out, 404, "Not Found", "资源不存在：" + path);
                return;
            }
        }
        byte[] data = assets.read(key);
        if (data == null) {
            writeText(out, 404, "Not Found", "资源不存在：" + path);
            return;
        }
        String mime = mimeOf(key);
        boolean noCache = key.endsWith(".html") || key.startsWith("data/");
        Map<String, String> headers = new LinkedHashMap<String, String>();
        headers.put("Content-Type", mime);
        headers.put("Cache-Control", noCache ? "no-cache" : "public, max-age=300");
        writeBytes(out, 200, "OK", data, headers);
    }

    static String mimeOf(String key) {
        String k = key.toLowerCase(Locale.US);
        if (k.endsWith(".html")) return "text/html; charset=utf-8";
        if (k.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (k.endsWith(".css")) return "text/css; charset=utf-8";
        if (k.endsWith(".json")) return "application/json; charset=utf-8";
        if (k.endsWith(".svg")) return "image/svg+xml";
        if (k.endsWith(".png")) return "image/png";
        if (k.endsWith(".jpg") || k.endsWith(".jpeg")) return "image/jpeg";
        if (k.endsWith(".ico")) return "image/x-icon";
        if (k.endsWith(".woff2")) return "font/woff2";
        if (k.endsWith(".woff")) return "font/woff";
        if (k.endsWith(".txt")) return "text/plain; charset=utf-8";
        if (k.endsWith(".webmanifest")) return "application/manifest+json";
        return "application/octet-stream";
    }

    static Map<String, String> parseQuery(String raw) {
        Map<String, String> out = new LinkedHashMap<String, String>();
        if (raw == null || raw.isEmpty()) return out;
        String[] pairs = raw.split("&");
        for (int i = 0; i < pairs.length; i += 1) {
            int eq = pairs[i].indexOf('=');
            try {
                if (eq < 0) {
                    out.put(URLDecoder.decode(pairs[i], "UTF-8"), "");
                } else {
                    out.put(URLDecoder.decode(pairs[i].substring(0, eq), "UTF-8"),
                            URLDecoder.decode(pairs[i].substring(eq + 1), "UTF-8"));
                }
            } catch (Exception ignored) {
                /* 跳过非法参数 */
            }
        }
        return out;
    }

    /* ---------------------------- 输出 ---------------------------- */

    private void writeJson(OutputStream out, int status, Map<String, Object> body) {
        byte[] data = Json.write(body).getBytes(java.nio.charset.Charset.forName("UTF-8"));
        Map<String, String> headers = new LinkedHashMap<String, String>();
        headers.put("Content-Type", "application/json; charset=utf-8");
        headers.put("Cache-Control", "no-cache");
        try {
            writeBytes(out, status, statusText(status), data, headers);
        } catch (Exception ignored) {
            /* 客户端可能已断开 */
        }
    }

    private void writeText(OutputStream out, int status, String reason, String text) {
        try {
            writeBytes(out, status, reason, text.getBytes("UTF-8"), null);
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    private void writeEmpty(OutputStream out, int status, Map<String, String> extra) {
        try {
            writeBytes(out, status, statusText(status), new byte[0], extra);
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    private void writeBytes(OutputStream out, int status, String reason, byte[] data, Map<String, String> headers)
            throws Exception {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
        sb.append("Content-Length: ").append(data.length).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Headers: Content-Type, x-amap-key, x-amap-security\r\n");
        sb.append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
        sb.append("Connection: close\r\n");
        if (headers != null) {
            for (Map.Entry<String, String> e : headers.entrySet()) {
                sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
            }
        }
        sb.append("\r\n");
        out.write(sb.toString().getBytes("UTF-8"));
        if (data.length > 0) out.write(data);
        out.flush();
    }

    static String statusText(int status) {
        switch (status) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 500: return "Internal Server Error";
            default: return "OK";
        }
    }

    @Override
    public String startedAtIso() {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date(startedAt));
    }

    @Override
    public long uptimeSec() {
        return (System.currentTimeMillis() - startedAt) / 1000;
    }

    /** 读取请求体并返回字符串（供外部使用） */
    public static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), "UTF-8");
    }

    /** 工具：把 List 包成 JSON 数组（避免各处重复泛型转换） */
    public static List<Object> toObjectList(List<?> src) {
        List<Object> out = new ArrayList<Object>();
        if (src != null) {
            for (int i = 0; i < src.size(); i += 1) out.add(src.get(i));
        }
        return out;
    }
}
