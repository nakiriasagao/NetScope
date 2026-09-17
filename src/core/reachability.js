'use strict';

/**
 * 目标主机的连通性探测
 *  - ICMP ping（系统 ping 命令，Windows / Unix 通用）
 *  - TCP 端口连通与时延（net.connect 计时）
 *  - HTTP(S) 响应探测（状态码 / 服务器头 / 重定向）
 *  - 正向 / 反向 DNS 解析
 */

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const { runCommand } = require('./exec');
const { parsePing } = require('./parsers');
const { isIP, isIPv4, classifyIP } = require('./iputils');
const config = require('../config');

/* ------------------------------------------------------------------ */
/* DNS                                                                 */
/* ------------------------------------------------------------------ */

async function resolveHostname(host, options = {}) {
  const timeoutMs = options.timeoutMs || 6000;
  if (isIP(host)) {
    return { host, isIP: true, addresses: [{ address: host, family: isIPv4(host) ? 4 : 6 }], cname: null, durationMs: 0 };
  }
  const started = Date.now();
  const result = { host, isIP: false, addresses: [], cname: null, durationMs: 0, errors: [] };

  await Promise.race([
    (async () => {
      try {
        const addresses = await dns.lookup(host, { all: true, verbatim: true });
        result.addresses = addresses.map((a) => ({ address: a.address, family: a.family }));
      } catch (error) {
        result.errors.push(`A/AAAA 查询失败: ${error.code || error.message}`);
      }
      try {
        const cnames = await dns.resolveCname(host);
        if (cnames && cnames.length) result.cname = cnames[0];
      } catch (_) {
        /* 无 CNAME 属正常情况 */
      }
    })(),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  result.durationMs = Date.now() - started;
  return result;
}

async function reverseLookup(ip, timeoutMs = 3000) {
  if (!isIP(ip)) return null;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return names && names.length ? names[0] : null;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* ICMP ping                                                           */
/* ------------------------------------------------------------------ */

async function icmpPing(host, options = {}) {
  const count = options.count || config.probe.pingCount;
  const timeoutSec = Math.max(1, Math.round((options.timeoutMs || config.probe.pingTimeoutMs) / 1000));
  const isWin = process.platform === 'win32';
  const args = isWin
    ? ['-n', String(count), '-w', String(timeoutSec * 1000), '-4', host]
    : ['-c', String(count), '-W', String(timeoutSec), '-4', host];

  const res = await runCommand('ping', args, { timeoutMs: (timeoutSec * count + 6) * 1000 });
  const parsed = parsePing(res.stdout || res.stderr);
  return {
    ...parsed,
    target: host,
    tool: 'icmp',
    command: `ping ${args.join(' ')}`,
    durationMs: res.durationMs,
    error: parsed.sent === null && res.error ? res.error.message : null,
  };
}

/* ------------------------------------------------------------------ */
/* TCP 探测                                                            */
/* ------------------------------------------------------------------ */

function tcpProbe(host, port, timeoutMs = config.probe.tcpProbeTimeoutMs) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ host, port, latencyMs: Math.round(elapsedMs * 10) / 10, ...result });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ open: true, state: 'open' }));
    socket.once('timeout', () => done({ open: false, state: 'timeout', error: '连接超时' }));
    socket.once('error', (error) => done({ open: false, state: error.code === 'ECONNREFUSED' ? 'closed' : 'error', error: error.code || error.message }));
    try {
      socket.connect(port, host);
    } catch (error) {
      done({ open: false, state: 'error', error: error.message });
    }
  });
}

/**
 * 探测一组常用端口
 */
async function probeCommonPorts(host, ports, options = {}) {
  const list = ports || [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 873, 993, 995, 1433, 1521, 2049, 3000, 3306, 3389, 5432, 5900, 6379, 8000, 8080, 8443, 9000, 11211, 27017];
  const timeoutMs = options.timeoutMs || config.probe.tcpProbeTimeoutMs;
  const concurrency = Math.min(options.concurrency || 12, list.length);
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < list.length) {
      const port = list[cursor];
      cursor += 1;
      if (options.signal?.aborted) return;
      results.push(await tcpProbe(host, port, timeoutMs));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.sort((a, b) => a.port - b.port);
}

/**
 * 常用端口表（用于端口扫描的 quick 模式）
 */
const TOP_PORTS = [
  { port: 20, service: 'FTP-Data' }, { port: 21, service: 'FTP' }, { port: 22, service: 'SSH' },
  { port: 23, service: 'Telnet' }, { port: 25, service: 'SMTP' }, { port: 53, service: 'DNS' },
  { port: 67, service: 'DHCP' }, { port: 69, service: 'TFTP' }, { port: 80, service: 'HTTP' },
  { port: 110, service: 'POP3' }, { port: 111, service: 'RPC' }, { port: 123, service: 'NTP' },
  { port: 135, service: 'MSRPC' }, { port: 137, service: 'NetBIOS' }, { port: 139, service: 'NetBIOS-SSN' },
  { port: 143, service: 'IMAP' }, { port: 161, service: 'SNMP' }, { port: 179, service: 'BGP' },
  { port: 389, service: 'LDAP' }, { port: 443, service: 'HTTPS' }, { port: 445, service: 'SMB' },
  { port: 465, service: 'SMTPS' }, { port: 514, service: 'Syslog' }, { port: 587, service: 'SMTP-Submission' },
  { port: 636, service: 'LDAPS' }, { port: 873, service: 'Rsync' }, { port: 993, service: 'IMAPS' },
  { port: 995, service: 'POP3S' }, { port: 1080, service: 'SOCKS' }, { port: 1194, service: 'OpenVPN' },
  { port: 1433, service: 'MSSQL' }, { port: 1521, service: 'Oracle' }, { port: 1701, service: 'L2TP' },
  { port: 1723, service: 'PPTP' }, { port: 2049, service: 'NFS' }, { port: 2082, service: 'cPanel' },
  { port: 2181, service: 'ZooKeeper' }, { port: 2375, service: 'Docker' }, { port: 3000, service: 'Node/Grafana' },
  { port: 3128, service: 'Squid' }, { port: 3260, service: 'iSCSI' }, { port: 3306, service: 'MySQL' },
  { port: 3389, service: 'RDP' }, { port: 4443, service: 'HTTPS-Alt' }, { port: 5000, service: 'UPnP/Flask' },
  { port: 5432, service: 'PostgreSQL' }, { port: 5601, service: 'Kibana' }, { port: 5672, service: 'AMQP' },
  { port: 5900, service: 'VNC' }, { port: 5984, service: 'CouchDB' }, { port: 6379, service: 'Redis' },
  { port: 6443, service: 'K8s API' }, { port: 7001, service: 'WebLogic' }, { port: 8000, service: 'HTTP-Alt' },
  { port: 8080, service: 'HTTP-Proxy' }, { port: 8081, service: 'HTTP-Alt' }, { port: 8086, service: 'InfluxDB' },
  { port: 8443, service: 'HTTPS-Alt' }, { port: 8888, service: 'Jupyter' }, { port: 9000, service: 'PHP-FPM' },
  { port: 9090, service: 'Prometheus' }, { port: 9200, service: 'Elasticsearch' }, { port: 9300, service: 'ES-Transport' },
  { port: 11211, service: 'Memcached' }, { port: 27017, service: 'MongoDB' }, { port: 50000, service: 'SAP' },
];

const TOP_PORT_MAP = new Map(TOP_PORTS.map((p) => [p.port, p.service]));

function serviceOf(port) {
  return TOP_PORT_MAP.get(port) || null;
}

/**
 * 端口扫描：支持 quick（常用端口）/ list / range
 * @param {string} host
 * @param {{ mode?: 'quick'|'list'|'range', ports?: number[], from?: number, to?: number, timeoutMs?: number, signal?: AbortSignal, onProgress?: Function }} options
 */
async function scanPorts(host, options = {}) {
  const timeoutMs = options.timeoutMs || config.probe.portScanTimeoutMs;
  const signal = options.signal;
  const started = Date.now();

  let ports = [];
  const mode = options.mode || 'quick';
  if (mode === 'quick') {
    ports = TOP_PORTS.map((p) => p.port);
  } else if (mode === 'range') {
    const from = Math.max(1, Number(options.from) || 1);
    const to = Math.min(65535, Number(options.to) || from);
    if (to < from) throw new Error('端口范围不合法：结束端口小于起始端口');
    if (to - from + 1 > config.probe.portScanMaxPorts) {
      throw new Error(`端口数量超过上限 ${config.probe.portScanMaxPorts}，请缩小范围或调整配置`);
    }
    for (let p = from; p <= to; p += 1) ports.push(p);
  } else if (mode === 'list') {
    ports = [...new Set((options.ports || []).map((p) => Number.parseInt(p, 10)).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535))];
    if (!ports.length) throw new Error('未提供有效端口列表');
    if (ports.length > config.probe.portScanMaxPorts) throw new Error(`端口数量超过上限 ${config.probe.portScanMaxPorts}`);
  } else {
    throw new Error(`未知扫描模式：${mode}`);
  }

  const concurrency = Math.max(1, Math.min(config.probe.portScanConcurrency, ports.length));
  const results = [];
  let cursor = 0;
  let scanned = 0;

  async function worker() {
    while (cursor < ports.length) {
      const index = cursor;
      cursor += 1;
      if (signal?.aborted) return;
      const port = ports[index];
      const probe = await tcpProbe(host, port, timeoutMs);
      scanned += 1;
      results.push({ ...probe, service: serviceOf(port) });
      if (typeof options.onProgress === 'function' && (scanned % 25 === 0 || scanned === ports.length)) {
        options.onProgress({ scanned, total: ports.length, open: results.filter((r) => r.open).length });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  const sorted = results.sort((a, b) => a.port - b.port);
  return {
    host,
    mode,
    durationMs: Date.now() - started,
    total: ports.length,
    open: sorted.filter((r) => r.open),
    closed: sorted.filter((r) => r.state === 'closed').length,
    filtered: sorted.filter((r) => r.state === 'timeout' || r.state === 'error').length,
    results: sorted,
    aborted: Boolean(signal?.aborted),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 探测                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {string} host
 * @param {{ port?: number, path?: string, tls?: boolean, timeoutMs?: number, followRedirects?: boolean }} options
 */
function httpProbe(host, options = {}) {
  const port = options.port || (options.tls ? 443 : 80);
  const tls = options.tls !== undefined ? options.tls : port === 443;
  const path = options.path || '/';
  const timeoutMs = options.timeoutMs || 8000;
  const agent = tls ? https : http;

  return new Promise((resolve) => {
    const started = Date.now();
    const headers = {};
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ host, port, tls: Boolean(tls), path, latencyMs: Date.now() - started, headers, ...payload });
    };

    let req;
    try {
      req = agent.request(
        {
          host,
          port,
          path,
          method: options.method || 'GET',
          timeout: timeoutMs,
          headers: { 'User-Agent': 'NetScope/1.0', Accept: '*/*', Connection: 'close' },
          rejectUnauthorized: false,
          servername: isIP(host) ? undefined : host,
        },
        (res) => {
          for (const [k, v] of Object.entries(res.headers)) headers[k] = v;
          const ttfb = Date.now() - started;
          let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            // 只读取少量数据即可判断服务类型，随后主动断开
            if (bytes > 8192) res.destroy();
          });
          res.on('end', () => finish({ ok: true, statusCode: res.statusCode, statusMessage: res.statusMessage, ttfbMs: ttfb, bytes }));
          res.on('close', () => finish({ ok: true, statusCode: res.statusCode, statusMessage: res.statusMessage, ttfbMs: ttfb, bytes }));
          res.on('error', (error) => finish({ ok: false, error: error.message, ttfbMs: ttfb }));
        },
      );
    } catch (error) {
      finish({ ok: false, error: error.message });
      return;
    }

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: '请求超时' });
    });
    req.on('error', (error) => finish({ ok: false, error: error.code || error.message }));
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* 综合探测                                                            */
/* ------------------------------------------------------------------ */

/**
 * 对目标做一次综合体检（不含 traceroute，traceroute 单独调用以便流式展示）
 * @param {{ host: string, port?: number, protocol?: string, kind?: string }} target
 */
async function probeTarget(target, options = {}) {
  const host = target.host;
  const signal = options.signal;
  const result = {
    host,
    startedAt: new Date().toISOString(),
    dns: null,
    reverseDns: null,
    classification: classifyIP(host),
    ping: null,
    tcp: [],
    http: null,
    errors: [],
  };

  // 1) DNS
  result.dns = await resolveHostname(host, { timeoutMs: options.dnsTimeoutMs || 6000 });

  const ipv4 = (result.dns.addresses.find((a) => a.family === 4) || result.dns.addresses[0])?.address || (isIPv4(host) ? host : null);
  result.primaryIP = ipv4;

  if (!ipv4) {
    result.errors.push('无法解析出可用 IP 地址');
    return result;
  }

  result.classification = classifyIP(ipv4);

  // 2) 并行执行：反向解析 / ICMP / 端口探测
  const preferredPorts = new Set([80, 443]);
  if (target.port) preferredPorts.add(target.port);
  if (target.protocol === 'http') preferredPorts.add(80);
  if (target.protocol === 'https') preferredPorts.add(443);

  const portList = [...preferredPorts].sort((a, b) => a - b);

  const [reverseDns, ping, tcp, http] = await Promise.all([
    reverseLookup(ipv4, 3000),
    options.skipPing ? Promise.resolve(null) : icmpPing(ipv4, { count: options.pingCount || config.probe.pingCount }),
    probeCommonPorts(ipv4, portList, { timeoutMs: options.tcpTimeoutMs || 3000 }),
    options.skipHttp
      ? Promise.resolve(null)
      : (async () => {
          const attempts = [];
          const httpPorts = target.port ? [target.port] : [80, 443];
          for (const port of httpPorts) {
            if (signal?.aborted) break;
            const tls = port === 443 || port === 8443 || target.protocol === 'https';
            attempts.push(await httpProbe(ipv4, { port, tls, timeoutMs: options.httpTimeoutMs || 8000 }));
          }
          return attempts;
        })(),
  ]);

  result.reverseDns = reverseDns;
  result.ping = ping;
  result.tcp = tcp;
  result.http = http;
  result.finishedAt = new Date().toISOString();
  return result;
}

module.exports = {
  resolveHostname,
  reverseLookup,
  icmpPing,
  tcpProbe,
  probeCommonPorts,
  scanPorts,
  httpProbe,
  probeTarget,
  TOP_PORTS,
  serviceOf,
};
