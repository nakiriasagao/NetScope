package com.netscope.app.core;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PushbackInputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 本机网络信息（纯 Java 实现，Android 上可直接用）
 *
 * 对应桌面版的 src/core/sysinfo.js，提供：
 *   · 网卡地址与掩码
 *   · 默认网关
 *   · DNS 服务器
 *   · 局域网邻居（尽力而为：Android 10+ 已限制读取 ARP 表）
 */
public final class LocalNet {

    private LocalNet() {
    }

    /** 网卡信息 */
    public static final class Iface {
        public String name;
        public String ip;
        public int prefixLen = 24;
        public String mac;
    }

    /** 收集本机 IPv4 网卡 */
    public static List<Iface> interfaces() {
        List<Iface> out = new ArrayList<Iface>();
        try {
            Enumeration<NetworkInterface> nis = NetworkInterface.getNetworkInterfaces();
            while (nis != null && nis.hasMoreElements()) {
                NetworkInterface ni = nis.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                String ipv4 = null;
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a instanceof Inet4Address && !a.isLoopbackAddress()) {
                        ipv4 = a.getHostAddress();
                        break;
                    }
                }
                if (ipv4 == null) continue;
                Iface item = new Iface();
                item.name = ni.getDisplayName() == null ? ni.getName() : ni.getDisplayName();
                item.ip = ipv4;
                item.mac = formatMac(ni.getHardwareAddress());
                item.prefixLen = 24;
                out.add(item);
            }
        } catch (Exception e) {
            /* 返回已收集到的部分 */
        }
        return out;
    }

    public static String firstIPv4() {
        List<Iface> list = interfaces();
        return list.isEmpty() ? null : list.get(0).ip;
    }

    public static String formatMac(byte[] mac) {
        if (mac == null || mac.length == 0) return null;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < mac.length; i += 1) {
            if (i > 0) sb.append(':');
            sb.append(String.format("%02X", Byte.valueOf(mac[i])));
        }
        return sb.toString();
    }

    /** 由 IP 与掩码前缀推导网段（如 192.168.1.0/24） */
    public static String subnetOf(String ip, int prefixLen) {
        if (ip == null) return null;
        String[] parts = ip.split("\\.");
        if (parts.length != 4) return null;
        int addr = 0;
        for (int i = 0; i < 4; i += 1) {
            addr = (addr << 8) | (Integer.parseInt(parts[i]) & 0xFF);
        }
        int mask = prefixLen == 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen));
        int base = addr & mask;
        return ((base >>> 24) & 0xFF) + "." + ((base >>> 16) & 0xFF) + "." + ((base >>> 8) & 0xFF)
                + "." + (base & 0xFF) + "/" + prefixLen;
    }

    /**
     * 读取 ARP 表（尽力而为）
     *
     * Android 10 起 /proc/net/arp 对普通应用不可读，此时返回空表，
     * 上层会退化为"仅按 TCP 探测判断存活"。
     */
    public static Map<String, String> arpTable() {
        Map<String, String> table = new LinkedHashMap<String, String>();
        InputStream in = null;
        try {
            in = new java.io.FileInputStream("/proc/net/arp");
            byte[] buf = new byte[8192];
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            String text = new String(bos.toByteArray(), "UTF-8");
            String[] lines = text.split("\n");
            for (int i = 1; i < lines.length; i += 1) {
                String[] cols = lines[i].trim().split("\\s+");
                if (cols.length < 4) continue;
                String ip = cols[0];
                String mac = cols[3];
                if ("00:00:00:00:00:00".equals(mac)) continue;
                if (!ip.matches("\\d+\\.\\d+\\.\\d+\\.\\d+")) continue;
                table.put(ip, mac.toUpperCase());
            }
        } catch (Exception e) {
            /* 不可读时返回空表 */
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    /* ignore */
                }
            }
        }
        return table;
    }

    /** 读取默认网关（/proc/net/route，Android 上通常可读） */
    public static String defaultGateway() {
        InputStream in = null;
        try {
            in = new java.io.FileInputStream("/proc/net/route");
            byte[] buf = new byte[8192];
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            String text = new String(bos.toByteArray(), "UTF-8");
            String[] lines = text.split("\n");
            for (int i = 1; i < lines.length; i += 1) {
                String[] cols = lines[i].trim().split("\\s+");
                if (cols.length < 3) continue;
                // 目的地址 00000000 表示默认路由，网关以小端十六进制给出
                if (!"00000000".equals(cols[1])) continue;
                String hex = cols[2];
                if (hex.length() != 8) continue;
                int g = (int) Long.parseLong(hex, 16);
                return (g & 0xFF) + "." + ((g >> 8) & 0xFF) + "." + ((g >> 16) & 0xFF) + "." + ((g >> 24) & 0xFF);
            }
        } catch (Exception e) {
            /* ignore */
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    /* ignore */
                }
            }
        }
        return null;
    }

    /** 读取 DNS 服务器（Android 上同样从 /proc/net 或属性读取，失败返回空） */
    public static List<String> dnsServers() {
        List<String> out = new ArrayList<String>();
        // 尝试常见位置：/system/etc/resolv.conf 与 net.dns 属性
        for (String path : new String[] { "/system/etc/resolv.conf", "/etc/resolv.conf" }) {
            InputStream in = null;
            try {
                in = new java.io.FileInputStream(path);
                byte[] buf = new byte[4096];
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                String text = new String(bos.toByteArray(), "UTF-8");
                String[] lines = text.split("\n");
                for (int i = 0; i < lines.length; i += 1) {
                    String line = lines[i].trim();
                    if (!line.startsWith("nameserver")) continue;
                    String[] parts = line.split("\\s+");
                    if (parts.length >= 2 && parts[1].matches("\\d+\\.\\d+\\.\\d+\\.\\d+")) {
                        if (!out.contains(parts[1])) out.add(parts[1]);
                    }
                }
            } catch (Exception e) {
                /* 继续尝试下一个路径 */
            } finally {
                if (in != null) {
                    try {
                        in.close();
                    } catch (Exception ignored) {
                        /* ignore */
                    }
                }
            }
            if (!out.isEmpty()) break;
        }
        return out;
    }

    /** 探测网关是否可达（用于判断是否处于局域网） */
    public static boolean gatewayReachable(String gateway, int timeoutMs) {
        if (gateway == null) return false;
        return Probe.tcpConnect(gateway, 80, timeoutMs) >= 0
                || Probe.tcpConnect(gateway, 53, timeoutMs) >= 0
                || Probe.hostAlive(gateway, timeoutMs);
    }

    /** 把 /24 网段展开成 IP 列表 */
    public static List<String> expand24(String baseIp) {
        List<String> out = new ArrayList<String>();
        String[] parts = baseIp.split("\\.");
        if (parts.length != 4) return out;
        String prefix = parts[0] + "." + parts[1] + "." + parts[2] + ".";
        for (int i = 1; i <= 254; i += 1) out.add(prefix + i);
        return out;
    }

    /** 安全关闭 */
    public static void closeQuietly(Socket socket) {
        if (socket == null) return;
        try {
            socket.close();
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    /** 安全的只读副本 */
    public static <T> List<T> safeList(List<T> list) {
        return list == null ? Collections.<T>emptyList() : list;
    }

    static void closeQuietly(OutputStream out) {
        if (out == null) return;
        try {
            out.close();
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    static String readLine(PushbackInputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) >= 0) {
            if (b == '\n') break;
            if (b != '\r') bos.write(b);
            if (bos.size() > 8192) break;
        }
        if (b < 0 && bos.size() == 0) return null;
        return new String(bos.toByteArray(), "UTF-8");
    }

    /** 判断是否为私有地址 */
    public static boolean isPrivateIPv4(String ip) {
        if (ip == null) return false;
        String[] p = ip.split("\\.");
        if (p.length != 4) return false;
        try {
            int a = Integer.parseInt(p[0]);
            int b = Integer.parseInt(p[1]);
            if (a == 10) return true;
            if (a == 172 && b >= 16 && b <= 31) return true;
            if (a == 192 && b == 168) return true;
            if (a == 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
            if (a == 127) return true;
            return false;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /** 判断是否为多播地址（这类地址不是设备，需过滤） */
    public static boolean isMulticastIPv4(String ip) {
        if (ip == null) return false;
        String[] p = ip.split("\\.");
        if (p.length != 4) return false;
        try {
            int a = Integer.parseInt(p[0]);
            return a >= 224 && a <= 239;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    static void ignore(SocketException e) {
        /* 占位：避免未使用告警 */
    }
}
