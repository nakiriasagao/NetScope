'use strict';

/**
 * IP / 目标地址处理工具
 * 纯函数实现，方便单元测试。支持 IPv4 与 IPv6 的基本判定。
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-_]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$/;

function isIPv4(value) {
  const m = IPV4_RE.exec(String(value || '').trim());
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    // 拒绝 010 这种带前导零的写法（容易与八进制混淆）
    if (m[i].length > 1 && m[i][0] === '0') return false;
  }
  return true;
}

function isIPv6(value) {
  const s = String(value || '').trim().replace(/^\[|\]$/g, '');
  if (!s.includes(':')) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return false;
  // 简易校验：最多一次 ::，分段数不超过 8
  const parts = s.split('::');
  if (parts.length > 2) return false;
  const segs = parts.flatMap((p) => (p === '' ? [] : p.split(':')));
  const hasV4Tail = /\./.test(s);
  if (segs.some((seg) => seg !== '' && !/^[0-9a-fA-F]{1,4}$/.test(seg))) {
    if (!(hasV4Tail && isIPv4(segs[segs.length - 1]))) return false;
  }
  if (parts.length === 2) return segs.length <= (hasV4Tail ? 6 : 7);
  return segs.length === (hasV4Tail ? 7 : 8);
}

function isIP(value) {
  return isIPv4(value) || isIPv6(value);
}

function ipv4ToInt(ip) {
  if (!isIPv4(ip)) return null;
  const [a, b, c, d] = String(ip).trim().split('.').map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

function isInCidr4(ip, cidr) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const [base, bitsRaw] = String(cidr).split('/');
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (baseInt & mask);
}

/**
 * 保留 / 特殊用途地址段（IANA 特殊用途登记表节选）
 */
const SPECIAL_V4 = [
  { cidr: '0.0.0.0/8', kind: 'unspecified', label: '本网络（0.0.0.0/8）' },
  { cidr: '10.0.0.0/8', kind: 'private', label: 'A 类私有地址（RFC1918）' },
  { cidr: '100.64.0.0/10', kind: 'cgnat', label: '运营商级 NAT（CGNAT，RFC6598）' },
  { cidr: '127.0.0.0/8', kind: 'loopback', label: '环回地址' },
  { cidr: '169.254.0.0/16', kind: 'linklocal', label: '链路本地（APIPA）' },
  { cidr: '172.16.0.0/12', kind: 'private', label: 'B 类私有地址（RFC1918）' },
  { cidr: '192.0.0.0/24', kind: 'reserved', label: 'IETF 协议分配' },
  { cidr: '192.0.2.0/24', kind: 'documentation', label: '文档用地址 TEST-NET-1' },
  { cidr: '192.88.99.0/24', kind: 'reserved', label: '6to4 中继任播' },
  { cidr: '192.168.0.0/16', kind: 'private', label: 'C 类私有地址（RFC1918）' },
  { cidr: '198.18.0.0/15', kind: 'benchmark', label: '基准测试地址' },
  { cidr: '198.51.100.0/24', kind: 'documentation', label: '文档用地址 TEST-NET-2' },
  { cidr: '203.0.113.0/24', kind: 'documentation', label: '文档用地址 TEST-NET-3' },
  { cidr: '224.0.0.0/4', kind: 'multicast', label: '组播地址' },
  { cidr: '240.0.0.0/4', kind: 'reserved', label: '保留（含广播 255.255.255.255）' },
];

/**
 * 判断地址性质，返回 { kind, label, isPrivate, isPublic }
 */
function classifyIP(ip) {
  const value = String(ip || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  if (!value) return { kind: 'invalid', label: '空地址', isPrivate: false, isPublic: false, ip: '' };

  if (isIPv6(value)) {
    const lower = value.toLowerCase();
    if (lower === '::1') return { kind: 'loopback', label: 'IPv6 环回地址', isPrivate: true, isPublic: false, ip: value };
    if (lower === '::') return { kind: 'unspecified', label: 'IPv6 未指定地址', isPrivate: true, isPublic: false, ip: value };
    if (/^fe80:/.test(lower)) return { kind: 'linklocal', label: 'IPv6 链路本地', isPrivate: true, isPublic: false, ip: value };
    if (/^f[cd]/.test(lower)) return { kind: 'private', label: 'IPv6 唯一本地地址（ULA）', isPrivate: true, isPublic: false, ip: value };
    if (/^ff/.test(lower)) return { kind: 'multicast', label: 'IPv6 组播', isPrivate: false, isPublic: false, ip: value };
    if (/^2002:/.test(lower)) return { kind: 'public', label: '6to4 隧道地址', isPrivate: false, isPublic: true, ip: value };
    if (/^2001:db8:/.test(lower)) return { kind: 'documentation', label: 'IPv6 文档用地址', isPrivate: false, isPublic: false, ip: value };
    return { kind: 'public', label: '公网 IPv6 地址', isPrivate: false, isPublic: true, ip: value };
  }

  if (!isIPv4(value)) {
    return { kind: 'invalid', label: '非法地址', isPrivate: false, isPublic: false, ip: value };
  }

  for (const rule of SPECIAL_V4) {
    if (isInCidr4(value, rule.cidr)) {
      return {
        kind: rule.kind,
        label: rule.label,
        isPrivate: ['private', 'loopback', 'linklocal', 'cgnat', 'unspecified'].includes(rule.kind),
        isPublic: rule.kind === 'public',
        ip: value,
      };
    }
  }
  return { kind: 'public', label: '公网 IPv4 地址', isPrivate: false, isPublic: true, ip: value };
}

function isPrivateIP(ip) {
  return classifyIP(ip).isPrivate;
}

/**
 * 解析用户输入的目标：支持 URL、host:port、IPv4、IPv6、主机名
 * 返回 { raw, host, port, protocol, kind }
 */
function parseTarget(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new Error('目标不能为空');
  if (raw.length > 255) throw new Error('目标字符串过长');

  let rest = raw;
  let protocol = null;

  const protoMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rest);
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase();
    rest = rest.slice(protoMatch[0].length);
  }

  // 去掉路径 / 查询 / 片段
  rest = rest.split(/[/?#]/)[0];
  // 去掉用户信息
  if (rest.includes('@')) rest = rest.slice(rest.lastIndexOf('@') + 1);

  let host = rest;
  let port = null;

  if (rest.startsWith('[')) {
    // [ipv6]:port
    const end = rest.indexOf(']');
    if (end === -1) throw new Error('IPv6 地址格式错误：缺少 "]"');
    host = rest.slice(1, end);
    const after = rest.slice(end + 1);
    if (after.startsWith(':')) port = Number.parseInt(after.slice(1), 10);
  } else {
    const colonCount = (rest.match(/:/g) || []).length;
    if (colonCount === 1) {
      const [h, p] = rest.split(':');
      // 只有右侧是数字才当作端口，避免误伤 IPv6
      if (/^\d+$/.test(p)) {
        host = h;
        port = Number.parseInt(p, 10);
      }
    }
  }

  if (!host) throw new Error('无法识别目标主机');

  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`端口不合法：${port}`);
  }

  const lowerHost = host.toLowerCase();
  let kind;
  if (isIPv4(lowerHost)) kind = 'ipv4';
  else if (isIPv6(lowerHost)) kind = 'ipv6';
  else if (lowerHost === 'localhost') kind = 'hostname';
  else if (HOSTNAME_RE.test(lowerHost)) kind = 'hostname';
  else throw new Error(`无法识别的目标：${host}（既不是合法 IP，也不是合法域名）`);

  return {
    raw,
    host: lowerHost,
    port,
    protocol,
    kind,
    defaultPort: port || (protocol === 'https' ? 443 : 80),
  };
}

/** 生成本机所在网段（用于给私有地址节点定位） */
function cidrOf(ip, prefix) {
  const n = ipv4ToInt(ip);
  if (n === null) return null;
  const bits = Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  if (bits === 0) return '0.0.0.0/0';
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  const base = (n & mask) >>> 0;
  return `${(base >>> 24) & 255}.${(base >>> 16) & 255}.${(base >>> 8) & 255}.${base & 255}/${bits}`;
}

module.exports = {
  isIPv4,
  isIPv6,
  isIP,
  ipv4ToInt,
  isInCidr4,
  classifyIP,
  isPrivateIP,
  parseTarget,
  cidrOf,
  SPECIAL_V4,
  HOSTNAME_RE,
};
