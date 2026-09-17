'use strict';

/**
 * 本机网络信息与局域网拓扑发现
 * 数据来源：Node 内置 os 模块 + Windows(Linux/macOS) 系统命令
 *   - 网卡 / 地址 / 掩码        : os.networkInterfaces()
 *   - 默认网关 / DNS 服务器     : ipconfig / route(Windows)、ip route(Linux)
 *   - 邻居表（ARP）             : arp -a
 *   - 本地监听端口              : netstat -ano
 *   - 公网出口 IP               : 多源 HTTP 查询（可离线降级）
 *   - 无线/有线链路详情         : netsh wlan show interfaces / iwconfig
 */

const os = require('os');
const { runCommand } = require('./exec');
const { cidrOf, classifyIP, isIPv4 } = require('./iputils');
const geo = require('./geo');
const config = require('../config');

/* ------------------------------------------------------------------ */
/* 网卡                                                                */
/* ------------------------------------------------------------------ */

function listInterfaces() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || !addrs.length) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const family = typeof addr.family === 'string' ? addr.family : `IPv${addr.family}`;
      const cls = classifyIP(addr.address);
      result.push({
        name,
        address: addr.address,
        family,
        mac: addr.mac && addr.mac !== '00:00:00:00:00:00' ? addr.mac : null,
        netmask: addr.netmask,
        cidr: addr.cidr || (family === 'IPv4' ? cidrOf(addr.address, maskToBits(addr.netmask)) : null),
        scopeid: addr.scopeid,
        kind: cls.kind,
        isPrivate: cls.isPrivate,
      });
    }
  }
  return result;
}

function maskToBits(mask) {
  if (!isIPv4(mask)) return 24;
  return mask.split('.').reduce((acc, part) => {
    let v = Number(part);
    let bits = 0;
    while (v) {
      bits += v & 1;
      v >>= 1;
    }
    return acc + bits;
  }, 0);
}

/* ------------------------------------------------------------------ */
/* Windows 系统命令解析                                                */
/* ------------------------------------------------------------------ */

/**
 * 解析 ipconfig /all 输出，抽取网关与 DNS
 * 兼容中文与英文界面；同时兼容冒号被“. . .”填充的写法。
 */
function parseIpconfig(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const adapters = [];
  let current = null;

  for (const line of lines) {
    // 网卡段落标题，例如 "以太网适配器 以太网:" / "Ethernet adapter Ethernet:" / "Wireless LAN adapter WLAN:"
    // 注意：中文“适配器”后面直接跟空格或冒号，不能用 \b（\b 在非 \w 字符之间不成立）
    if (/^\S.*(?:adapter|适配器)\s*[^:：]*[:：]?\s*$/i.test(line) && /(?:adapter|适配器)/i.test(line)) {
      current = {
        name: line.replace(/[:：]\s*$/, '').trim(),
        description: null,
        gateways: [],
        dns: [],
        ipv4: [],
        dhcp: null,
        mac: null,
      };
      adapters.push(current);
      continue;
    }
    if (!current) continue;

    // 标签与值之间可能有 ". . . ." 填充，故用 [\s.·]* 兼容
    const gw = /(?:Default Gateway|默认网关)[\s.·]*[:：]\s*([0-9a-fA-F:.]+)/.exec(line);
    if (gw) current.gateways.push(gw[1].trim());

    const dns = /(?:DNS Servers|DNS 服务器)[\s.·]*[:：]\s*([0-9a-fA-F:.]+)/.exec(line);
    if (dns) current.dns.push(dns[1].trim());
    else {
      // 续行（同一网卡的第二个 DNS 通常单独成行）
      const cont = /^\s{6,}([0-9a-fA-F:.]+)\s*$/.exec(line);
      if (cont && current.dns.length) current.dns.push(cont[1]);
    }

    const ipv4 = /IPv4 (?:Address|地址)[\s.·]*[:：]\s*([0-9.]+)/.exec(line);
    if (ipv4) current.ipv4.push(ipv4[1]);

    const desc = /(?:Description|描述)[\s.·]*[:：]\s*(.+)$/.exec(line);
    if (desc) current.description = desc[1].trim();

    const mac = /(?:Physical Address|物理地址)[\s.·]*[:：]\s*([0-9a-fA-F-]{11,17})/.exec(line);
    if (mac) current.mac = mac[1].trim();
  }

  // 丢弃没有任何地址信息的段落（虚拟适配器、Teredo 等），只保留真实网卡
  return adapters.filter((a) => a.ipv4.length || a.gateways.length);
}

/**
 * 解析 arp -a 输出
 */
function parseArp(text) {
  const neighbors = [];
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const m = /^\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s+([0-9a-fA-F-]{11,17})\s+(\S+)/.exec(line);
    if (!m) continue;
    const ip = m[1];
    if (ip.endsWith('.255') || ip === '255.255.255.255' || ip === '0.0.0.0') continue;
    neighbors.push({
      ip,
      mac: m[2].replace(/-/g, ':').toUpperCase(),
      type: /^(dynamic|动态)$/i.test(m[3]) ? 'dynamic' : 'static',
    });
  }
  return neighbors;
}

/**
 * 解析 netstat -ano 输出，返回监听端口
 *
 * 输出列（Windows）：
 *   TCP   0.0.0.0:135   0.0.0.0:0   LISTENING   1234
 *   UDP   0.0.0.0:500   *:*                       5678
 * 因此 TCP 的状态在第 4 列、PID 在第 5 列；UDP 没有状态列，PID 在第 4 列。
 */
function parseNetstat(text) {
  const listeners = [];
  const seen = new Set();
  for (const rawLine of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    const m = /^(TCP|UDP)\s+(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+(\d+))?\s*$/i.exec(line);
    if (!m) continue;
    const proto = m[1].toUpperCase();
    const local = m[2];
    const col4 = m[4];
    const col5 = m[5];

    let state = null;
    let pid = null;
    if (proto === 'TCP') {
      state = (col4 || '').toUpperCase();
      pid = col5 ? Number.parseInt(col5, 10) : null;
      if (state !== 'LISTENING' && state !== 'LISTEN') continue;
    } else {
      // UDP：col4 即 PID（col5 不存在）
      pid = col4 && /^\d+$/.test(col4) ? Number.parseInt(col4, 10) : col5 ? Number.parseInt(col5, 10) : null;
      state = 'LISTEN';
    }

    const idx = local.lastIndexOf(':');
    if (idx <= 0) continue;
    const addr = local.slice(0, idx);
    const port = Number.parseInt(local.slice(idx + 1), 10);
    if (!Number.isInteger(port)) continue;

    const key = `${proto}:${addr}:${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listeners.push({ proto, address: addr, port, pid, state });
  }
  return listeners.sort((a, b) => a.port - b.port);
}

function parseIpRoute(text) {
  const routes = [];
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)/.exec(line);
    if (!m) continue;
    routes.push({ destination: m[1], netmask: m[2], gateway: m[3], interface: m[4], metric: Number(m[5]) });
  }
  return routes;
}

function parseIfaceRoute(text) {
  // Linux: default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.10 metric 100
  const routes = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^default\s+via\s+([0-9.]+)\s+dev\s+(\S+)(?:\s+.*?metric\s+(\d+))?/.exec(line.trim());
    if (m) routes.push({ destination: '0.0.0.0', gateway: m[1], interface: m[2], metric: m[3] ? Number(m[3]) : 0 });
  }
  return routes;
}

/* ------------------------------------------------------------------ */
/* 公网出口 IP                                                         */
/* ------------------------------------------------------------------ */

const PUBLIC_IP_SOURCES = [
  { name: 'ipwho.is', url: 'https://ipwho.is/', parse: (d) => (d && d.ip ? { ip: d.ip, provider: 'ipwho.is' } : null) },
  { name: 'ipapi.co', url: 'https://ipapi.co/json/', parse: (d) => (d && d.ip ? { ip: d.ip, provider: 'ipapi.co' } : null) },
  { name: 'ipinfo.io', url: 'https://ipinfo.io/json', parse: (d) => (d && d.ip ? { ip: d.ip, provider: 'ipinfo.io' } : null) },
  { name: '3322.org', url: 'http://members.3322.org/dyndns/getip', parse: (t) => (/^\s*(\d{1,3}(?:\.\d{1,3}){3})/.exec(t) ? { ip: RegExp.$1, provider: '3322.org' } : null) },
  { name: 'ident.me', url: 'https://v4.ident.me/', parse: (t) => (/^\s*(\d{1,3}(?:\.\d{1,3}){3})/.exec(t) ? { ip: RegExp.$1, provider: 'ident.me' } : null) },
];

async function detectPublicIP(options = {}) {
  const timeoutMs = options.timeoutMs || 6000;
  const errors = [];
  if (config.geo.enableOnline === false) {
    return { ip: null, provider: null, online: false, note: '在线查询已关闭', errors };
  }
  for (const source of PUBLIC_IP_SOURCES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(source.url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'NetScope/1.0', Accept: 'application/json, text/plain, */*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let parsed = null;
      try {
        parsed = source.parse(JSON.parse(text));
      } catch (_) {
        parsed = source.parse(text);
      }
      if (parsed && isIPv4(parsed.ip)) return { ...parsed, online: true };
      errors.push(`${source.name}: 返回内容无法解析`);
    } catch (error) {
      errors.push(`${source.name}: ${error.name === 'AbortError' ? '超时' : error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ip: null, provider: null, online: false, note: '无法获取公网出口 IP（可能处于离线或受限网络）', errors };
}

/* ------------------------------------------------------------------ */
/* 汇总：本机网络画像                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {{ includeNeighbors?: boolean, includePorts?: boolean, includePublicIP?: boolean, includeRoute?: boolean }} [options]
 */
async function discoverLocalNetwork(options = {}) {
  const includeNeighbors = options.includeNeighbors !== false;
  const includePorts = options.includePorts === true;
  const includePublicIP = options.includePublicIP !== false;
  const includeRoute = options.includeRoute !== false;

  const interfaces = listInterfaces();
  const tasks = [];

  tasks.push(
    (async () => {
      if (process.platform === 'win32') {
        const r = await runCommand('ipconfig', ['/all'], { timeoutMs: 12000 });
        return { ipconfig: r.stdout };
      }
      const r = await runCommand('ip', ['addr'], { timeoutMs: 8000 });
      return { ipconfig: r.stdout };
    })(),
  );

  tasks.push(
    (async () => {
      if (!includeNeighbors) return { arp: '' };
      const r = await runCommand('arp', ['-a'], { timeoutMs: 8000 });
      return { arp: r.stdout };
    })(),
  );

  tasks.push(
    (async () => {
      if (!includePorts) return { netstat: '' };
      const r = await runCommand('netstat', ['-ano'], { timeoutMs: 12000 });
      return { netstat: r.stdout };
    })(),
  );

  tasks.push(
    (async () => {
      if (!includeRoute) return { route: '' };
      if (process.platform === 'win32') {
        const r = await runCommand('route', ['print', '-4'], { timeoutMs: 8000 });
        return { route: r.stdout };
      }
      const r = await runCommand('ip', ['route'], { timeoutMs: 8000 });
      return { route: r.stdout };
    })(),
  );

  const [ipconfigRes, arpRes, netstatRes, routeRes] = await Promise.all(tasks);

  const adapters = parseIpconfig(ipconfigRes.ipconfig);
  // 过滤空值与 IPv6 未指定地址（ipconfig 里 IPv6 缺省网关常显示为 "::"）
  const gateways = [...new Set(adapters.flatMap((a) => a.gateways))].filter((gw) => gw && gw !== '::' && gw !== '0.0.0.0');
  const dnsServers = [...new Set(adapters.flatMap((a) => a.dns))].filter((dns) => dns && dns !== '::');
  const routes = process.platform === 'win32' ? parseIpRoute(routeRes.route) : parseIfaceRoute(routeRes.route);
  const defaultRoute = routes.find((r) => r.destination === '0.0.0.0') || null;
  const neighbors = includeNeighbors ? parseArp(arpRes.arp) : [];
  const listeners = includePorts ? parseNetstat(netstatRes.netstat) : [];

  const publicIP = includePublicIP ? await detectPublicIP() : { ip: null, online: false };

  // 本机位置：优先使用公网出口 IP 的定位，其次回退到时区推断
  const localAnchor = geo.localAnchor();
  let localLocation = {
    lat: localAnchor.lat,
    lon: localAnchor.lon,
    city: localAnchor.city,
    country: localAnchor.country,
    countryCode: localAnchor.countryCode,
    source: 'local-timezone',
    precision: 'city',
  };

  if (publicIP.ip) {
    try {
      const geoInfo = await geo.resolveIP(publicIP.ip);
      if (typeof geoInfo.lat === 'number' && typeof geoInfo.lon === 'number') {
        localLocation = {
          lat: geoInfo.lat,
          lon: geoInfo.lon,
          city: geoInfo.city || localAnchor.city,
          country: geoInfo.country || localAnchor.country,
          countryCode: geoInfo.countryCode || localAnchor.countryCode,
          source: `public-ip:${geoInfo.provider}`,
          precision: geoInfo.precision || 'city',
        };
      }
    } catch (_) {
      /* 保持时区推断结果 */
    }
  }

  const primary = interfaces.find((i) => i.family === 'IPv4' && i.isPrivate) || interfaces.find((i) => i.family === 'IPv4') || null;

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    interfaces,
    adapters,
    gateways,
    dnsServers,
    defaultRoute,
    routes: routes.slice(0, 40),
    neighbors,
    listeners,
    publicIP,
    localLocation,
    subnet: primary ? primary.cidr : null,
    primaryInterface: primary,
    collectedAt: new Date().toISOString(),
  };
}

module.exports = {
  listInterfaces,
  parseIpconfig,
  parseArp,
  parseNetstat,
  parseIpRoute,
  parseIfaceRoute,
  detectPublicIP,
  discoverLocalNetwork,
  maskToBits,
};
