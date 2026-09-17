'use strict';

/**
 * traceroute / tracert / ping 输出解析器
 * 兼容：
 *  - Windows 中文 / 英文 tracert
 *  - Linux / macOS traceroute（含 -n 与域名两种形式）
 *  - Windows ping / Linux ping（中文 / 英文）
 */

const IPV4_TOKEN = /(?:^|[\s(\[])((?:\d{1,3}\.){3}\d{1,3})(?=[\s)\]:,;]|$)/g;
const IPV6_TOKEN = /(?:^|[\s(\[])((?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4})(?=[\s)\]]|$)/g;
const MS_TOKEN = /([\d.]+)\s*(?:ms|毫秒)/gi;

function extractIPs(line) {
  const ips = [];
  let m;
  IPV4_TOKEN.lastIndex = 0;
  while ((m = IPV4_TOKEN.exec(line)) !== null) {
    ips.push(m[1]);
  }
  if (ips.length === 0) {
    IPV6_TOKEN.lastIndex = 0;
    while ((m = IPV6_TOKEN.exec(line)) !== null) {
      ips.push(m[1]);
    }
  }
  return ips;
}

function parseMsValues(line) {
  const values = [];
  let m;
  MS_TOKEN.lastIndex = 0;
  while ((m = MS_TOKEN.exec(line)) !== null) {
    const v = Number.parseFloat(m[1]);
    if (Number.isFinite(v)) values.push(v);
  }
  return values;
}

function countTimeouts(line, queries) {
  const stars = (line.match(/\*/g) || []).length;
  if (stars > 0) return Math.min(stars, queries);
  // 中文 tracert 超时文本
  if (/请求超时|Request timed out/i.test(line)) return queries;
  return 0;
}

/** 统计单跳信息 */
function summarizeHop(rawMs, timeouts, probes) {
  // probes 为这一跳实际出现的探测结果个数（响应 + 超时标记）；
  // 若调用方提供了期望次数且实际值更大，则取实际值，避免出现负丢包率。
  const attempts = Math.max(probes || 0, rawMs.length + (timeouts || 0)) || 1;
  const ok = rawMs.length;
  const min = ok ? Math.min(...rawMs) : null;
  const max = ok ? Math.max(...rawMs) : null;
  const avg = ok ? rawMs.reduce((a, b) => a + b, 0) / ok : null;
  const jitter = ok > 1 ? max - min : 0;
  return {
    attempts,
    responded: ok,
    lossPct: Math.round(((attempts - ok) / attempts) * 1000) / 10,
    min: min === null ? null : round1(min),
    max: max === null ? null : round1(max),
    avg: avg === null ? null : round1(avg),
    jitter: round1(jitter),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * 解析 traceroute 输出
 * @param {string} output 原始输出
 * @param {{ targetIP?: string, queries?: number, maxHops?: number }} [options]
 */
function parseTraceroute(output, options = {}) {
  const text = String(output || '').replace(/\r/g, '');
  const lines = text.split('\n');
  const queries = options.queries || 3;
  const hops = [];
  let destination = options.targetIP || null;
  let complete = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    // Windows 头部：通过最多 30 个跃点跟踪到 xxx 的路由
    const headerMatch = /(?:Tracing route to|通过最多\s*\d+\s*个跃点跟踪到)\s+(\S+)/i.exec(line);
    if (headerMatch) continue;

    if (/(?:Trace complete|跟踪完成|追踪完成)/i.test(line)) {
      complete = true;
      continue;
    }

    // 形如 "  1    <1 ms    <1 ms    <1 ms  192.168.1.1" 或 " 1  gateway (10.0.0.1)  1.2 ms  1.3 ms  1.4 ms"
    const hopMatch = /^\s*(\d{1,3})\s+(.+)$/.exec(line);
    if (!hopMatch) continue;

    const ttl = Number.parseInt(hopMatch[1], 10);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 64) continue;
    const body = hopMatch[2];

    const ips = extractIPs(body);
    const ms = parseMsValues(body);
    const stars = (body.match(/\*/g) || []).length;
    const timeoutTexts = (body.match(/请求超时|Request timed out/gi) || []).length;
    const timeouts = countTimeouts(body, queries);
    // 这一跳实际出现的探测结果个数（每个 ms 值、每个 *、每段超时文本各算一次）
    const probes = ms.length + Math.max(stars, timeoutTexts);

    // 无响应跳（全 *）
    if (ips.length === 0 && ms.length === 0) {
      hops.push({
        ttl,
        ip: null,
        hostname: null,
        isTimeout: true,
        latency: summarizeHop([], timeouts || queries, queries),
        raw: line.trim(),
      });
      continue;
    }

    const ip = ips.length ? ips[0] : null;
    if (ip && ttl > 1 && !destination) destination = ip;

    // 主机名提取：Windows 顺序为 "IP [ptr]"；unix 为 "ptr (IP)"
    let hostname = null;
    const bracket = /(\d{1,3}(?:\.\d{1,3}){3})\s*\[([^\]]+)\]/.exec(body);
    if (bracket) hostname = bracket[2].trim();
    if (!hostname) {
      const paren = /([^\s(]+)\s*\(\s*(?:\d{1,3}\.){3}\d{1,3}\s*\)/.exec(body);
      if (paren && !/^\d+$/.test(paren[1])) hostname = paren[1].trim();
    }
    if (!hostname) {
      const bare = /^\s*([a-zA-Z][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})\s*$/.exec(body.replace(/[\d.]+\s*ms/gi, '').trim());
      if (bare) hostname = bare[1];
    }

    hops.push({
      ttl,
      ip,
      hostname,
      isTimeout: false,
      latency: summarizeHop(ms, timeouts, probes),
      raw: line.trim(),
    });
  }

  // 汇总
  const responded = hops.filter((h) => h.ip);
  const rtts = responded.map((h) => h.latency.avg).filter((v) => typeof v === 'number');
  const lastHop = hops.length ? hops[hops.length - 1] : null;
  const finalIP = [...responded].reverse().find((h) => h.ip)?.ip || null;

  const summary = {
    hopCount: hops.length,
    respondedHops: responded.length,
    timeouts: hops.filter((h) => h.isTimeout).length,
    destinationIP: options.targetIP || finalIP,
    reachedTarget: Boolean(
      options.targetIP && finalIP && options.targetIP === finalIP,
    ) || complete,
    minRtt: rtts.length ? Math.min(...rtts) : null,
    maxRtt: rtts.length ? Math.max(...rtts) : null,
    avgRtt: rtts.length ? round1(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null,
    totalRtt: rtts.length ? round1(rtts[0] + (lastHop?.latency?.avg || 0)) : null,
    lastHopIP: finalIP,
  };

  return { hops, summary, complete };
}

/**
 * 解析 ping 输出（Windows 中文/英文、Linux/macOS）
 */
function parsePing(output) {
  const text = String(output || '').replace(/\r/g, '');
  const lines = text.split('\n');

  let sent = null;
  let received = null;
  let lost = null;
  let lossPct = null;
  let min = null;
  let max = null;
  let avg = null;
  const rtts = [];
  let resolvedIP = null;
  let timeouts = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 正在 Ping xxx [1.2.3.4] 具有 32 字节的数据 / PING xxx (1.2.3.4)
    const head = /(?:Pinging|正在\s*Ping|PING)\s+(\S+)\s*[\[(]\s*([0-9a-fA-F:.]+)\s*[\])]/i.exec(trimmed);
    if (head) resolvedIP = head[2];

    // 请求超时 / Request timed out —— 也计入“已发送”
    if (/(?:请求超时|Request timed out|Destination host unreachable|无法访问目标主机)/i.test(trimmed)) {
      timeouts += 1;
    }

    // 来自 1.2.3.4 的回复: 字节=32 时间=10ms TTL=51 / Reply from 1.2.3.4: bytes=32 time=10ms TTL=51
    // 兼容 "<1ms"、"=<1ms"、"<1 毫秒"、"time=10ms" 等写法
    const replyTime = /(?:时间|time)\s*=?\s*([<=]?)\s*([\d.]+)\s*(?:ms|毫秒)/i.exec(trimmed);
    if (replyTime && /(?:回复|Reply|来自|from)/i.test(trimmed)) {
      let v = Number.parseFloat(replyTime[2]);
      if (replyTime[1] === '<') v = Math.min(v, 1);
      if (Number.isFinite(v)) rtts.push(v);
      const ipInLine = extractIPs(trimmed);
      if (!resolvedIP && ipInLine.length) resolvedIP = ipInLine[0];
    }

    // 数据包: 已发送 = 4，已接收 = 4，丢失 = 0 (0% 丢失)
    const statWin = /已发送\s*=\s*(\d+)[，,]\s*已接收\s*=\s*(\d+)[，,]\s*丢失\s*=\s*(\d+)\s*\((\d+)%/i.exec(trimmed);
    if (statWin) {
      sent = Number(statWin[1]);
      received = Number(statWin[2]);
      lost = Number(statWin[3]);
      lossPct = Number(statWin[4]);
    }
    // 英文 Windows：Packets: Sent = 4, Received = 2, Lost = 2 (50% loss),
    const statWinEn = /(?:Packets\s*:\s*)?Sent\s*=\s*(\d+)\s*,\s*Received\s*=\s*(\d+)\s*,\s*Lost\s*=\s*(\d+)\s*\((\d+)%\s*loss\)/i.exec(trimmed);
    if (statWinEn) {
      sent = Number(statWinEn[1]);
      received = Number(statWinEn[2]);
      lost = Number(statWinEn[3]);
      lossPct = Number(statWinEn[4]);
    }
    const statEn = /(\d+)\s+packets transmitted,\s*(\d+)\s+(?:packets )?received,\s*(\d+)%\s*packet loss/i.exec(trimmed);
    if (statEn) {
      sent = Number(statEn[1]);
      received = Number(statEn[2]);
      lossPct = Number(statEn[3]);
      lost = sent - received;
    }

    // 最短 = 9ms，最长 = 11ms，平均 = 10ms
    const rttWin = /(?:最短|Minimum)\s*=\s*([\d.]+)\s*(?:ms|毫秒)?[，,]\s*(?:最长|Maximum)\s*=\s*([\d.]+)/i.exec(trimmed);
    if (rttWin) {
      min = Number.parseFloat(rttWin[1]);
      max = Number.parseFloat(rttWin[2]);
      const avgMatch = /(?:平均|Average)\s*=\s*([\d.]+)/i.exec(trimmed);
      if (avgMatch) avg = Number.parseFloat(avgMatch[1]);
    }
    const rttUnix = /(?:rtt|round-trip)\s+min\/avg\/max(?:\/mdev)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/i.exec(trimmed);
    if (rttUnix) {
      min = Number.parseFloat(rttUnix[1]);
      avg = Number.parseFloat(rttUnix[2]);
      max = Number.parseFloat(rttUnix[3]);
    }
  }

  if (sent === null) sent = rtts.length + timeouts || null;
  if (received === null) received = rtts.length;
  if (lossPct === null && sent) lossPct = Math.round(((sent - received) / sent) * 1000) / 10;
  if (avg === null && rtts.length) avg = round1(rtts.reduce((a, b) => a + b, 0) / rtts.length);
  if (min === null && rtts.length) min = Math.min(...rtts);
  if (max === null && rtts.length) max = Math.max(...rtts);

  const jitter = rtts.length > 1 ? round1(Math.max(...rtts) - Math.min(...rtts)) : 0;

  return {
    resolvedIP,
    sent,
    received,
    lost,
    lossPct,
    min: min === null ? null : round1(min),
    max: max === null ? null : round1(max),
    avg: avg === null ? null : round1(avg),
    jitter,
    samples: rtts.map(round1),
    alive: (received || 0) > 0,
  };
}

module.exports = { parseTraceroute, parsePing, extractIPs, parseMsValues, summarizeHop };
