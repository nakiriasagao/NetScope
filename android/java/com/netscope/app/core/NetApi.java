package com.netscope.app.core;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机端 API 实现（与桌面版接口路径、返回结构保持一致）
 *
 * 桌面版的能力在手机上并非全部可行（见各方法注释里标注的「能力边界」），
 * 因此本类遵循两个原则：
 *   1. **能做的就做**：可达性、路由追踪、端口扫描、DNS、公网出口、局域网扫描；
 *   2. **做不到的明确说明**：返回 ok:false + 可读原因，或者返回结果并附 notes，
 *      绝不返回伪造数据（例如中间跳地址）。
 */
public final class NetApi implements NetHttpd.ApiHandler {

    private final ServerInfo server;
    private final Map<String, Object> geoCache = new LinkedHashMap<String, Object>();
    private final Map<String, Object> amapConfig = new LinkedHashMap<String, Object>();

    public NetApi(ServerInfo server) {
        this.server = server;
    }

    @Override
    public Map<String, Object> handle(String method, String path, Map<String, String> query, String body)
            throws Exception {
        if ("/api/health".equals(path)) return health();
        if ("/api/selftest".equals(path)) return selfTest();
        if ("/api/tasks".equals(path)) return map("ok", Boolean.TRUE, "tasks", new ArrayList<Object>());
        if ("/api/diagnose".equals(path)) return diagnose(body);
        if ("/api/trace".equals(path)) return trace(body);
        if ("/api/geo".equals(path)) return geo(body);
        if ("/api/local".equals(path)) return local();
        if ("/api/lanscan".equals(path)) return lanScan(body);
        if ("/api/egress".equals(path)) return egress();
        if ("/api/dns".equals(path)) return dns(body);
        if ("/api/portscan".equals(path)) return portScan(body);
        if ("/api/probe".equals(path)) return probe(body);
        if ("/api/analyze".equals(path)) return analyze(body);
        if ("/api/amap/config".equals(path)) return amapConfig();
        if ("/api/amap/save".equals(path)) return amapSave(body);
        if ("/api/cancel".equals(path)) return map("ok", Boolean.TRUE, "canceled", Boolean.FALSE,
                "message", "手机端探测耗时较短，暂不支持中途取消");
        if ("/api/result".equals(path)) return map("ok", Boolean.FALSE, "error", "手机端不保留历史任务结果");
        if ("/api/security".equals(path)) return notSupported("TLS 证书链检查需要 Java 的证书 API，手机端暂未实现。\n可在桌面版使用该功能。");
        if ("/api/dns/compare".equals(path)) return notSupported("多解析器对比需要枚举系统 DNS 之外的公共解析器，手机端暂未实现。");
        if ("/api/security".equals(path)) return notSupported("暂未实现");
        return notSupported("手机端暂未实现该接口：" + path);
    }

    private static Map<String, Object> notSupported(String reason) {
        return map("ok", Boolean.FALSE, "error", reason, "mobileLimitation", Boolean.TRUE);
    }

    /* ------------------------------------------------------------------ */
    /* 基础信息                                                            */
    /* ------------------------------------------------------------------ */

    private Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ok", Boolean.TRUE);
        m.put("name", "NetScope");
        m.put("version", NetHttpd.VERSION);
        m.put("platform", Env.platform());
        m.put("arch", Env.arch());
        m.put("node", "内置 " + NetHttpd.VERSION + "（无 Node 运行时）");
        m.put("uptimeSec", Long.valueOf(server.uptimeSec()));
        m.put("startedAt", server.startedAtIso());
        m.put("mode", Env.isAndroid() ? "standalone-android" : "standalone-jvm");
        m.put("baseUrl", "http://127.0.0.1:" + server.getPort());
        Map<String, Object> cap = new LinkedHashMap<String, Object>();
        cap.put("trace", Boolean.TRUE);
        cap.put("icmp", Boolean.TRUE);
        cap.put("tcp", Boolean.TRUE);
        cap.put("dns", Boolean.TRUE);
        cap.put("lanScan", Boolean.TRUE);
        cap.put("geo", Boolean.TRUE);
        cap.put("hopAddresses", Boolean.FALSE); // Android 无 root 拿不到中间跳地址
        m.put("capabilities", cap);
        m.put("running", map("traces", Integer.valueOf(0), "scans", Integer.valueOf(0)));
        return m;
    }

    private Map<String, Object> selfTest() throws Exception {
        long started = System.currentTimeMillis();
        List<Object> checks = new ArrayList<Object>();

        // 1) DNS
        long t0 = System.currentTimeMillis();
        String resolved = null;
        try {
            resolved = InetAddress.getByName("www.baidu.com").getHostAddress();
        } catch (Exception e) {
            resolved = null;
        }
        checks.add(check("DNS 解析", resolved != null,
                resolved != null ? "www.baidu.com → " + resolved : "解析失败",
                System.currentTimeMillis() - t0));

        // 2) ICMP
        t0 = System.currentTimeMillis();
        String gw = LocalNet.defaultGateway();
        boolean icmpOk = Probe.hostAlive("223.5.5.5", 1500);
        checks.add(check("ICMP / TCP 可达性", icmpOk,
                icmpOk ? "223.5.5.5 可达" : "无法到达 223.5.5.5（可能被网络策略拦截）",
                System.currentTimeMillis() - t0));

        // 3) 局域网
        t0 = System.currentTimeMillis();
        String myIp = LocalNet.firstIPv4();
        checks.add(check("局域网接口", myIp != null,
                myIp != null ? "本机地址 " + myIp + (gw != null ? "，网关 " + gw : "") : "未检测到可用的 IPv4 接口",
                System.currentTimeMillis() - t0));

        // 4) 公网出口
        t0 = System.currentTimeMillis();
        Map<String, Object> egress = egress();
        Object ip = egress.get("ip");
        checks.add(check("公网出口 IP", ip != null,
                ip != null ? String.valueOf(ip) : "未能获取（无网络或服务不可达）",
                System.currentTimeMillis() - t0));

        // 5) 地理定位
        t0 = System.currentTimeMillis();
        boolean geoOk = false;
        String geoDetail = "未测试";
        if (ip != null) {
            Object g = lookupGeo(String.valueOf(ip));
            geoOk = g instanceof Map && ((Map<?, ?>) g).get("city") != null;
            geoDetail = geoOk ? (String.valueOf(((Map<?, ?>) g).get("city")) + " / " + ((Map<?, ?>) g).get("country")) : "定位服务不可用";
        }
        checks.add(check("地理定位服务", geoOk, geoDetail, System.currentTimeMillis() - t0));

        // 6) 中间跳地址能力（诚实说明限制）
        checks.add(check("逐跳地址解析", false,
                "Android 无 root 时无法读取 ICMP 超时报文来源地址，无法显示中间路由器 IP。"
                        + "手机端可显示目标、RTT 与跳数距离；完整逐跳拓扑请用桌面版。", 0));

        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("durationMs", Long.valueOf(System.currentTimeMillis() - started));
        out.put("checks", checks);
        out.put("platform", "android-standalone");
        int pass = 0;
        for (int i = 0; i < checks.size(); i += 1) {
            Object c = checks.get(i);
            if (c instanceof Map && Boolean.TRUE.equals(((Map<?, ?>) c).get("ok"))) pass += 1;
        }
        out.put("summary", pass + " / " + checks.size() + " 项可用");
        return out;
    }

    private static Map<String, Object> check(String name, boolean ok, String detail, long ms) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("name", name);
        m.put("ok", Boolean.valueOf(ok));
        m.put("detail", detail);
        if (ms > 0) m.put("durationMs", Long.valueOf(ms));
        return m;
    }

    /* ------------------------------------------------------------------ */
    /* 诊断主流程                                                          */
    /* ------------------------------------------------------------------ */

    private Map<String, Object> diagnose(String body) throws Exception {
        String input = firstNonEmpty(Json.getString(body, "target"), Json.getString(body, "input"),
                Json.getString(body, "url"));
        if (input == null) {
            return map("ok", Boolean.FALSE, "error", "缺少 target 参数");
        }
        final int maxHops = Json.getInt(body, "maxHops", 20);
        final int queries = Json.getInt(body, "queries", 2);
        final int timeoutMs = Json.getInt(body, "traceTimeoutMs", 900);
        final boolean doPortScan = Json.getBool(body, "portScan", false);

        long started = System.currentTimeMillis();
        List<String> notes = new ArrayList<String>();

        // 1) 解析目标
        String host = input;
        int schemeIdx = host.indexOf("://");
        if (schemeIdx > 0) host = host.substring(schemeIdx + 3);
        int slash = host.indexOf('/');
        if (slash > 0) host = host.substring(0, slash);
        int colon = host.indexOf(':');
        int port = -1;
        if (colon > 0 && host.indexOf(']') < 0) {
            try {
                port = Integer.parseInt(host.substring(colon + 1));
            } catch (NumberFormatException ignored) {
                port = -1;
            }
            host = host.substring(0, colon);
        }

        String primaryIp = null;
        String resolvedName = null;
        try {
            InetAddress addr = InetAddress.getByName(host);
            primaryIp = addr.getHostAddress();
            if (!primaryIp.equals(host)) resolvedName = addr.getCanonicalHostName();
        } catch (Exception e) {
            notes.add("无法解析 " + host + "：" + e.getMessage());
        }

        Map<String, Object> target = new LinkedHashMap<String, Object>();
        target.put("host", host);
        target.put("port", port > 0 ? Integer.valueOf(port) : null);
        target.put("protocol", schemeIdx > 0 ? input.substring(0, schemeIdx) : null);
        target.put("primaryIP", primaryIp);
        target.put("hostname", resolvedName);
        target.put("isPrivate", Boolean.valueOf(LocalNet.isPrivateIPv4(primaryIp)));

        // 2) 探测（TCP + ICMP）
        Map<String, Object> probe = new LinkedHashMap<String, Object>();
        if (primaryIp != null) {
            boolean alive = Probe.hostAlive(primaryIp, 1500);
            Map<String, Object> ping = new LinkedHashMap<String, Object>();
            ping.put("alive", Boolean.valueOf(alive));
            ping.put("method", "icmp+tcp");
            probe.put("ping", ping);
            List<Object> tcp = new ArrayList<Object>();
            int[] ports = port > 0 ? new int[] { port } : new int[] { 80, 443, 22, 3389, 8080 };
            for (int i = 0; i < ports.length; i += 1) {
                double ms = Probe.tcpConnect(primaryIp, ports[i], 1200);
                Map<String, Object> item = new LinkedHashMap<String, Object>();
                item.put("port", Integer.valueOf(ports[i]));
                item.put("open", Boolean.valueOf(ms >= 0));
                item.put("ms", ms >= 0 ? Double.valueOf(Probe.round1(ms)) : null);
                tcp.add(item);
            }
            probe.put("tcp", tcp);
        }

        // 3) 路由追踪
        Probe.TraceResult tr = Probe.trace(primaryIp != null ? primaryIp : host, maxHops, queries, timeoutMs);
        Map<String, Object> trace = tr.toMap();
        notes.addAll(tr.notes);

        // 4) 地理定位
        Map<String, Object> geo = new LinkedHashMap<String, Object>();
        if (primaryIp != null) {
            Object g = lookupGeo(primaryIp);
            if (g != null) geo.put(primaryIp, g);
        }

        // 5) 本机信息
        Map<String, Object> local = local();

        // 6) 可选端口扫描
        List<Object> portScanList = null;
        if (doPortScan && primaryIp != null) {
            List<Integer> common = new ArrayList<Integer>();
            int[] list = { 21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 993, 995, 1433, 1521, 3306,
                    3389, 5432, 5900, 6379, 8000, 8080, 8443, 9000, 27017 };
            for (int i = 0; i < list.length; i += 1) common.add(Integer.valueOf(list[i]));
            List<Integer> open = Probe.scanPorts(primaryIp, common, 600, 32);
            portScanList = new ArrayList<Object>();
            for (int i = 0; i < open.size(); i += 1) portScanList.add(open.get(i));
        }

        Map<String, Object> result = new LinkedHashMap<String, Object>();
        result.put("ok", Boolean.TRUE);
        result.put("input", input);
        result.put("target", target);
        result.put("probe", probe);
        result.put("trace", trace);
        result.put("geo", geo);
        result.put("portScan", portScanList);
        result.put("local", local);
        result.put("generatedAt", server.startedAtIso());
        result.put("engine", "android-standalone");
        result.put("notes", toObjects(notes));
        result.put("mobileLimitations", toObjects(limitations()));
        result.put("durationMs", Long.valueOf(System.currentTimeMillis() - started));
        result.put("config", map("maxHops", Integer.valueOf(maxHops), "queries", Integer.valueOf(queries), "engine", "android"));
        return result;
    }

    /** 手机端与桌面版的能力差异，随诊断结果一起返回，前端可直接展示 */
    private static List<String> limitations() {
        List<String> out = new ArrayList<String>();
        out.add("手机端无法显示中间路由器的 IP 地址：Android 无 root 权限时读不到 ICMP 超时报文的来源地址。");
        out.add("可确认目标地址、往返时延，以及由回包 TTL 推算出的跳数距离。");
        out.add("需要完整逐跳拓扑与地理位置时，请使用桌面版 NetScope（nx 引擎支持原生套接字）。");
        return out;
    }

    private Map<String, Object> trace(String body) throws Exception {
        String target = Json.getString(body, "target");
        if (target == null) return map("ok", Boolean.FALSE, "error", "缺少 target 参数");
        int maxHops = Json.getInt(body, "maxHops", 20);
        int queries = Json.getInt(body, "queries", 2);
        int timeoutMs = Json.getInt(body, "traceTimeoutMs", 900);
        Probe.TraceResult tr = Probe.trace(target, maxHops, queries, timeoutMs);
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ok", Boolean.TRUE);
        m.put("trace", tr.toMap());
        m.put("mobileLimitations", toObjects(limitations()));
        return m;
    }

    private Map<String, Object> probe(String body) throws Exception {
        String target = Json.getString(body, "target");
        if (target == null) return map("ok", Boolean.FALSE, "error", "缺少 target 参数");
        String ip = InetAddress.getByName(target).getHostAddress();
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ok", Boolean.TRUE);
        m.put("ip", ip);
        m.put("alive", Boolean.valueOf(Probe.hostAlive(ip, 1500)));
        return m;
    }

    private Map<String, Object> analyze(String body) throws Exception {
        String input = Json.getString(body, "target");
        if (input == null) return map("ok", Boolean.FALSE, "error", "缺少 target 参数");
        String host = input;
        int schemeIdx = host.indexOf("://");
        if (schemeIdx > 0) host = host.substring(schemeIdx + 3);
        int slash = host.indexOf('/');
        if (slash > 0) host = host.substring(0, slash);
        String ip = InetAddress.getByName(host).getHostAddress();
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ok", Boolean.TRUE);
        m.put("host", host);
        m.put("primaryIP", ip);
        m.put("isPrivate", Boolean.valueOf(LocalNet.isPrivateIPv4(ip)));
        return m;
    }

    /* ------------------------------------------------------------------ */
    /* 端口扫描 / DNS / 局域网                                             */
    /* ------------------------------------------------------------------ */

    private Map<String, Object> portScan(String body) throws Exception {
        String target = Json.getString(body, "target");
        if (target == null) return map("ok", Boolean.FALSE, "error", "缺少 target 参数");
        String ip = InetAddress.getByName(target).getHostAddress();
        List<Integer> ports = new ArrayList<Integer>();
        String custom = Json.getString(body, "ports");
        if (custom != null) {
            String[] parts = custom.split("[,\\s]+");
            for (int i = 0; i < parts.length; i += 1) {
                try {
                    int p = Integer.parseInt(parts[i].trim());
                    if (p > 0 && p <= 65535) ports.add(Integer.valueOf(p));
                } catch (NumberFormatException ignored) {
                    /* 跳过非法项 */
                }
            }
        }
        int from = Json.getInt(body, "from", 1);
        int to = Json.getInt(body, "to", 0);
        if (ports.isEmpty() && to >= from && to > 0) {
            for (int p = from; p <= to && ports.size() < 2048; p += 1) ports.add(Integer.valueOf(p));
        }
        if (ports.isEmpty()) {
            int[] common = { 21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 993, 1433, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 27017 };
            for (int i = 0; i < common.length; i += 1) ports.add(Integer.valueOf(common[i]));
        }
        long started = System.currentTimeMillis();
        List<Integer> open = Probe.scanPorts(ip, ports, 700, 64);
        List<Object> results = new ArrayList<Object>();
        for (int i = 0; i < ports.size(); i += 1) {
            int p = ports.get(i).intValue();
            boolean isOpen = open.contains(Integer.valueOf(p));
            Map<String, Object> item = new LinkedHashMap<String, Object>();
            item.put("port", Integer.valueOf(p));
            item.put("open", Boolean.valueOf(isOpen));
            if (isOpen) {
                double ms = Probe.tcpConnect(ip, p, 800);
                item.put("ms", ms >= 0 ? Double.valueOf(Probe.round1(ms)) : null);
            }
            results.add(item);
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ok", Boolean.TRUE);
        m.put("host", ip);
        m.put("scanned", Integer.valueOf(ports.size()));
        m.put("openCount", Integer.valueOf(open.size()));
        m.put("results", results);
        m.put("durationMs", Long.valueOf(System.currentTimeMillis() - started));
        return m;
    }

    private Map<String, Object> dns(String body) throws Exception {
        String target = Json.getString(body, "target");
        if (target == null) return map("ok", Boolean.FALSE, "error", "缺少 target 参数");
        long started = System.currentTimeMillis();
        List<Object> records = new ArrayList<Object>();
        try {
            InetAddress[] all = InetAddress.getAllByName(target);
            for (int i = 0; i < all.length; i += 1) {
                Map<String, Object> r = new LinkedHashMap<String, Object>();
                r.put("type", all[i] instanceof java.net.Inet4Address ? "A" : "AAAA");
                r.put("value", all[i].getHostAddress());
                records.add(r);
            }
        } catch (Exception e) {
            return map("ok", Boolean.FALSE, "error", "解析失败：" + e.getMessage());
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ok", Boolean.TRUE);
        m.put("host", target);
        m.put("records", records);
        m.put("dnsServers", toObjects(LocalNet.dnsServers()));
        m.put("durationMs", Long.valueOf(System.currentTimeMillis() - started));
        m.put("note", "手机端使用系统解析器（Java InetAddress），不查询 TXT/MX 等记录类型");
        return m;
    }

    private Map<String, Object> local() throws Exception {
        List<LocalNet.Iface> ifaces = LocalNet.interfaces();
        List<Object> interfaces = new ArrayList<Object>();
        for (int i = 0; i < ifaces.size(); i += 1) {
            LocalNet.Iface f = ifaces.get(i);
            Map<String, Object> item = new LinkedHashMap<String, Object>();
            item.put("name", f.name);
            item.put("ip", f.ip);
            item.put("mac", f.mac);
            item.put("subnet", LocalNet.subnetOf(f.ip, f.prefixLen));
            interfaces.add(item);
        }
        String myIp = ifaces.isEmpty() ? null : ifaces.get(0).ip;
        String gw = LocalNet.defaultGateway();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("hostname", Env.model());
        out.put("platform", Env.platform());
        out.put("interfaces", interfaces);
        out.put("self", myIp == null ? new ArrayList<Object>()
                : toObjects(java.util.Collections.singletonList(myIp)));
        out.put("subnet", myIp == null ? null : LocalNet.subnetOf(myIp, 24));
        out.put("gateways", gw == null ? new ArrayList<Object>()
                : toObjects(java.util.Collections.singletonList(gw)));
        out.put("dnsServers", toObjects(LocalNet.dnsServers()));
        out.put("neighbors", new ArrayList<Object>());
        out.put("listeners", new ArrayList<Object>());
        out.put("publicIP", null);
        out.put("note", "手机端不提供本机监听端口列表（Android 限制）");
        return out;
    }

    private Map<String, Object> lanScan(String body) throws Exception {
        boolean deep = Json.getBool(body, "deep", true);
        int timeoutMs = Json.getInt(body, "timeoutMs", 600);
        long started = System.currentTimeMillis();

        String myIp = LocalNet.firstIPv4();
        String gw = LocalNet.defaultGateway();
        Map<String, String> arp = LocalNet.arpTable();

        List<Object> devices = new ArrayList<Object>();
        List<String> alive = new ArrayList<String>();

        if (deep && myIp != null) {
            List<String> candidates = LocalNet.expand24(myIp);
            final List<String> found = java.util.Collections.synchronizedList(new ArrayList<String>());
            final java.util.concurrent.atomic.AtomicInteger idx = new java.util.concurrent.atomic.AtomicInteger(0);
            int workers = 32;
            Thread[] threads = new Thread[workers];
            for (int i = 0; i < workers; i += 1) {
                threads[i] = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        while (true) {
                            int n = idx.getAndIncrement();
                            if (n >= candidates.size()) return;
                            String ip = candidates.get(n);
                            if (Probe.hostAlive(ip, 500)) found.add(ip);
                        }
                    }
                });
                threads[i].setDaemon(true);
                threads[i].start();
            }
            for (int i = 0; i < workers; i += 1) {
                threads[i].join(120000);
            }
            List<String> sorted = new ArrayList<String>(found);
            java.util.Collections.sort(sorted, new java.util.Comparator<String>() {
                @Override
                public int compare(String a, String b) {
                    return ipToLong(a) < ipToLong(b) ? -1 : (ipToLong(a) > ipToLong(b) ? 1 : 0);
                }
            });
            alive.addAll(sorted);
        }
        // 把 ARP 表里的设备也纳入
        for (Map.Entry<String, String> e : arp.entrySet()) {
            if (!alive.contains(e.getKey()) && !LocalNet.isMulticastIPv4(e.getKey())) alive.add(e.getKey());
        }

        for (int i = 0; i < alive.size(); i += 1) {
            String ip = alive.get(i);
            if (ip.equals(myIp)) continue;
            Map<String, Object> d = new LinkedHashMap<String, Object>();
            d.put("ip", ip);
            d.put("mac", arp.get(ip));
            d.put("vendor", null);
            d.put("hostname", null);
            d.put("isGateway", Boolean.valueOf(ip.equals(gw)));
            d.put("type", ip.equals(gw) ? "gateway" : "device");
            d.put("typeLabel", ip.equals(gw) ? "网关 / 路由器" : "设备");
            devices.add(d);
        }

        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.TRUE);
        out.put("self", myIp == null ? new ArrayList<Object>() : toObjects(java.util.Collections.singletonList(myIp)));
        out.put("subnet", myIp == null ? null : LocalNet.subnetOf(myIp, 24));
        out.put("gateway", gw);
        out.put("devices", devices);
        out.put("ssdp", new ArrayList<Object>());
        out.put("mdns", new ArrayList<Object>());
        Map<String, Object> scanned = new LinkedHashMap<String, Object>();
        scanned.put("hosts", Integer.valueOf(deep && myIp != null ? 254 : 0));
        scanned.put("alive", Integer.valueOf(alive.size()));
        scanned.put("durationMs", Long.valueOf(System.currentTimeMillis() - started));
        out.put("scanned", scanned);
        out.put("notes", toObjects(scanNotes(arp.isEmpty())));
        return out;
    }

    private static List<String> scanNotes(boolean arpEmpty) {
        List<String> out = new ArrayList<String>();
        out.add("Android 10 起系统不再向普通应用暴露 ARP 表，因此 MAC 地址与厂商信息可能缺失。");
        if (arpEmpty) out.add("本次未读到 ARP 表，设备识别仅依赖 TCP/ICMP 存活探测。");
        out.add("SSDP / mDNS 组播发现需要使用 MulticastLock，手机端暂未启用。");
        return out;
    }

    private static long ipToLong(String ip) {
        try {
            String[] p = ip.split("\\.");
            return (Long.parseLong(p[0]) << 24) | (Long.parseLong(p[1]) << 16)
                    | (Long.parseLong(p[2]) << 8) | Long.parseLong(p[3]);
        } catch (Exception e) {
            return 0;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 公网出口 / 地理定位                                                 */
    /* ------------------------------------------------------------------ */

    private Map<String, Object> egress() {
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        String ip = httpGetText("https://api.ipify.org");
        if (ip == null) ip = httpGetText("https://ifconfig.me/ip");
        if (ip == null) ip = httpGetText("https://ipinfo.io/ip");
        out.put("ok", Boolean.valueOf(ip != null));
        out.put("ip", ip);
        out.put("provider", ip != null ? "public-ip-service" : null);
        out.put("location", ip != null ? lookupGeo(ip) : null);
        return out;
    }

    private Map<String, Object> geo(String body) throws Exception {
        String ip = Json.getString(body, "ip");
        if (ip == null) {
            Map<String, Object> e = egress();
            ip = e.get("ip") == null ? null : String.valueOf(e.get("ip"));
        }
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("ok", Boolean.valueOf(ip != null));
        out.put("ip", ip);
        out.put("location", ip != null ? lookupGeo(ip) : null);
        return out;
    }

    /** 查询 IP 地理位置（带内存缓存） */
    private Object lookupGeo(String ip) {
        if (ip == null) return null;
        synchronized (geoCache) {
            if (geoCache.containsKey(ip)) return geoCache.get(ip);
        }
        Object result = null;
        String text = httpGetText("https://ipwho.is/" + ip);
        if (text != null) result = parseGeoWhois(text, ip);
        if (result == null) {
            text = httpGetText("https://ipapi.co/" + ip + "/json/");
            if (text != null) result = parseIpApi(text, ip);
        }
        if (result != null) {
            synchronized (geoCache) {
                geoCache.put(ip, result);
            }
        }
        return result;
    }

    private static Object parseGeoWhois(String json, String ip) {
        if (json.indexOf("\"success\":false") >= 0) return null;
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ip", ip);
        m.put("city", Json.getString(json, "city"));
        m.put("region", Json.getString(json, "region"));
        m.put("country", Json.getString(json, "country"));
        m.put("countryCode", Json.getString(json, "country_code"));
        String lat = Json.getString(json, "latitude");
        String lon = Json.getString(json, "longitude");
        if (lat == null || lon == null) return null;
        try {
            m.put("lat", Double.valueOf(Double.parseDouble(lat)));
            m.put("lon", Double.valueOf(Double.parseDouble(lon)));
        } catch (NumberFormatException e) {
            return null;
        }
        // connection.isp 是嵌套结构，做一次简易提取
        int ispIdx = json.indexOf("\"isp\"");
        if (ispIdx > 0) {
            String isp = Json.getString(json.substring(ispIdx), "isp");
            if (isp != null) m.put("isp", isp);
        }
        m.put("provider", "ipwho.is");
        m.put("status", LocalNet.isPrivateIPv4(ip) ? "private" : "public");
        return m;
    }

    private static Object parseIpApi(String json, String ip) {
        String lat = Json.getString(json, "latitude");
        String lon = Json.getString(json, "longitude");
        if (lat == null || lon == null) return null;
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ip", ip);
        m.put("city", Json.getString(json, "city"));
        m.put("region", Json.getString(json, "region"));
        m.put("country", Json.getString(json, "country_name"));
        m.put("countryCode", Json.getString(json, "country_code"));
        try {
            m.put("lat", Double.valueOf(Double.parseDouble(lat)));
            m.put("lon", Double.valueOf(Double.parseDouble(lon)));
        } catch (NumberFormatException e) {
            return null;
        }
        m.put("isp", Json.getString(json, "org"));
        m.put("provider", "ipapi.co");
        m.put("status", LocalNet.isPrivateIPv4(ip) ? "private" : "public");
        return m;
    }

    /** 简易 HTTPS GET（只用 JDK 自带能力） */
    private static String httpGetText(String url) {
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL u = new java.net.URL(url);
            conn = (java.net.HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("User-Agent", "NetScope-Android/1.0");
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) return null;
            java.io.InputStream in = conn.getInputStream();
            ByteArrayOutputStreamHelper helper = new ByteArrayOutputStreamHelper();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) helper.write(buf, 0, n);
            in.close();
            String text = helper.asString();
            return text.length() > 8192 ? text.substring(0, 8192) : text;
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 小工具：避免直接依赖 java.io.ByteArrayOutputStream 的重复样板 */
    private static final class ByteArrayOutputStreamHelper {
        private final java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();

        void write(byte[] b, int off, int len) {
            bos.write(b, off, len);
        }

        String asString() throws Exception {
            return new String(bos.toByteArray(), "UTF-8");
        }
    }

    /* ------------------------------------------------------------------ */
    /* 高德配置（手机端仅保存于内存，供将来扩展）                            */
    /* ------------------------------------------------------------------ */

    private Map<String, Object> amapConfig() {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("ok", Boolean.TRUE);
        Map<String, Object> cfg = new LinkedHashMap<String, Object>();
        cfg.put("configured", Boolean.valueOf(!amapConfig.isEmpty()));
        cfg.put("enabled", Boolean.valueOf(!amapConfig.isEmpty()));
        cfg.put("keyMasked", amapConfig.containsKey("key") ? mask(String.valueOf(amapConfig.get("key"))) : null);
        cfg.put("hasSecurity", Boolean.valueOf(amapConfig.containsKey("security")));
        m.put("config", cfg);
        m.put("note", "手机端保存的高德 Key 仅存在于内存，重启应用后需重新填写");
        return m;
    }

    private Map<String, Object> amapSave(String body) {
        String key = Json.getString(body, "key");
        String security = Json.getString(body, "security");
        if (key != null) amapConfig.put("key", key);
        if (security != null) amapConfig.put("security", security);
        return map("ok", Boolean.TRUE, "saved", Boolean.TRUE);
    }

    /** 供 WebView 注入使用：把高德 Key 下发给前端 */
    public Map<String, Object> amapCredentials() {
        return new LinkedHashMap<String, Object>(amapConfig);
    }

    private static String mask(String key) {
        if (key == null || key.length() < 10) return null;
        return key.substring(0, 6) + "…" + key.substring(key.length() - 4);
    }

    /* ------------------------------------------------------------------ */
    /* 小工具                                                              */
    /* ------------------------------------------------------------------ */

    static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            m.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return m;
    }

    private static List<Object> toObjects(List<?> src) {
        List<Object> out = new ArrayList<Object>();
        if (src != null) {
            for (int i = 0; i < src.size(); i += 1) out.add(src.get(i));
        }
        return out;
    }

    private static String firstNonEmpty(String... values) {
        for (int i = 0; i < values.length; i += 1) {
            if (values[i] != null && values[i].length() > 0) return values[i];
        }
        return null;
    }
}
