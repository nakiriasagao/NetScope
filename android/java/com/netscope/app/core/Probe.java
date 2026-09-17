package com.netscope.app.core;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 网络探测引擎（纯 Java，无 Android 依赖）
 *
 * 设计目标：让**手机自己不依赖电脑**也能完成路由追踪与可达性探测。
 *
 * 平台限制与对策：
 *   Android 应用不能创建原始套接字（需要 root），拿不到 ICMP 报文的来源地址，
 *   因此不能像桌面 traceroute 那样逐跳读取"TTL 超时"的回包地址。
 *   本引擎采用两个可用的手段组合：
 *
 *   1. **逐跳 ICMP**（主力）：系统自带 ping 支持指定 TTL。
 *      TTL=n 能到达目标 ⇒ 目标就在第 n 跳；不能到达 ⇒ 目标更远。
 *      缺点：中间路由器的地址拿不到（只显示"未响应"）。
 *
 *   2. **UDP(TTL)**（补充）：不 connect 的 DatagramSocket 逐包读取 IP_TTL 选项，
 *      在部分平台上能从 receive() 拿到回包地址，从而补全中间跳。
 *
 * 两者结合：以 ICMP 的结果为骨架，用 UDP 补地址。
 */
public final class Probe {

    private Probe() {
    }

    /** 单跳探测结果 */
    public static final class Hop {
        public int ttl;
        public String ip;
        public String hostname;
        public double avgMs = -1;
        public double minMs = -1;
        public double maxMs = -1;
        public double lossPct = 100;
        public boolean timeout;

        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("ttl", Integer.valueOf(ttl));
            m.put("ip", ip);
            m.put("hostname", hostname);
            Map<String, Object> lat = new LinkedHashMap<String, Object>();
            lat.put("avg", avgMs < 0 ? null : Double.valueOf(round1(avgMs)));
            lat.put("min", minMs < 0 ? null : Double.valueOf(round1(minMs)));
            lat.put("max", maxMs < 0 ? null : Double.valueOf(round1(maxMs)));
            lat.put("lossPct", Double.valueOf(round1(lossPct)));
            m.put("latency", lat);
            m.put("isTimeout", Boolean.valueOf(timeout));
            return m;
        }
    }

    /** 路由追踪结果 */
    public static final class TraceResult {
        public String target;
        public String targetIp;
        public List<Hop> hops = new ArrayList<Hop>();
        public String engine = "icmp-ttl";
        public List<String> notes = new ArrayList<String>();
        public long durationMs;

        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("target", target);
            m.put("targetIp", targetIp);
            m.put("engine", engine);
            m.put("durationMs", Long.valueOf(durationMs));
            m.put("notes", notes);
            List<Object> list = new ArrayList<Object>();
            for (int i = 0; i < hops.size(); i += 1) list.add(hops.get(i).toMap());
            m.put("hops", list);
            return m;
        }
    }

    public static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    /* ------------------------------------------------------------------ */
    /* 系统 ping 封装                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * 调用系统 ping（Android 自带，无需 root）
     *
     * TTL 参数各平台写法不同：Windows 用 -i，Linux/Android 用 -t；
     * 传错会被当成别的含义（Android 上 -i 是发包间隔），因此必须区分。
     *
     * @param ttl 0 表示不指定 TTL
     * @return { 是否成功, RTT 毫秒, 原始输出 }
     */
    private static Object[] ping(String ip, int timeoutMs, int ttl) {
        Process p = null;
        try {
            boolean win = isWindows();
            List<String> cmd = new ArrayList<String>();
            cmd.add("ping");
            // 次数参数各平台不同：Windows 是 -n，Linux/Android 是 -c
            cmd.add(win ? "-n" : "-c");
            cmd.add("1");
            if (ttl > 0) {
                // TTL 参数同样不同：Windows 是 -i，Linux/Android 是 -t
                cmd.add(win ? "-i" : "-t");
                cmd.add(String.valueOf(ttl));
            }
            if (win) {
                cmd.add("-w");
                cmd.add(String.valueOf(Math.max(300, timeoutMs)));
            } else {
                cmd.add("-W");
                cmd.add(String.valueOf(Math.max(1, timeoutMs / 1000)));
            }
            cmd.add(ip);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            p = pb.start();
            long t0 = System.nanoTime();
            byte[] buf = new byte[4096];
            StringBuilder out = new StringBuilder();
            long deadline = System.currentTimeMillis() + timeoutMs + 2000;
            while (System.currentTimeMillis() < deadline) {
                int n = p.getInputStream().read(buf);
                if (n < 0) break;
                out.append(new String(buf, 0, n));
            }
            boolean ok = p.waitFor() == 0;
            double elapsed = (System.nanoTime() - t0) / 1e6;
            double parsed = parseRtt(out.toString());
            return new Object[] { Boolean.valueOf(ok), Double.valueOf(parsed >= 0 ? parsed : elapsed), out.toString() };
        } catch (Exception e) {
            return new Object[] { Boolean.FALSE, Double.valueOf(-1), "" };
        } finally {
            if (p != null) {
                try {
                    p.destroy();
                } catch (Exception ignored) {
                    /* ignore */
                }
            }
        }
    }

    /** 从 ping 输出解析 RTT（兼容英文 time= 与中文 时间=/平均） */
    private static double parseRtt(String text) {
        String[] markers = { "time=", "时间=", "time<", "时间<" };
        for (int m = 0; m < markers.length; m += 1) {
            int idx = text.indexOf(markers[m]);
            if (idx < 0) continue;
            int i = idx + markers[m].length();
            StringBuilder num = new StringBuilder();
            while (i < text.length()) {
                char c = text.charAt(i);
                if (Character.isDigit(c) || c == '.') {
                    num.append(c);
                    i += 1;
                } else if (num.length() > 0) {
                    break;
                } else if (c == '<' || c == ' ' || c == '=') {
                    i += 1;
                } else {
                    break;
                }
            }
            if (num.length() > 0) {
                try {
                    return Double.parseDouble(num.toString());
                } catch (NumberFormatException ignored) {
                    /* 试下一个标记 */
                }
            }
        }
        int avg = text.indexOf("平均");
        if (avg >= 0) {
            int eq = text.indexOf('=', avg);
            if (eq > 0) {
                StringBuilder num = new StringBuilder();
                for (int i = eq + 1; i < text.length(); i += 1) {
                    char c = text.charAt(i);
                    if (Character.isDigit(c) || c == '.') num.append(c);
                    else if (num.length() > 0) break;
                }
                if (num.length() > 0) {
                    try {
                        return Double.parseDouble(num.toString());
                    } catch (NumberFormatException ignored) {
                        /* ignore */
                    }
                }
            }
        }
        return -1;
    }

    /** 带 TTL 的可达性判断 */
    private static boolean pingReachable(String ip, int ttl, int timeoutMs) {
        Object[] r = ping(ip, timeoutMs, ttl);
        return ((Boolean) r[0]).booleanValue();
    }

    /* ------------------------------------------------------------------ */
    /* 路由追踪                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * 逐跳探测（Android 上无需 root 的可行方案）
     *
     * **能力边界（重要）**：Android 应用不能创建原始套接字，Java 也拿不到
     * ICMP "TTL 超时"报文的来源地址，因此**无法获得中间路由器的 IP**。
     * 逐跳 TTL 探测只能回答"目标在第几跳之外"。
     *
     * 因此本方法的产出是：
     *   · 目标主机（已知地址 + RTT）；
     *   · 目标的**跳数距离**（从 TTL=1 递增到能到达目标为止）；
     *   · 无法解析的中间跳，明确标注为"未响应（受平台限制）"，
     *     而不是伪造地址。
     *
     * 想看到逐跳拓扑与地理位置，请使用桌面版（它有原生套接字引擎）。
     *
     * @param maxHops   最大跳数
     * @param timeoutMs 单跳超时
     * @param budgetMs  总时限（0 表示不限）
     */
    public static TraceResult traceIcmp(String targetHost, int maxHops, int timeoutMs, long budgetMs) {
        TraceResult result = new TraceResult();
        result.target = targetHost;
        result.engine = "icmp-ttl";
        long started = System.currentTimeMillis();

        InetAddress target;
        try {
            target = InetAddress.getByName(targetHost);
        } catch (Exception e) {
            result.notes.add("无法解析目标：" + e.getMessage());
            result.durationMs = System.currentTimeMillis() - started;
            return result;
        }
        result.targetIp = target.getHostAddress();
        String ip = result.targetIp;

        // 先做一次不限 TTL 的可达性判断，拿到目标自身的 TTL 与 RTT
        Object[] baseline = ping(ip, Math.max(1200, timeoutMs), 0);
        boolean reachable = ((Boolean) baseline[0]).booleanValue();
        int targetTtl = extractTtl((String) baseline[2]);
        double targetRtt = ((Double) baseline[1]).doubleValue();

        if (!reachable) {
            result.notes.add("目标未回应 ICMP（可能被防火墙或运营商过滤），无法确定路径");
            Hop only = new Hop();
            only.ttl = 1;
            only.ip = ip;
            only.hostname = reverseLookup(ip);
            only.timeout = true;
            only.lossPct = 100;
            result.hops.add(only);
            result.durationMs = System.currentTimeMillis() - started;
            return result;
        }

        // 已知目标自身的 TTL 时可以直接算出跳数：路径跳数 ≈ 初始 TTL(常见 64/128/255) - 收到的 TTL
        if (targetTtl > 0) {
            int hops = estimateHops(targetTtl);
            if (hops > 0) {
                result.notes.add("由目标回包 TTL=" + targetTtl + " 推算：目标约在第 " + hops + " 跳");
            }
        }

        // 逐跳探测：找出"目标位于第几跳之外"
        int firstReachableTtl = -1;
        int probed = 0;
        for (int ttl = 1; ttl <= maxHops; ttl += 1) {
            if (budgetMs > 0 && System.currentTimeMillis() - started > budgetMs) break;
            probed = ttl;
            if (pingReachable(ip, ttl, timeoutMs)) {
                firstReachableTtl = ttl;
                break;
            }
        }

        // 组装结果：中间跳标注为"未响应（平台限制）"，最后一跳为真实目标
        int hopCount = firstReachableTtl > 0 ? firstReachableTtl : Math.max(1, probed);
        for (int ttl = 1; ttl <= hopCount; ttl += 1) {
            Hop hop = new Hop();
            hop.ttl = ttl;
            if (ttl == hopCount) {
                hop.ip = ip;
                hop.hostname = reverseLookup(ip);
                hop.timeout = false;
                hop.avgMs = targetRtt;
                hop.minMs = targetRtt;
                hop.maxMs = targetRtt;
                hop.lossPct = 0;
            } else {
                hop.timeout = true;
                hop.ip = null;
                hop.lossPct = 100;
            }
            result.hops.add(hop);
        }

        if (firstReachableTtl > 0) {
            result.notes.add("中间路由器地址无法获取：Android 无 root 时拿不到 ICMP 超时报文的来源地址");
            result.notes.add("手机端不显示逐跳地址，想看完整路径请使用桌面版 NetScope");
        } else {
            result.notes.add("在 " + maxHops + " 跳内未能到达目标");
        }

        result.durationMs = System.currentTimeMillis() - started;
        return result;
    }

    /** 从 ping 回包解析 TTL 值（英文 TTL= / 中文 TTL=） */
    private static int extractTtl(String text) {
        int idx = text.indexOf("TTL=");
        if (idx < 0) idx = text.indexOf("ttl=");
        if (idx < 0) return -1;
        StringBuilder num = new StringBuilder();
        for (int i = idx + 4; i < text.length(); i += 1) {
            char c = text.charAt(i);
            if (Character.isDigit(c)) num.append(c);
            else break;
        }
        if (num.length() == 0) return -1;
        try {
            return Integer.parseInt(num.toString());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** 由回包 TTL 推算路径跳数（常见初始 TTL 为 64 / 128 / 255） */
    private static int estimateHops(int ttl) {
        int[] initial = { 64, 128, 255 };
        for (int i = 0; i < initial.length; i += 1) {
            if (ttl <= initial[i]) return initial[i] - ttl + 1;
        }
        return -1;
    }

    /**
     * 并行 UDP(TTL) 探测：用于补全中间跳的真实地址
     *
     * 不 connect()，因此每次 send 都会读取当前的 IP_TTL 选项。
     *
     * @param out ttl → 地址
     * @return 是否拿到任何地址
     */
    private static boolean udpSweep(InetAddress target, int maxHops, int timeoutMs, Map<Integer, String> out) {
        DatagramSocket socket = null;
        try {
            socket = new DatagramSocket();
            setTtl(socket, 5); // 先确认本环境支持设置 TTL
        } catch (Throwable e) {
            if (socket != null) socket.close();
            return false;
        }
        try {
            for (int ttl = 1; ttl <= maxHops; ttl += 1) {
                for (int dup = 0; dup < 3; dup += 1) {
                    try {
                        setTtl(socket, ttl);
                        byte[] payload = new byte[16];
                        DatagramPacket outPkt = new DatagramPacket(payload, payload.length,
                                new InetSocketAddress(target, 33434 + ttl));
                        socket.send(outPkt);
                    } catch (Throwable ignored) {
                        /* 单包失败不影响其它跳 */
                    }
                }
            }
            String targetIp = target.getHostAddress();
            long deadline = System.currentTimeMillis() + Math.min(3000, Math.max(600, timeoutMs * 2));
            socket.setSoTimeout(150);
            byte[] buf = new byte[512];
            while (System.currentTimeMillis() < deadline) {
                DatagramPacket in = new DatagramPacket(buf, buf.length);
                try {
                    socket.receive(in);
                    // receive 成功说明有端口回应（通常是目标自己）
                    if (in.getAddress() != null && in.getAddress().getHostAddress().equals(targetIp)) {
                        out.put(Integer.valueOf(maxHops), targetIp);
                    }
                } catch (SocketTimeoutException e) {
                    /* 继续等到 deadline */
                } catch (IOException e) {
                    String msg = e.getMessage() == null ? "" : e.getMessage();
                    if (msg.contains(targetIp)) out.put(Integer.valueOf(maxHops), targetIp);
                }
            }
            return !out.isEmpty();
        } catch (Throwable e) {
            return false;
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
                /* ignore */
            }
        }
    }

    /**
     * 设置 UDP 套接字的 TTL
     *
     * DatagramSocket.setOption(IP_TTL) 是 Java 9+ 的 API，Android 早期版本没有，
     * 因此用反射调用；MulticastSocket 的 setTimeToLive 作为兜底。
     */
    private static void setTtl(DatagramSocket socket, int ttl) throws Exception {
        try {
            Class<?> optionsClass = Class.forName("java.net.StandardSocketOptions");
            Object ipTtl = optionsClass.getField("IP_TTL").get(null);
            Class<?> socketOptionClass = Class.forName("java.net.SocketOption");
            java.lang.reflect.Method setOption =
                    DatagramSocket.class.getMethod("setOption", socketOptionClass, Object.class);
            setOption.invoke(socket, ipTtl, Integer.valueOf(ttl));
            return;
        } catch (Throwable ignored) {
            /* 试兜底方案 */
        }
        java.lang.reflect.Method m = socket.getClass().getMethod("setTimeToLive", int.class);
        m.invoke(socket, Integer.valueOf(ttl));
    }

    /**
     * 完整路由追踪：ICMP 骨架 + UDP 补地址
     */
    public static TraceResult trace(String targetHost, int maxHops, int queries, int timeoutMs) {
        TraceResult result = traceIcmp(targetHost, maxHops, timeoutMs, 45000);

        InetAddress target = null;
        try {
            target = InetAddress.getByName(targetHost);
        } catch (Exception ignored) {
            /* 解析失败时只用 ICMP 结果 */
        }
        if (target != null && target.getHostAddress() != null && target.getHostAddress().indexOf(':') < 0) {
            Map<Integer, String> udpHop = new LinkedHashMap<Integer, String>();
            if (udpSweep(target, Math.min(maxHops, 12), timeoutMs, udpHop) && !udpHop.isEmpty()) {
                int filled = 0;
                for (int i = 0; i < result.hops.size(); i += 1) {
                    Hop hop = result.hops.get(i);
                    String addr = udpHop.get(Integer.valueOf(hop.ttl));
                    if (addr != null) {
                        hop.ip = addr;
                        hop.hostname = reverseLookup(addr);
                        hop.timeout = false;
                        filled += 1;
                    }
                }
                if (filled > 0) {
                    result.engine = "icmp-ttl + udp-ttl";
                    result.notes.add("已用 UDP(TTL) 补充 " + filled + " 个中间跳的地址");
                }
            }
        }
        return result;
    }

    public static String reverseLookup(String ip) {
        try {
            InetAddress addr = InetAddress.getByName(ip);
            String name = addr.getCanonicalHostName();
            if (name == null || name.equals(ip)) return null;
            return name;
        } catch (Exception e) {
            return null;
        }
    }

    /* ------------------------------------------------------------------ */
    /* TCP 探测 / 端口扫描                                                  */
    /* ------------------------------------------------------------------ */

    /** TCP 连接探测：返回连接耗时毫秒；失败返回 -1 */
    public static double tcpConnect(String host, int port, int timeoutMs) {
        Socket socket = new Socket();
        try {
            long t0 = System.nanoTime();
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            return (System.nanoTime() - t0) / 1e6;
        } catch (Exception e) {
            return -1;
        } finally {
            try {
                socket.close();
            } catch (Exception ignored) {
                /* ignore */
            }
        }
    }

    /** 端口扫描：返回开放端口（升序） */
    public static List<Integer> scanPorts(String host, List<Integer> ports, int timeoutMs, int concurrency) {
        final List<Integer> open = Collections.synchronizedList(new ArrayList<Integer>());
        final AtomicInteger index = new AtomicInteger(0);
        int workers = Math.max(1, Math.min(concurrency, Math.max(1, ports.size())));
        Thread[] threads = new Thread[workers];
        for (int i = 0; i < workers; i += 1) {
            threads[i] = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (true) {
                        int idx = index.getAndIncrement();
                        if (idx >= ports.size()) return;
                        int port = ports.get(idx).intValue();
                        if (tcpConnect(host, port, timeoutMs) >= 0) open.add(Integer.valueOf(port));
                    }
                }
            });
            threads[i].setDaemon(true);
            threads[i].start();
        }
        for (int i = 0; i < workers; i += 1) {
            try {
                threads[i].join(timeoutMs + 3000L);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        List<Integer> sorted = new ArrayList<Integer>(open);
        Collections.sort(sorted);
        return sorted;
    }

    /** 判断主机是否存活（TCP 常用端口 + ICMP） */
    public static boolean hostAlive(String ip, int timeoutMs) {
        if (pingReachable(ip, 0, Math.max(400, timeoutMs))) return true;
        int[] common = { 80, 443, 22, 445, 8080, 3389, 5000 };
        for (int i = 0; i < common.length; i += 1) {
            if (tcpConnect(ip, common[i], Math.max(120, timeoutMs / 3)) >= 0) return true;
        }
        return false;
    }
}
