'use strict';

/**
 * 路由追踪（traceroute）双引擎实现
 *
 *  引擎 1：原生 ICMP 套接字（dgram 原始套接字 + UDP 低 TTL 探测）
 *          —— 不依赖任何外部命令，速度最快，可精确控制每跳探测次数。
 *  引擎 2：系统命令（Windows `tracert` / Unix `traceroute`）
 *          —— 兼容性最好，作为引擎 1 的自动回退。
 *
 *  两个引擎输出统一为 { hops: [...], summary: {...} } 结构。
 */

const dgram = require('dgram');
const os = require('os');
const { runAndCapture } = require('./exec');
const { parseTraceroute } = require('./parsers');
const { isIPv4, classifyIP } = require('./iputils');
const { reverseLookup } = require('./reachability');
const config = require('../config');

/* ------------------------------------------------------------------ */
/* 引擎 1：系统命令                                                    */
/* ------------------------------------------------------------------ */

function buildSystemTraceArgs(host, options) {
  const maxHops = options.maxHops || config.probe.traceMaxHops;
  const queries = options.queries || config.probe.traceQueries;
  if (process.platform === 'win32') {
    // -d 不做反向解析（速度最快，之后我们自己对每一跳做异步反解）
    // -w 每跳等待毫秒数，-h 最大跳数，-4 强制 IPv4
    return ['tracert', ['-d', '-4', '-h', String(maxHops), '-w', String(options.timeoutMs || config.probe.traceTimeoutMs), host]];
  }
  // Linux / macOS traceroute
  return [
    'traceroute',
    ['-n', '-4', '-m', String(maxHops), '-q', String(queries), '-w', String(Math.max(1, Math.round((options.timeoutMs || config.probe.traceTimeoutMs) / 1000))), host],
  ];
}

async function traceWithSystemCommand(host, options = {}) {
  const [command, args] = buildSystemTraceArgs(host, options);
  const res = await runAndCapture(command, args, { timeoutMs: options.hardTimeoutMs || config.probe.traceHardTimeoutMs });

  const stdout = res.stdout || '';
  if (!stdout) {
    const hint = res.attempts && res.attempts.length ? `（${res.attempts.join(' | ')}）` : '';
    return {
      engine: 'system',
      available: false,
      error: `系统命令 ${command} 未返回输出${hint}`,
      hops: [],
      summary: null,
    };
  }

  const parsed = parseTraceroute(stdout, {
    targetIP: options.targetIP || null,
    queries: options.queries || config.probe.traceQueries,
    maxHops: options.maxHops || config.probe.traceMaxHops,
  });

  return {
    engine: 'system',
    available: true,
    command: `${command} ${args.join(' ')}`,
    captureStrategy: res.strategy,
    durationMs: res.durationMs,
    timedOut: res.timedOut,
    raw: stdout,
    ...parsed,
  };
}

/* ------------------------------------------------------------------ */
/* 引擎 2：原生 ICMP 套接字                                           */
/* ------------------------------------------------------------------ */

/**
 * 实现说明：
 *   UDP 探测包设置 TTL，路由器回送 ICMP Time Exceeded，
 *   原始套接字（IP_RECVTTL）可读出“外层 IP 头中记录的、引发该 ICMP 的原始包 TTL”。
 *   据此可以把回包与刚发出的探测一一配对，从而算出每一跳的 RTT。
 *
 * 平台差异：
 *   - Linux/macOS：dgram 的 UDP 套接字支持 setTTL，且 IP_RECVTTL 默认开启，可用。
 *   - Windows：Winsock 不允许对 UDP 套接字设置很小的 TTL 语义（且 setTTL 需要管理员），
 *     故默认禁用该引擎，自动回退到系统 tracert（见 socketEngineSupported）。
 */

function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    sum += (buf[i] << 8) + (i + 1 < buf.length ? buf[i + 1] : 0);
  }
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

function buildIcmpEcho(id, seq, payloadSize = 32) {
  const packet = Buffer.alloc(8 + payloadSize);
  packet.writeUInt8(8, 0); // type: echo request
  packet.writeUInt8(0, 1); // code
  packet.writeUInt16BE(0, 2); // checksum 占位
  packet.writeUInt16BE(id, 4);
  packet.writeUInt16BE(seq, 6);
  for (let i = 8; i < packet.length; i += 1) packet[i] = i & 0xff;
  packet.writeUInt16BE(checksum(packet), 2);
  return packet;
}

function socketEngineSupported() {
  // 原生套接字依赖三点：可创建原始套接字、可设置 UDP TTL、可读取 ICMP 回包。
  // Linux/macOS 默认支持；Windows 需要管理员权限或网络策略放开，
  // 因此这里只做“乐观尝试”，并在首次探测失败后缓存结论，避免每次追踪都浪费时间。
  if (process.env.NETSCOPE_DISABLE_ICMP === '1') return false;
  return socketCapability.usable !== false;
}

const socketCapability = {
  usable: null, // null=未探测
  checkedAt: 0,
  note: null,
};

/**
 * 一次性能力探测：向公网地址发 2 个低 TTL 探测包，看是否能收到 ICMP 回包。
 * 探测结果在进程内缓存 10 分钟，避免重复开销（用户也可用 env 强制关闭）。
 */
async function probeSocketCapability(options = {}) {
  if (socketCapability.usable !== null && Date.now() - socketCapability.checkedAt < 10 * 60 * 1000) {
    return socketCapability.usable;
  }
  const target = options.probeTarget || '8.8.8.8';
  const result = await traceWithIcmpSocket(target, { maxHops: 2, queries: 1, timeoutMs: 900, targetIP: target });
  const usable = result.hops.some((h) => h.ip);
  socketCapability.usable = usable;
  socketCapability.checkedAt = Date.now();
  socketCapability.note = usable
    ? '原生 ICMP 套接字可用'
    : `原生 ICMP 套接字收不到回包（${result.error || '无响应'}），已自动改用系统命令引擎`;
  return usable;
}

function socketCapabilityInfo() {
  return {
    usable: socketCapability.usable,
    checkedAt: socketCapability.checkedAt ? new Date(socketCapability.checkedAt).toISOString() : null,
    note: socketCapability.note,
    disabledByEnv: process.env.NETSCOPE_DISABLE_ICMP === '1',
  };
}

/**
 * 解析 raw socket 收到的 IPv4 报文，返回关键字段
 *  - 若 protocol 为 ICMP，则进一步解析 type / code，以及引发该 ICMP 的内层 IP 头（含其 TTL）
 *  - 如果本层 IP 头带有 TTL（IP_RECVTTL 生效），一并返回 outerTtl
 */
function describeIcmp(buf) {
  if (!buf || buf.length < 20) return null;
  const version = buf[0] >> 4;
  const ihl = (buf[0] & 0x0f) * 4;
  if (version !== 4 || ihl < 20) return null;
  const srcIP = `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
  const protocol = buf[9];
  const outerTtl = buf[8];
  if (protocol !== 1) return { srcIP, protocol, outerTtl, type: null };
  const icmp = buf.subarray(ihl);
  if (icmp.length < 8) return { srcIP, protocol, outerTtl, type: null };
  const type = icmp[0];
  const code = icmp[1];
  let inner = null;
  if ((type === 11 || type === 3 || type === 5) && icmp.length >= 8 + 20) {
    const innerIP = icmp.subarray(8);
    if ((innerIP[0] >> 4) === 4) {
      const innerIPHL = (innerIP[0] & 0x0f) * 4;
      if (innerIPHL >= 20) {
        inner = {
          src: `${innerIP[12]}.${innerIP[13]}.${innerIP[14]}.${innerIP[15]}`,
          dst: `${innerIP[16]}.${innerIP[17]}.${innerIP[18]}.${innerIP[19]}`,
          ttl: innerIP[8],
          protocol: innerIP[9],
        };
      }
    }
  }
  return { srcIP, protocol, outerTtl, type, code, inner };
}

/**
 * 原生 ICMP 引擎
 * @param {string} host 目标 IP（IPv4）
 * @param {{ maxHops?: number, queries?: number, timeoutMs?: number, probePort?: number, signal?: AbortSignal, targetIP?: string }} options
 */
function traceWithIcmpSocket(host, options = {}) {
  const maxHops = options.maxHops || config.probe.traceMaxHops;
  const queries = options.queries || config.probe.traceQueries;
  const timeoutMs = options.timeoutMs || config.probe.traceTimeoutMs;
  const basePort = options.probePort || 33434;
  const dest = options.targetIP || host;

  return new Promise((resolve) => {
    const hops = new Map();
    let finished = false;
    let completed = false;
    let receiver = null;
    let probe = null;
    let wakeup = null;
    let hardTimer = null;
    let sendSequence = 0;

    const finish = (errorMessage) => {
      if (finished) return;
      finished = true;
      if (hardTimer) clearTimeout(hardTimer);
      try { receiver?.close(); } catch (_) { /* ignore */ }
      try { probe?.close(); } catch (_) { /* ignore */ }

      const list = [...hops.values()].sort((a, b) => a.ttl - b.ttl).map((h) => finalizeHop(h, queries));
      const responded = list.filter((h) => h.ip);
      const rtts = responded.map((h) => h.latency.avg).filter((v) => typeof v === 'number');
      const summary = {
        hopCount: list.length,
        respondedHops: responded.length,
        timeouts: list.filter((h) => h.isTimeout).length,
        destinationIP: dest,
        reachedTarget: completed || (list.length > 0 && list[list.length - 1].ip === dest),
        minRtt: rtts.length ? Math.min(...rtts) : null,
        maxRtt: rtts.length ? Math.max(...rtts) : null,
        avgRtt: rtts.length ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10) / 10 : null,
        lastHopIP: [...responded].reverse()[0]?.ip || null,
      };

      resolve({
        engine: 'icmp-socket',
        available: true,
        error: errorMessage || null,
        hops: list,
        summary,
        complete: completed,
        command: null,
      });
    };

    try {
      receiver = dgram.createSocket({ type: 'udp4', recvBufferSize: 256 * 1024 });
      probe = dgram.createSocket('udp4');
    } catch (error) {
      resolve({ engine: 'icmp-socket', available: false, error: `创建套接字失败：${error.message}`, hops: [], summary: null });
      return;
    }

    receiver.on('error', (error) => {
      const hint = error.code === 'EACCES' || error.code === 'EPERM' ? '（需要管理员/root 权限）' : '';
      finish(`原生套接字不可用：${error.code || error.message}${hint}`);
    });
    probe.on('error', (error) => {
      finish(`探测套接字异常：${error.code || error.message}`);
    });

    receiver.on('message', (msg) => {
      const info = describeIcmp(msg);
      if (!info) return;
      let ttl = info.inner ? info.inner.ttl : null;
      const type = info.type;

      if (type === 0) ttl = info.outerTtl; // 目标直接回显
      if (ttl === null || ttl === undefined || ttl < 1 || ttl > maxHops) return;
      if (![0, 3, 11].includes(type)) return;

      const hop = hops.get(ttl) || { ttl, ip: null, hostname: null, samples: [], codes: [] };
      if (!hop.ip) hop.ip = info.srcIP;
      const codeTag = type === 11 ? 'ttl-exceeded' : type === 0 ? 'echo-reply' : `unreachable-${info.code}`;
      if (!hop.codes.includes(codeTag)) hop.codes.push(codeTag);

      if (type === 3 && info.code === 3) {
        completed = true; // 端口不可达 → 已到达目标主机
        hop.ip = info.srcIP;
      }
      hops.set(ttl, hop);

      if (typeof wakeup === 'function') {
        const fn = wakeup;
        wakeup = null;
        fn({ ttl, info });
      }
    });

    hardTimer = setTimeout(() => finish('原生追踪达到硬超时，返回已收集的部分结果'), maxHops * queries * timeoutMs + 8000);

    const waitForReply = (ms) =>
      new Promise((resolveWait) => {
        const timer = setTimeout(() => {
          if (wakeup === onMessage) wakeup = null;
          resolveWait(null);
        }, ms);
        const onMessage = (payload) => {
          clearTimeout(timer);
          resolveWait(payload);
        };
        wakeup = onMessage;
      });

    // UDP socket 必须先 bind 才能设置 TTL（Windows 上尤其严格）
    probe.bind(0, '0.0.0.0', () => {
      receiver.bind({ address: '0.0.0.0', port: 0, exclusive: false }, async () => {
        try {
          receiver.setRecvTtl(true);
        } catch (_) {
          /* 非 Linux 平台无此 API：ICMP 回包内层 IP 头仍带 TTL，不影响解析 */
        }

        if (options.signal) {
          try {
            options.signal.addEventListener('abort', () => finish('任务已取消'), { once: true });
          } catch (_) {
            /* ignore */
          }
        }

        const sendProbe = (ttl) =>
          new Promise((resolveSend) => {
            sendSequence = (sendSequence + 1) % 1000;
            try {
              probe.setTTL(ttl);
            } catch (error) {
              resolveSend({ error });
              return;
            }
            const payload = Buffer.from(`NetScope ttl=${ttl} seq=${sendSequence}`);
            const sentAt = process.hrtime.bigint();
            probe.send(payload, basePort + (sendSequence % 100), host, (error) => {
              resolveSend({ error: error || null, sentAt });
            });
          });

        for (let ttl = 1; ttl <= maxHops; ttl += 1) {
          if (finished || completed) break;
          const hop = hops.get(ttl) || { ttl, ip: null, hostname: null, samples: [], codes: [] };
          hops.set(ttl, hop);

          let respondedThisTtl = false;
          for (let seq = 0; seq < queries; seq += 1) {
            if (finished || completed) break;
            const sendResult = await sendProbe(ttl);
            if (sendResult.error) {
              finish(`发送探测包失败：${sendResult.error.code || sendResult.error.message}`);
              return;
            }
            const reply = await waitForReply(timeoutMs);
            if (reply && reply.ttl === ttl) {
              const rtt = Number(process.hrtime.bigint() - sendResult.sentAt) / 1e6;
              if (rtt < timeoutMs * 1.5) hop.samples.push(Math.round(rtt * 10) / 10);
              respondedThisTtl = true;
            }
          }

          if (completed) break;
          if (!respondedThisTtl && ttl >= 3 && [...hops.values()].every((h) => !h.ip)) {
            finish('连续多跳无任何响应，目标网络可能屏蔽了 ICMP 探测');
            return;
          }
        }

        setTimeout(() => finish(null), 250);
      });
    });
  });
}

function finalizeHop(hop, queries) {
  const samples = hop.samples || [];
  const attempts = queries || 3;
  const responded = samples.length;
  const min = responded ? Math.min(...samples) : null;
  const max = responded ? Math.max(...samples) : null;
  const avg = responded ? samples.reduce((a, b) => a + b, 0) / responded : null;
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    ttl: hop.ttl,
    ip: hop.ip,
    hostname: hop.hostname || null,
    isTimeout: !hop.ip,
    codes: hop.codes || [],
    latency: {
      attempts,
      responded: hop.ip ? Math.max(responded, 1) : 0,
      lossPct: hop.ip ? Math.max(0, Math.round(((attempts - Math.max(responded, 1)) / attempts) * 1000) / 10) : 100,
      min: round(min),
      max: round(max),
      avg: round(avg),
      jitter: min !== null && max !== null ? round(max - min) : 0,
    },
  };
}

function pickLocalIP(targetIP) {
  try {
    const ifaces = os.networkInterfaces();
    const candidates = [];
    for (const addrs of Object.values(ifaces)) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
      }
    }
    if (!candidates.length) return null;
    // 与目标同网段优先
    const targetPrefix = targetIP.split('.').slice(0, 3).join('.');
    return candidates.find((c) => c.startsWith(targetPrefix)) || candidates[0];
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 对外统一入口                                                        */
/* ------------------------------------------------------------------ */

const traceCache = new Map();
const TRACE_CACHE_TTL_MS = 60 * 1000;

/**
 * 路由追踪
 * @param {string} host 目标主机（域名或 IP）
 * @param {{ maxHops?: number, queries?: number, timeoutMs?: number, resolveNames?: boolean, signal?: AbortSignal, engine?: 'auto'|'system'|'socket', useCache?: boolean, onProgress?: Function }} options
 */
async function traceRoute(host, options = {}) {
  const target = String(host || '').trim();
  if (!target) throw new Error('追踪目标不能为空');

  const engine = options.engine || 'auto';
  const cacheKey = `${target}|${options.maxHops || config.probe.traceMaxHops}|${engine}`;
  if (options.useCache !== false) {
    const hit = traceCache.get(cacheKey);
    if (hit && Date.now() - hit.at < TRACE_CACHE_TTL_MS) {
      return { ...hit.value, cached: true };
    }
  }

  const result = await runTrace(target, { ...options, engine });

  if (!result.error && result.hops.length) {
    traceCache.set(cacheKey, { at: Date.now(), value: result });
    if (traceCache.size > 100) {
      const oldest = [...traceCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) traceCache.delete(oldest[0]);
    }
  }
  return result;
}

async function runTrace(target, options) {
  const isIP = isIPv4(target);
  const engine = options.engine || 'auto';

  const attempts = [];
  const wantSocket = engine === 'socket' || (engine === 'auto' && socketEngineSupported());
  if (wantSocket) attempts.push('socket');
  if (engine === 'system' || engine === 'auto') attempts.push('system');
  if (!attempts.length) attempts.push('socket', 'system');

  const errors = [];
  let partial = null;

  for (const attempt of attempts) {
    if (options.signal?.aborted) break;
    let result;
    if (attempt === 'socket') {
      // 首次使用前先做一次轻量能力探测；不可用则立刻回退，不浪费时间
      if (engine === 'auto') {
        const usable = await probeSocketCapability();
        if (!usable) {
          errors.push(socketCapability.note);
          continue;
        }
      }
      result = await traceWithIcmpSocket(target, options);
      if (!result.available) {
        errors.push(result.error || '原生套接字引擎不可用');
        continue;
      }
      if (!result.hops.some((h) => h.ip)) {
        errors.push(result.error || '原生套接字引擎未收到任何 ICMP 响应');
        // 保留部分结果（例如只探到若干跳无响应）作为兜底
        if (result.hops.length && !partial) partial = result;
        continue;
      }
    } else {
      result = await traceWithSystemCommand(target, { ...options, targetIP: isIP ? target : options.targetIP });
      if (!result.available) {
        errors.push(result.error);
        continue;
      }
      if (!result.hops.length) {
        errors.push('系统命令引擎未返回任何跳点，可能目标不可达或输出解析失败');
        continue;
      }
    }

    const trace = await enrichTrace(result, options);
    trace.fallbackNotes = errors.slice();
    return trace;
  }

  if (partial) {
    const trace = await enrichTrace(partial, options);
    trace.partial = true;
    trace.fallbackNotes = errors.slice();
    return trace;
  }

  return {
    engine: attempts[attempts.length - 1] || 'none',
    available: false,
    error: errors.join('；') || '路由追踪失败',
    hops: [],
    summary: null,
    fallbackNotes: errors.slice(),
  };
}

/**
 * 后处理：反向 DNS、地理位置、地址性质标注
 */
async function enrichTrace(trace, options = {}) {
  const resolveNames = options.resolveNames !== false;
  const hops = trace.hops || [];

  // 反向 DNS（并发 8）
  if (resolveNames) {
    const targets = hops.filter((h) => h.ip && !h.hostname);
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const hop = targets[cursor];
        cursor += 1;
        hop.hostname = await reverseLookup(hop.ip, 2500);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
  }

  for (const hop of hops) {
    hop.classification = hop.ip ? classifyIP(hop.ip) : null;
    if (hop.classification) {
      hop.hostname = hop.hostname || (hop.classification.label ? null : null);
    }
  }

  return trace;
}

module.exports = {
  traceRoute,
  traceWithSystemCommand,
  traceWithIcmpSocket,
  buildSystemTraceArgs,
  describeIcmp,
  checksum,
  buildIcmpEcho,
  socketEngineSupported,
  probeSocketCapability,
  socketCapabilityInfo,
  finalizeHop,
  pickLocalIP,
};
