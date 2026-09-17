'use strict';

/**
 * 局域网设备发现（LAN 拓扑扫描）
 *
 * 目标：把"当前网络里有哪些设备、它们是谁、局域网地址是多少"搞清楚，供前端画星型拓扑图。
 *
 * 数据来源（逐层递进，任一失败都不影响整体）：
 *   1. ARP/邻居表        —— 系统缓存，最快，无需主动发包（Windows: arp -a）
 *   2. 网段存活探测      —— 对 /24（可配置为 /16 的部分）做 TCP 连接探测，
 *                           目的是填充 ARP 缓存（并发可控，避免打爆网络）
 *   3. 反向 DNS          —— 把 IP 解析成主机名
 *   4. NetBIOS 名称查询  —— Windows 环境下可拿到中文计算机名（nbtstat）
 *   5. SSDP（UPnP）发现  —— 组播 M-SEARCH，可拿到智能电视/路由器/NAS 的设备描述
 *   6. mDNS 查询         —— 组播查询常见服务类型，可拿到打印机/投屏设备
 *   7. MAC OUI 厂商识别  —— 通过内置前缀表判断设备厂商
 *   8. 设备类型推断      —— 综合 MAC 厂商、主机名、开放端口、SSDP 描述推断类型
 *
 * 所有主动探测都有并发上限与超时，默认总耗时控制在 10~30 秒。
 */

const os = require('os');
const dgram = require('dgram');
const net = require('net');
const { runCommand } = require('./exec');
const { parseArp, listInterfaces, maskToBits } = require('./sysinfo');
const { reverseLookup } = require('./reachability');
const { ipv4ToInt } = require('./iputils');
const OUI = require('../data/oui-vendors');

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function classifyDeviceType({ vendor, hostname, ssdp, ports, isGateway, isSelf }) {
  if (isSelf) return { type: 'self', label: '本机' };
  if (isGateway) return { type: 'gateway', label: '网关/路由器' };

  const haystack = `${vendor || ''} ${hostname || ''} ${(ssdp && ssdp.server) || ''} ${(ssdp && ssdp.modelName) || ''} ${(ssdp && ssdp.friendlyName) || ''}`.toLowerCase();

  const rules = [
    { type: 'printer', label: '打印机', test: /printer|hewlett|epson|canon|brother|lexmark|打印/ },
    { type: 'nas', label: 'NAS/存储', test: /synology|qnap|western digital|nas|diskstation|存储/ },
    { type: 'camera', label: '摄像头', test: /camera|hikvision|dahua|ipc|webcam|摄像/ },
    { type: 'tv', label: '电视/投屏', test: /tv|television|roku|chromecast|appletv|xiaomi.*tv|smarttv|电视/ },
    { type: 'phone', label: '手机/平板', test: /iphone|ipad|android|huawei|xiaomi|oppo|vivo|phone|mobile|手机|平板/ },
    { type: 'router', label: '路由器/AP', test: /router|gateway|access point|ap-|tplink|tp-link|asus|netgear|dlink|d-link|openwrt|路由/ },
    { type: 'iot', label: 'IoT 设备', test: /iot|esp|tuya|smart|plug|bulb|sensor|ewelink|智能/ },
    { type: 'virtual', label: '虚拟网卡/隧道', test: /virtual|vmware|virtualbox|hyper-v|tap|tun|wsl|docker|雷电模拟/ },
    { type: 'computer', label: '电脑/服务器', test: /desktop|pc|computer|laptop|macbook|thinkpad|server|x64|电脑|服务/ },
  ];
  for (const rule of rules) {
    if (rule.test.test(haystack)) return { type: rule.type, label: rule.label };
  }
  // 用端口特征兜底
  const portSet = new Set(ports || []);
  if (portSet.has(9100) || portSet.has(515) || portSet.has(631)) return { type: 'printer', label: '打印机' };
  if (portSet.has(3306) || portSet.has(5432) || portSet.has(1433) || portSet.has(6379)) return { type: 'server', label: '数据库/服务器' };
  if (portSet.has(5000) || portSet.has(8123)) return { type: 'iot', label: 'IoT 设备' };
  if (/^(and|android|iphone|ipad)/i.test(hostname || '')) return { type: 'phone', label: '手机/平板' };
  if (hostname) return { type: 'computer', label: '电脑/设备' };
  return { type: 'unknown', label: '未知设备' };
}

/**
 * 通过内置 OUI 表识别 MAC 厂商（键统一为 6 位大写十六进制）
 * @returns {{ vendor: string|null, local: boolean, prefix: string|null }}
 *   local=true 表示这是"本地管理地址"（第二位最低有效位为 1），
 *   常见于虚拟机、随机化 MAC、Mesh 节点，不会出现在 IEEE 分配表中
 */
function lookupVendorInfo(mac) {
  if (!mac) return { vendor: null, local: false, prefix: null };
  const normalized = String(mac).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (normalized.length < 6) return { vendor: null, local: false, prefix: null };
  const prefix = normalized.slice(0, 6);
  const firstOctet = Number.parseInt(prefix.slice(0, 2), 16);
  const local = Number.isInteger(firstOctet) && (firstOctet & 0x02) !== 0;
  return { vendor: OUI[prefix] || null, local, prefix };
}

/** 兼容旧接口：只返回厂商名 */
function lookupVendor(mac) {
  return lookupVendorInfo(mac).vendor;
}

/* ------------------------------------------------------------------ */
/* 网段存活探测                                                        */
/* ------------------------------------------------------------------ */

/**
 * 对网段内的主机做存活探测
 *
 * 探测方式：优先 TCP 连接常见端口（80/443/445/22/8080…），
 * 因为很多设备（尤其 Windows）默认丢弃 ICMP，但会响应 TCP SYN；
 * 连接成功或收到 RST（ECONNREFUSED）都算"主机存活"。
 * 目的之一是让系统 ARP 缓存里出现这些主机，从而在邻居表中被读到。
 */
function probeHostAlive(ip, ports, timeoutMs) {
  return new Promise((resolve) => {
    let pending = ports.length;
    let done = false;
    const finish = (alive, viaPort) => {
      if (done) return;
      done = true;
      resolve({ ip, alive, viaPort: viaPort || null });
    };
    if (!pending) {
      finish(false, null);
      return;
    }
    for (const port of ports) {
      const socket = new net.Socket();
      let settled = false;
      const complete = (alive, viaPort) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        pending -= 1;
        if (alive) finish(true, viaPort);
        else if (pending === 0) finish(false, null);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => complete(true, port));
      socket.once('timeout', () => complete(false, null));
      socket.once('error', (error) => {
        // RST 说明主机在线但端口关闭；其它错误（EHOSTUNREACH/ENETUNREACH）视为不在线
        const reachable = error.code === 'ECONNREFUSED';
        complete(reachable, reachable ? port : null);
      });
      try {
        socket.connect(port, ip);
      } catch (_) {
        complete(false, null);
      }
    }
  });
}

function* iterateHosts(networkInt, prefixBits, maxHosts) {
  const hostBits = 32 - prefixBits;
  const total = Math.min(2 ** hostBits - 2, maxHosts);
  const base = networkInt + 1;
  for (let i = 0; i < total; i += 1) {
    const value = base + i;
    yield `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
  }
}

/**
 * 扫描局域网
 * @param {{ deep?: boolean, maxHosts?: number, concurrency?: number, timeoutMs?: number, includeSsdp?: boolean, includeMdns?: boolean, onProgress?: Function, signal?: AbortSignal }} options
 */
async function scanLan(options = {}) {
  const started = Date.now();
  const deep = options.deep !== false;
  const maxHosts = options.maxHosts || 512;
  const concurrency = options.concurrency || 64;
  const timeoutMs = options.timeoutMs || 800;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal;

  const result = {
    ok: true,
    startedAt: new Date().toISOString(),
    interfaces: [],
    gateway: null,
    self: [],
    devices: [],
    ssdp: [],
    mdns: [],
    subnet: null,
    scanned: { hosts: 0, alive: 0, durationMs: 0 },
    notes: [],
  };

  /* ---------- 1) 本机信息与网段 ---------- */
  const interfaces = listInterfaces();
  result.interfaces = interfaces;

  const adaptersInfo = await runCommand('ipconfig', ['/all'], { timeoutMs: 12000 });
  const gateways = [];
  const adapterText = adaptersInfo.stdout || '';
  const gatewayRe = /(?:Default Gateway|默认网关)[\s.·]*[:：]\s*([0-9.]+)/g;
  let gm;
  while ((gm = gatewayRe.exec(adapterText)) !== null) {
    if (gm[1] !== '0.0.0.0' && !gateways.includes(gm[1])) gateways.push(gm[1]);
  }
  if (!gateways.length) {
    const routeRes = await runCommand('route', ['print', '-4'], { timeoutMs: 8000 });
    const routeMatch = /\n\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)/.exec(routeRes.stdout || '');
    if (routeMatch) gateways.push(routeMatch[1]);
  }
  result.gateway = gateways[0] || null;

  // 选取一个私有 IPv4 作为主网段
  const primary = interfaces.find((i) => i.family === 'IPv4' && i.isPrivate && !i.address.startsWith('169.254.'))
    || interfaces.find((i) => i.family === 'IPv4' && i.isPrivate)
    || null;
  result.self = interfaces.filter((i) => i.family === 'IPv4').map((i) => ({ ip: i.address, mac: i.mac, name: i.name, cidr: i.cidr }));

  let hostIterator = null;
  if (primary && deep) {
    const prefixBits = maskToBits(primary.netmask) || 24;
    const networkInt = ipv4ToInt(primary.address) & (prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0);
    result.subnet = `${(networkInt >>> 24) & 255}.${(networkInt >>> 16) & 255}.${(networkInt >>> 8) & 255}.${networkInt & 255}/${prefixBits}`;
    hostIterator = iterateHosts(networkInt >>> 0, prefixBits, maxHosts);
    result.notes.push(`对本机所在网段 ${result.subnet} 做存活探测（最多 ${maxHosts} 台，并发 ${concurrency}）`);
  } else if (!deep) {
    result.notes.push('未启用深度扫描，仅使用系统 ARP 邻居表');
  } else {
    result.notes.push('未找到可用的私有 IPv4 地址，跳过网段扫描');
  }

  /* ---------- 2) 网段存活探测 ---------- */
  const aliveList = [];
  if (hostIterator) {
    const hosts = [...hostIterator];
    const probePorts = [80, 443, 445, 22, 8080, 3389, 62078];
    let cursor = 0;
    let scanned = 0;

    const worker = async () => {
      while (cursor < hosts.length) {
        if (signal && signal.aborted) return;
        const ip = hosts[cursor];
        cursor += 1;
        const probe = await probeHostAlive(ip, probePorts, timeoutMs);
        scanned += 1;
        if (probe.alive) aliveList.push(probe);
        if (scanned % 32 === 0) {
          onProgress({ stage: 'sweep', scanned, total: hosts.length, alive: aliveList.length });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
    result.scanned.hosts = scanned;
    result.scanned.alive = aliveList.length;
    result.scanned.aliveIPs = aliveList.map((a) => a.ip);
    onProgress({ stage: 'sweep', scanned, total: hosts.length, alive: aliveList.length });
  }

  /* ---------- 3) 读取 ARP 邻居表 ---------- */
  const arpRes = await runCommand('arp', ['-a'], { timeoutMs: 8000 });
  const neighbors = parseArp(arpRes.stdout || '');

  /* ---------- 4) SSDP / mDNS ---------- */
  if (options.includeSsdp !== false) {
    try {
      const ssdp = await discoverSsdp({ timeoutMs: options.ssdpTimeoutMs || 2500 });
      result.ssdp = ssdp;
      onProgress({ stage: 'ssdp', found: ssdp.length });
    } catch (error) {
      result.notes.push('SSDP 发现失败：' + error.message);
    }
  }
  if (options.includeMdns !== false) {
    try {
      const mdns = await discoverMdns({ timeoutMs: options.mdnsTimeoutMs || 2000 });
      result.mdns = mdns;
      onProgress({ stage: 'mdns', found: mdns.length });
    } catch (error) {
      result.notes.push('mDNS 查询失败：' + error.message);
    }
  }

  /* ---------- 5) 汇总设备列表 ---------- */
  const selfIPs = new Set(result.self.map((s) => s.ip));
  const byIP = new Map();

  // 以 ARP 表为主干（它包含网关、其它设备，且带 MAC）
  for (const neighbor of neighbors) {
    if (neighbor.ip.endsWith('.255')) continue;
    if (isMulticastIPv4(neighbor.ip)) continue; // 组播组不是设备
    byIP.set(neighbor.ip, { ip: neighbor.ip, mac: neighbor.mac, arpType: neighbor.type });
  }
  // 扫描到的存活主机即使不在 ARP 表里也补上（同样排除组播与广播）
  for (const ip of aliveIPs(result)) {
    if (isMulticastIPv4(ip) || ip.endsWith('.255')) continue;
    if (!byIP.has(ip)) byIP.set(ip, { ip, mac: null, arpType: null });
  }
  if (result.gateway && !byIP.has(result.gateway)) {
    byIP.set(result.gateway, { ip: result.gateway, mac: null, arpType: null });
  }
  for (const ip of selfIPs) byIP.delete(ip); // 本机单独列出

  const devices = [...byIP.values()];
  const ssdpByIP = new Map(result.ssdp.filter((s) => s.address).map((s) => [s.address, s]));
  const mdnsByIP = new Map(result.mdns.filter((m) => m.address).map((m) => [m.address, m]));

  // 主机名：并发反解（含 NetBIOS 兜底）
  const hostnameResults = new Map();
  {
    let index = 0;
    const worker = async () => {
      while (index < devices.length) {
        const device = devices[index];
        index += 1;
        if (signal && signal.aborted) return;
        let hostname = await reverseLookup(device.ip, 1500);
        if (!hostname && device.ip === result.gateway) hostname = '默认网关';
        hostnameResults.set(device.ip, hostname || null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(12, devices.length) }, worker));
  }

  result.devices = devices.map((device) => {
    const vendorInfo = lookupVendorInfo(device.mac);
    const vendor = vendorInfo.vendor;
    const ssdp = ssdpByIP.get(device.ip) || null;
    const mdns = mdnsByIP.get(device.ip) || null;
    const hostname = hostnameResults.get(device.ip) || (ssdp && (ssdp.friendlyName || ssdp.modelName)) || null;
    const isGateway = device.ip === result.gateway;
    const kind = classifyDeviceType({ vendor, hostname, ssdp, ports: [], isGateway, isSelf: false });
    return {
      ip: device.ip,
      mac: device.mac,
      vendor,
      vendorLocal: vendorInfo.local,
      vendorPrefix: vendorInfo.prefix,
      hostname,
      arpType: device.arpType,
      ssdp,
      mdns,
      isGateway,
      type: kind.type,
      typeLabel: kind.label,
    };
  });

  // 按 IP 排序，便于阅读与前端布局
  result.devices.sort((a, b) => (ipv4ToInt(a.ip) >>> 0) - (ipv4ToInt(b.ip) >>> 0));
  result.scanned.durationMs = Date.now() - started;
  result.notes.push(`发现 ${result.devices.length} 台邻居设备（其中 ${result.devices.filter((d) => d.type !== 'unknown').length} 台已识别类型）`);
  onProgress({ stage: 'done', devices: result.devices.length });
  return result;
}

function aliveIPs(result) {
  return Array.isArray(result.scanned.aliveIPs) ? result.scanned.aliveIPs : [];
}

/* ------------------------------------------------------------------ */
/* SSDP（UPnP）设备发现                                                */
/* ------------------------------------------------------------------ */

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function discoverSsdp(options = {}) {
  const timeoutMs = options.timeoutMs || 2500;
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
      resolve([...found.values()]);
    };

    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/^HTTP\/1\.1 200 OK/i.test(text)) return;
      const header = {};
      for (const line of text.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx > 0) header[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim();
      }
      if (!found.has(rinfo.address)) {
        found.set(rinfo.address, {
          address: rinfo.address,
          port: rinfo.port,
          server: header.SERVER || null,
          location: header.LOCATION || null,
          usn: header.USN || null,
          st: header.ST || null,
        });
      } else if (header.SERVER) {
        found.get(rinfo.address).server = header.SERVER;
      }
    });

    socket.bind(() => {
      const targets = [
        'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        'urn:schemas-upnp-org:device:MediaRenderer:1',
        'upnp:rootdevice',
        'ssdp:all',
      ];
      for (const st of targets) {
        const payload = Buffer.from(
          'M-SEARCH * HTTP/1.1\r\n' +
            `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
            'MAN: "ssdp:discover"\r\n' +
            'MX: 2\r\n' +
            `ST: ${st}\r\n\r\n`,
        );
        socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_ADDR, () => {
          /* 发送失败也无所谓，继续等响应 */
        });
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

/* ------------------------------------------------------------------ */
/* mDNS 设备发现                                                       */
/* ------------------------------------------------------------------ */

function encodeDnsName(name) {
  const parts = name.split('.').filter(Boolean);
  const buffers = parts.map((part) => {
    const b = Buffer.from(part, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...buffers, Buffer.from([0])]);
}

async function discoverMdns(options = {}) {
  const timeoutMs = options.timeoutMs || 2000;
  const services = options.services || ['_services._dns-sd._udp.local', '_http._tcp.local', '_ipp._tcp.local', '_airplay._tcp.local'];
  const found = new Map();
  const MDNS_ADDR = '224.0.0.251';
  const MDNS_PORT = 5353;

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        socket.close();
      } catch (_) {
        /* ignore */
      }
      resolve([...found.values()]);
    };

    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      // 简化解析：只提取查询名与 PTR/A 记录里可读的域名片段
      const names = extractDnsNames(msg);
      if (!found.has(rinfo.address)) {
        found.set(rinfo.address, { address: rinfo.address, names: names.slice(0, 6) });
      }
    });

    socket.bind(() => {
      try {
        socket.addMembership(MDNS_ADDR);
      } catch (_) {
        /* 某些环境不允许加入组播组 */
      }
      for (const service of services) {
        const header = Buffer.alloc(12);
        header.writeUInt16BE(0, 0); // ID
        header.writeUInt16BE(0, 2); // flags: 标准查询
        header.writeUInt16BE(1, 4); // QDCOUNT
        const question = Buffer.concat([
          encodeDnsName(service),
          Buffer.from([0x00, 0x0c]), // QTYPE = PTR
          Buffer.from([0x00, 0x01]), // QCLASS = IN
        ]);
        const packet = Buffer.concat([header, question]);
        socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, () => {
          /* ignore */
        });
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

/** 从 DNS 报文中粗提取可读域名（够用即可，不做完整解析） */
function extractDnsNames(buffer) {
  const names = [];
  let i = 12;
  const readName = (offset) => {
    const labels = [];
    let pos = offset;
    let guard = 0;
    while (pos < buffer.length && guard < 40) {
      guard += 1;
      const len = buffer[pos];
      if (len === 0) break;
      if ((len & 0xc0) === 0xc0) break; // 压缩指针，停止
      const label = buffer.subarray(pos + 1, pos + 1 + len).toString('utf8');
      if (!/^[\x20-\x7e]+$/.test(label)) break;
      labels.push(label);
      pos += len + 1;
    }
    return labels.join('.');
  };
  // 跳过问题区（QDCOUNT 条）
  const qdcount = buffer.readUInt16BE(4);
  for (let q = 0; q < qdcount && i < buffer.length; q += 1) {
    const name = readName(i);
    if (name) names.push(name);
    i += name.length + 2 + 4;
  }
  // 在应答区里再扫一遍可读名字（粗略）
  for (let p = 12; p < buffer.length - 4; p += 1) {
    if (buffer[p] > 0 && buffer[p] < 40 && p + 1 + buffer[p] < buffer.length) {
      const candidate = readName(p);
      if (candidate && candidate.includes('.') && candidate.length < 80 && !names.includes(candidate)) {
        names.push(candidate);
      }
    }
    if (names.length > 40) break;
  }
  return names;
}

module.exports = {
  scanLan,
  discoverSsdp,
  discoverMdns,
  lookupVendor,
  lookupVendorInfo,
  classifyDeviceType,
  probeHostAlive,
  isMulticastIPv4,
};

/** 是否为 IPv4 多播地址（224.0.0.0/4）：组播组不是设备，必须排除 */
function isMulticastIPv4(ip) {
  const first = Number.parseInt(String(ip).split('.')[0], 10);
  return Number.isInteger(first) && first >= 224 && first <= 239;
}
