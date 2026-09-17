'use strict';

/**
 * REST / SSE 路由表
 * 所有接口都返回统一的 { ok, ... } 结构，错误返回 { ok:false, error }
 */

const os = require('os');
const tls = require('tls');
const crypto = require('crypto');

const config = require('../config');
const geo = require('../core/geo');
const sysinfo = require('../core/sysinfo');
const reachability = require('../core/reachability');
const dnsTool = require('../core/dns');
const orchestrator = require('../core/orchestrator');
const { parseTarget, classifyIP, isIP } = require('../core/iputils');
const { captureCapability } = require('../core/exec');
const { createTask, finishTask, cancelTask, getTask, runningCount, listTasks } = require('../tasks');
const { sendJSON, sendError, readBody, openSSE, parseQuery, parseIntParam, boolParam } = require('../http-utils');

const MAX_CONCURRENT_TRACES = 4;
const MAX_CONCURRENT_SCANS = 2;

/* ------------------------------------------------------------------ */
/* 健康检查与自检                                                      */
/* ------------------------------------------------------------------ */

async function health() {
  return {
    ok: true,
    name: 'NetScope',
    version: require('../../package.json').version,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    capabilities: captureCapability(),
    geo: geo.cacheStats(),
    running: { traces: runningCount('trace'), scans: runningCount('scan') },
  };
}

/**
 * 自检：探测各数据源与引擎在当前网络中的可用性
 */
async function selfTest() {
  const started = Date.now();
  const checks = [];

  // 1) DNS
  const dnsStarted = Date.now();
  const dnsResult = await reachability.resolveHostname('www.baidu.com', { timeoutMs: 4000 }).catch((e) => ({ addresses: [], errors: [e.message] }));
  checks.push({
    name: 'DNS 解析',
    ok: Boolean(dnsResult.addresses && dnsResult.addresses.length),
    detail: dnsResult.addresses && dnsResult.addresses.length ? dnsResult.addresses.map((a) => a.address).join(', ') : '解析失败',
    durationMs: Date.now() - dnsStarted,
  });

  // 2) ICMP ping
  const pingStarted = Date.now();
  const ping = await reachability.icmpPing('223.5.5.5', { count: 2, timeoutMs: 1500 }).catch((e) => ({ alive: false, error: e.message }));
  checks.push({
    name: 'ICMP Ping',
    ok: Boolean(ping.alive),
    detail: ping.alive ? `平均 ${ping.avg} ms / 丢包 ${ping.lossPct}%` : ping.error || '无响应',
    durationMs: Date.now() - pingStarted,
  });

  // 3) TCP 探测
  const tcpStarted = Date.now();
  const tcp = await reachability.tcpProbe('223.5.5.5', 443, 3000);
  checks.push({
    name: 'TCP 端口探测',
    ok: Boolean(tcp.open),
    detail: tcp.open ? `443 端口开放，时延 ${tcp.latencyMs} ms` : tcp.error || tcp.state,
    durationMs: Date.now() - tcpStarted,
  });

  // 4) HTTPS 出口
  const httpStarted = Date.now();
  const httpResult = await reachability.httpProbe('www.baidu.com', { port: 443, tls: true, timeoutMs: 6000 }).catch((e) => ({ ok: false, error: e.message }));
  checks.push({
    name: 'HTTPS 出站',
    ok: Boolean(httpResult.ok),
    detail: httpResult.ok ? `HTTP ${httpResult.statusCode}，TTFB ${httpResult.ttfbMs} ms` : httpResult.error,
    durationMs: Date.now() - httpStarted,
  });

  // 5) 地理定位服务（逐个尝试）
  const geoStarted = Date.now();
  const geoProbe = await geo.resolveIP('1.1.1.1');
  checks.push({
    name: '地理定位服务',
    ok: typeof geoProbe.lat === 'number',
    detail: typeof geoProbe.lat === 'number'
      ? `${geoProbe.provider} → ${geoProbe.city || geoProbe.country || '未知'}（${geoProbe.lat}, ${geoProbe.lon}）${geoProbe.cached ? ' [缓存]' : ''}`
      : geoProbe.note || '不可用',
    durationMs: Date.now() - geoStarted,
  });

  // 6) 命令输出捕获策略
  checks.push({
    name: '命令输出捕获',
    ok: true,
    detail: `可用策略：${captureCapability().shellExe ? 'shell-file' : 'pipe'}${captureCapability().pipeBlocked ? '（管道被环境禁止，已自动切换为文件重定向）' : ''}`,
    durationMs: 0,
  });

  // 7) 路由追踪引擎
  const traceStarted = Date.now();
  const traceProbe = await require('../core/trace').traceRoute('223.5.5.5', { maxHops: 6, queries: 1, timeoutMs: 800, resolveNames: false, useCache: false });
  checks.push({
    name: '路由追踪引擎',
    ok: traceProbe.hops.length > 0,
    detail: traceProbe.hops.length > 0 ? `${traceProbe.engine} 引擎，返回 ${traceProbe.hops.length} 跳` : traceProbe.error || '失败',
    durationMs: Date.now() - traceStarted,
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    durationMs: Date.now() - started,
    platform: process.platform,
  };
}

/* ------------------------------------------------------------------ */
/* 目标解析与探测                                                      */
/* ------------------------------------------------------------------ */

async function analyze(body) {
  const input = body.target || body.input || body.url;
  if (!input) throw Object.assign(new Error('缺少 target 参数'), { statusCode: 400 });
  return orchestrator.analyzeTarget(input, body);
}

async function probe(body) {
  const input = body.target || body.input || body.url;
  if (!input) throw Object.assign(new Error('缺少 target 参数'), { statusCode: 400 });
  const target = await orchestrator.analyzeTarget(input, body);
  if (target.blocked) throw Object.assign(new Error(target.blockedReason), { statusCode: 403 });

  const probeResult = await reachability.probeTarget(target, {
    pingCount: body.pingCount || config.probe.pingCount,
    skipPing: body.skipPing === true,
    skipHttp: body.skipHttp === true,
  });

  const ips = [target.primaryIP, ...probeResult.tcp.map(() => null)].filter(Boolean);
  const [geoMap, local] = await Promise.all([
    orchestrator.geolocate([...new Set(ips)], {}),
    orchestrator.localAnchorInfo().catch(() => null),
  ]);
  if (local && local.location) orchestrator.applyPrivateAnchor(geoMap, local.location);
  return { target, probe: probeResult, geo: geoMap };
}

/* ------------------------------------------------------------------ */
/* 路由追踪（同步 + SSE 流式 + 任务管理）                              */
/* ------------------------------------------------------------------ */

function startTraceTask(target, options) {
  const task = createTask('trace', { target, options });
  const emitter = options.emitter || null;

  // SSE 事件名与 stage 一致（start / hop / done / error / canceled），
  // 前端据此分派处理；payload 内仍保留 stage 字段便于统一解析。
  const emit = (stage, payload) => {
    if (emitter && emitter.isOpen()) return emitter.send(stage, { stage, ...payload });
    return false;
  };

  (async () => {
    try {
      emit('start', { message: `开始追踪到 ${target} 的路由`, taskId: task.id });
      const trace = await reachability.resolveHostname(target, { timeoutMs: 5000 }).catch(() => ({ addresses: [] }));
      const primary = (trace.addresses || []).find((a) => a.family === 4) || (trace.addresses || [])[0] || null;
      const targetIP = primary ? primary.address : (isIP(target) ? target : null);

      const result = await require('../core/trace').traceRoute(target, {
        maxHops: options.maxHops,
        queries: options.queries,
        timeoutMs: options.timeoutMs,
        resolveNames: options.resolveNames,
        signal: task.signal,
        engine: options.engine,
        useCache: options.useCache !== false,
        targetIP: targetIP || undefined,
      });

      if (task.signal.aborted) {
        finishTask(task, { status: 'canceled', error: new Error(task.cancelReason || '已取消') });
        emit('canceled', { message: '任务已取消' });
        return;
      }

      // 逐跳推送地理信息，前端边收边画（分批推送，控制单条事件体积）
      const hopIPs = (result.hops || []).map((h) => h.ip).filter(Boolean);
      const [geoMap, local] = await Promise.all([
        orchestrator.geolocate([...new Set(hopIPs)], { signal: task.signal }),
        orchestrator.localAnchorInfo(),
      ]);
      // 私有地址（本机内网、网关）按公网出口位置落点，避免世界地图上出现跨洲假连线
      orchestrator.applyPrivateAnchor(geoMap, local.location);
      const slimHops = [];
      for (const hop of result.hops || []) {
        if (hop.ip && geoMap[hop.ip]) hop.geo = geoMap[hop.ip];
        // 推送时剔除冗长的原始命令行文本，减小单条事件体积（完整内容仍可通过结果接口获取）
        const { raw, ...slim } = hop;
        slimHops.push(slim);
      }
      emitHopsInBatches(emitter, slimHops);

      const payload = {
        target,
        targetIP,
        trace: { ...result, hops: slimHops },
        geo: geoMap,
        local,
      };
      task.result = payload;
      finishTask(task, { result: payload });

      // done 事件携带完整结果；逐跳数据已分批推送，前端可边收边画
      emit('done', {
        ok: true,
        taskId: task.id,
        resultUrl: `/api/result?taskId=${task.id}`,
        target,
        targetIP,
        engine: result.engine,
        summary: result.summary,
        hopCount: slimHops.length,
        local,
        fallbackNotes: result.fallbackNotes || [],
        result: payload,
      });
    } catch (error) {
      finishTask(task, { error });
      emit('error', { ok: false, error: error.message || String(error) });
    } finally {
      // 留出时间让最后的事件写入内核缓冲，再关闭连接
      if (emitter) setTimeout(() => emitter.close(), 300);
    }
  })();

  return task;
}

/** SSE：/api/trace/stream?target=... */
async function traceStream(req, res, ctx) {
  const query = parseQuery(req.url);
  const target = query.target || query.input;
  if (!target) {
    sendError(res, 400, '缺少 target 查询参数');
    return;
  }
  if (runningCount('trace') >= MAX_CONCURRENT_TRACES) {
    sendError(res, 429, `并发追踪任务已达上限（${MAX_CONCURRENT_TRACES}），请稍后再试`);
    return;
  }

  const options = {
    maxHops: parseIntParam(query.maxHops, config.probe.traceMaxHops, 1, 64),
    queries: parseIntParam(query.queries, config.probe.traceQueries, 1, 5),
    timeoutMs: parseIntParam(query.timeoutMs, config.probe.traceTimeoutMs, 200, 5000),
    resolveNames: boolParam(query.resolveNames, true),
    engine: ['auto', 'socket', 'system'].includes(query.engine) ? query.engine : 'auto',
  };

  const emitter = openSSE(res, req);
  const task = startTraceTask(target, { ...options, emitter });
  emitter.send('task', { taskId: task.id, target, options });

  res.on('close', () => {
    if (getTask(task.id)?.status === 'running') cancelTask(task.id, '客户端断开连接');
  });
}

/** 同步追踪：POST /api/trace */
async function traceSync(body) {
  const input = body.target || body.input || body.url;
  if (!input) throw Object.assign(new Error('缺少 target 参数'), { statusCode: 400 });
  if (runningCount('trace') >= MAX_CONCURRENT_TRACES) {
    throw Object.assign(new Error(`并发追踪任务已达上限（${MAX_CONCURRENT_TRACES}）`), { statusCode: 429 });
  }
  const target = await orchestrator.analyzeTarget(input, body);
  if (target.blocked) throw Object.assign(new Error(target.blockedReason), { statusCode: 403 });

  const task = startTraceTask(target.primaryIP || target.host, {
    maxHops: body.maxHops || config.probe.traceMaxHops,
    queries: body.queries || config.probe.traceQueries,
    timeoutMs: body.traceTimeoutMs || config.probe.traceTimeoutMs,
    resolveNames: body.resolveNames !== false,
    engine: body.engine || 'auto',
    useCache: body.useCache !== false,
  });

  // 等待任务结束
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const t = getTask(task.id);
      if (!t || t.status !== 'running') {
        clearInterval(timer);
        resolve();
      }
    }, 120);
    if (timer.unref) timer.unref();
  });

  const finished = getTask(task.id);
  if (!finished || finished.status === 'failed') {
    throw new Error(finished?.error || '追踪失败');
  }
  return { ...finished.result, target };
}

function cancelTaskById(id) {
  const task = cancelTask(id);
  if (!task) throw Object.assign(new Error('任务不存在或已结束'), { statusCode: 404 });
  return { ok: true, taskId: id, status: 'canceling' };
}

/**
 * 获取任务结果
 * SSE 的 done 事件只推送“结论级”摘要，完整数据（含逐跳原始输出）由本接口提供，
 * 这样可以把单条 SSE 事件控制在较小体积，避免大事件在连接关闭时被截断。
 */
async function taskResult(query) {
  const id = query.taskId;
  if (!id) throw Object.assign(new Error('缺少 taskId 参数'), { statusCode: 400 });
  const task = getTask(id);
  if (!task) throw Object.assign(new Error('任务不存在或结果已过期（服务重启或任务过多被清理）'), { statusCode: 404 });
  if (task.status === 'running') {
    return { ok: true, status: 'running', progress: task.progress, taskId: id };
  }
  if (task.status === 'failed') {
    throw Object.assign(new Error(task.error || '任务失败'), { statusCode: 500 });
  }
  return { ok: true, status: task.status, taskId: id, result: task.result };
}

/* ------------------------------------------------------------------ */
/* 地理定位                                                            */
/* ------------------------------------------------------------------ */

async function geolocate(body) {
  const list = Array.isArray(body.ips) ? body.ips : (body.ip ? [body.ip] : []);
  if (!list.length) throw Object.assign(new Error('缺少 ip 或 ips 参数'), { statusCode: 400 });
  if (list.length > 256) throw Object.assign(new Error('单次最多查询 256 个地址'), { statusCode: 400 });
  const [map, local] = await Promise.all([
    geo.resolveMany(list, {}),
    orchestrator.localAnchorInfo().catch(() => null),
  ]);
  const results = Object.fromEntries(map);
  // 私有地址统一按公网出口位置落点，保证与追踪结果、地图显示一致
  if (local && local.location) orchestrator.applyPrivateAnchor(results, local.location);
  return { ok: true, results, cache: geo.cacheStats() };
}

/* ------------------------------------------------------------------ */
/* 本机网络拓扑                                                        */
/* ------------------------------------------------------------------ */

async function localNetwork(query) {
  const includePorts = boolParam(query.includePorts, false);
  const includeNeighbors = boolParam(query.includeNeighbors, true);
  const info = await sysinfo.discoverLocalNetwork({
    includePorts,
    includeNeighbors,
    includePublicIP: boolParam(query.includePublicIP, true),
    includeRoute: boolParam(query.includeRoute, true),
  });

  // 为网关、公网 IP、邻居补充地理信息，便于地图展示
  const ips = [info.publicIP?.ip, ...info.gateways].filter(Boolean);
  const geoMap = await orchestrator.geolocate([...new Set(ips)], {});
  // info.localLocation 已按公网出口定位，用它统一私有地址落点
  if (info.localLocation) orchestrator.applyPrivateAnchor(geoMap, info.localLocation);
  info.geo = geoMap;
  info.nodes = {
    self: info.interfaces.filter((i) => i.family === 'IPv4').map((i) => ({ ip: i.address, interface: i.name, mac: i.mac, cidr: i.cidr })),
    gateways: info.gateways,
    dns: info.dnsServers,
    neighbors: info.neighbors,
  };
  return info;
}

/** 本机出口信息（快速版） */
async function egress() {
  const publicIP = await sysinfo.detectPublicIP({ timeoutMs: 5000 });
  const geoInfo = publicIP.ip ? await geo.resolveIP(publicIP.ip) : null;
  return { ok: true, publicIP, geo: geoInfo, local: geo.localAnchor() };
}

/* ------------------------------------------------------------------ */
/* DNS                                                                 */
/* ------------------------------------------------------------------ */

async function dnsAnalyze(body) {
  const domain = body.domain || body.target;
  if (!domain) throw Object.assign(new Error('缺少 domain 参数'), { statusCode: 400 });
  const parsed = parseTarget(domain);
  const report = await dnsTool.analyzeDomain(parsed.host, { timeoutMs: body.timeoutMs || 5000 });
  const addressList = report.summary.addresses || [];
  const geoMap = addressList.length ? await orchestrator.geolocate(addressList, {}) : {};
  return { ...report, geo: geoMap, local: dnsTool.localDnsConfig() };
}

async function dnsCompare(body) {
  const domain = body.domain || body.target;
  if (!domain) throw Object.assign(new Error('缺少 domain 参数'), { statusCode: 400 });
  const servers = Array.isArray(body.servers) && body.servers.length ? body.servers : dnsTool.localDnsConfig().servers.filter((s) => !s.includes(':'));
  const report = await dnsTool.compareResolvers(parseTarget(domain).host, servers, { timeoutMs: body.timeoutMs || 4000 });
  const allIPs = [...new Set(report.resolvers.flatMap((r) => r.addresses))];
  const geoMap = allIPs.length ? await orchestrator.geolocate(allIPs, {}) : {};
  return { ...report, geo: geoMap };
}

/** SSE：/api/dns/delegation/stream?domain=example.com */
async function dnsDelegationStream(req, res) {
  const query = parseQuery(req.url);
  const domain = query.domain || query.target;
  if (!domain) {
    sendError(res, 400, '缺少 domain 查询参数');
    return;
  }
  const emitter = openSSE(res, req);
  emitter.send('start', { domain });
  try {
    const result = await dnsTool.traceDelegation(parseTarget(domain).host, {
      timeoutMs: parseIntParam(query.timeoutMs, 4000, 500, 10000),
      onStep: (step, record) => emitter.send('step', { step, record }),
    });
    const ips = [...new Set(result.chain.flatMap((s) => s.servers.map((x) => x.serverIP)))];
    const geoMap = await orchestrator.geolocate(ips, {});
    emitter.send('done', { ok: true, result, geo: geoMap });
  } catch (error) {
    emitter.error(error.message || String(error));
    return;
  }
  emitter.close();
}

/* ------------------------------------------------------------------ */
/* 端口扫描                                                            */
/* ------------------------------------------------------------------ */

async function portScan(body) {
  const input = body.target || body.input;
  if (!input) throw Object.assign(new Error('缺少 target 参数'), { statusCode: 400 });
  if (runningCount('scan') >= MAX_CONCURRENT_SCANS) {
    throw Object.assign(new Error(`并发扫描任务已达上限（${MAX_CONCURRENT_SCANS}）`), { statusCode: 429 });
  }
  const target = await orchestrator.analyzeTarget(input, body);
  if (target.blocked) throw Object.assign(new Error(target.blockedReason), { statusCode: 403 });
  const task = createTask('scan', { target: target.host, mode: body.mode || 'quick' });
  try {
    const result = await reachability.scanPorts(target.primaryIP || target.host, {
      mode: body.mode || 'quick',
      ports: body.ports,
      from: body.from,
      to: body.to,
      timeoutMs: body.timeoutMs || config.probe.portScanTimeoutMs,
      signal: task.signal,
      onProgress: (p) => {
        task.progress = p;
      },
    });
    finishTask(task, { result });
    return { ok: true, target, scan: result, taskId: task.id };
  } catch (error) {
    finishTask(task, { error });
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 安全与证书                                                          */
/* ------------------------------------------------------------------ */

function inspectCertificate(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate(true);
        const cipher = socket.getCipher();
        const protocol = socket.getProtocol();
        const authorized = socket.authorized;
        const authorizationError = socket.authorizationError;
        socket.end();
        if (!cert || !cert.subject) {
          resolve({ ok: false, error: '未获取到证书' });
          return;
        }
        const chain = [];
        let node = cert;
        const seen = new Set();
        while (node && node.subject && !seen.has(node.fingerprint)) {
          seen.add(node.fingerprint);
          chain.push({
            subject: node.subject,
            issuer: node.issuer,
            validFrom: node.valid_from,
            validTo: node.valid_to,
            fingerprint: node.fingerprint,
            serialNumber: node.serialNumber,
            subjectAltName: node.subjectaltname || null,
          });
          node = node.issuerCertificate;
          if (node === cert) break;
        }
        const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
        const daysRemaining = validTo ? Math.round((validTo.getTime() - Date.now()) / 86400000) : null;
        resolve({
          ok: true,
          authorized,
          authorizationError: authorizationError ? String(authorizationError) : null,
          protocol,
          cipher: cipher ? { name: cipher.name, version: cipher.version } : null,
          subject: cert.subject,
          issuer: cert.issuer,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          daysRemaining,
          expired: daysRemaining !== null && daysRemaining < 0,
          subjectAltName: cert.subjectaltname ? cert.subjectaltname.split(',').map((s) => s.trim()) : [],
          chain,
        });
      },
    );
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, error: 'TLS 握手超时' });
    });
    socket.on('error', (error) => resolve({ ok: false, error: error.code || error.message }));
  });
}

async function securityReport(body) {
  const input = body.target || body.input;
  if (!input) throw Object.assign(new Error('缺少 target 参数'), { statusCode: 400 });
  const target = await orchestrator.analyzeTarget(input, body);
  const primaryIP = target.primaryIP || target.host;

  const port = target.port || 443;
  const cert = await inspectCertificate(primaryIP, port, body.timeoutMs || 8000);

  const [reverse, geoInfo, http] = await Promise.all([
    reachability.reverseLookup(primaryIP, 3000),
    geo.resolveIP(primaryIP),
    reachability.httpProbe(primaryIP, { port, tls: true, timeoutMs: body.timeoutMs || 8000 }),
  ]);

  const observations = [];
  if (!cert.ok) observations.push(`TLS 证书检查失败：${cert.error}`);
  else {
    if (cert.expired) observations.push(`证书已过期（${cert.validTo}）`);
    else if (cert.daysRemaining !== null && cert.daysRemaining < 30) observations.push(`证书将在 ${cert.daysRemaining} 天后过期，建议提前续期`);
    if (!cert.authorized) observations.push(`证书链校验未通过：${cert.authorizationError || '未知原因'}（自签名或链不完整时常见）`);
    if (cert.protocol && /TLSv1(\.[01])?$/i.test(cert.protocol) && !/1\.[23]/.test(cert.protocol)) observations.push(`TLS 协议版本偏低：${cert.protocol}`);
  }
  if (http.ok && http.headers['server']) observations.push(`服务端标识：${http.headers['server']}`);
  if (http.headers && http.headers['strict-transport-security']) observations.push('已启用 HSTS');
  else if (http.ok) observations.push('未发现 HSTS 响应头，建议站点启用强制 HTTPS');

  return {
    ok: true,
    target,
    primaryIP,
    reverseDns: reverse,
    geo: geoInfo,
    certificate: cert,
    http,
    observations,
    summary: {
      riskLevel: observations.some((o) => /过期|失败|未通过/.test(o)) ? 'medium' : 'low',
      issueCount: observations.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 完整诊断                                                            */
/* ------------------------------------------------------------------ */

async function diagnoseSync(body) {
  const input = body.target || body.input || body.url;
  if (!input) throw Object.assign(new Error('缺少 target 参数'), { statusCode: 400 });
  if (runningCount('trace') >= MAX_CONCURRENT_TRACES) {
    throw Object.assign(new Error(`并发任务已达上限（${MAX_CONCURRENT_TRACES}）`), { statusCode: 429 });
  }
  return orchestrator.diagnose(input, body);
}

/**
 * 分批推送跳点：把逐跳数据按固定条数切分成多条 SSE 事件。
 * 单条事件保持在数 KB 以内，避免超大事件在连接关闭时被截断。
 */
function emitHopsInBatches(emitter, hops, batchSize = 3, extra = {}) {
  if (!emitter || !emitter.isOpen()) return 0;
  let sent = 0;
  for (let i = 0; i < hops.length; i += batchSize) {
    const batch = hops.slice(i, i + batchSize);
    emitter.send('progress', {
      stage: 'hops',
      hops: batch,
      from: i + 1,
      to: i + batch.length,
      total: hops.length,
      ...extra,
    });
    sent += batch.length;
  }
  return sent;
}

/**
 * 精简结果：SSE 的 done 事件只带结论级信息 + 结果获取地址
 */
function compactResult(result) {
  return {
    input: result.input,
    target: result.target
      ? {
          host: result.target.host,
          port: result.target.port,
          protocol: result.target.protocol,
          primaryIP: result.target.primaryIP,
          classification: result.target.classification,
          dns: { addresses: result.target.addresses, cname: result.target.dns?.cname || null, durationMs: result.target.dns?.durationMs },
        }
      : null,
    probe: result.probe
      ? {
          ping: result.probe.ping,
          reverseDns: result.probe.reverseDns,
          tcp: result.probe.tcp,
          http: result.probe.http,
        }
      : null,
    trace: result.trace
      ? {
          engine: result.trace.engine,
          summary: result.trace.summary,
          hopCount: (result.trace.hops || []).length,
          fallbackNotes: result.trace.fallbackNotes || [],
        }
      : null,
    portScan: result.portScan
      ? {
          durationMs: result.portScan.durationMs,
          total: result.portScan.total,
          openCount: result.portScan.open.length,
          openPorts: result.portScan.open.map((p) => ({ port: p.port, service: p.service, latencyMs: p.latencyMs })),
        }
      : null,
    local: result.local,
    generatedAt: result.generatedAt,
  };
}

/** SSE：/api/diagnose/stream?target=... 完整流程流式推送 */
async function diagnoseStream(req, res) {
  const query = parseQuery(req.url);
  const input = query.target || query.input;
  if (!input) {
    sendError(res, 400, '缺少 target 查询参数');
    return;
  }
  if (runningCount('trace') >= MAX_CONCURRENT_TRACES) {
    sendError(res, 429, `并发任务已达上限（${MAX_CONCURRENT_TRACES}）`);
    return;
  }
  const emitter = openSSE(res, req);
  const task = createTask('trace', { input, mode: 'diagnose' });
  emitter.send('task', { taskId: task.id, input });

  res.on('close', () => {
    if (getTask(task.id)?.status === 'running') cancelTask(task.id, '客户端断开连接');
  });

  let hopsSent = false;
  try {
    const result = await orchestrator.diagnose(input, {
      ...query,
      maxHops: parseIntParam(query.maxHops, config.probe.traceMaxHops, 1, 64),
      queries: parseIntParam(query.queries, config.probe.traceQueries, 1, 5),
      includePortScan: boolParam(query.includePortScan, false),
      portScanMode: query.portScanMode || 'quick',
      resolveNames: boolParam(query.resolveNames, true),
      signal: task.signal,
      engine: ['auto', 'socket', 'system'].includes(query.engine) ? query.engine : 'auto',
      onProgress: (p) => emitter.send('progress', p),
      onTraceResult: (trace) => {
        // 追踪一结束就把跳点分批推给前端，边收边画
        hopsSent = true;
        emitHopsInBatches(emitter, trace.hops || []);
      },
    });

    finishTask(task, { result });
    const compact = compactResult(result);
    emitter.send('done', {
      ok: true,
      taskId: task.id,
      resultUrl: `/api/result?taskId=${task.id}`,
      stage: 'done',
      summary: compact,
      result,
    });
  } catch (error) {
    finishTask(task, { error });
    emitter.send('error', { ok: false, error: error.message || String(error) });
  } finally {
    setTimeout(() => emitter.close(), 400);
  }
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

const routes = [
  { method: 'GET', path: '/api/health', handler: async () => health() },
  { method: 'GET', path: '/api/selftest', handler: async () => selfTest() },
  { method: 'GET', path: '/api/tasks', handler: async () => ({ ok: true, tasks: listTasks() }) },
  { method: 'GET', path: '/api/result', handler: async (req) => taskResult(parseQuery(req.url)) },

  { method: 'POST', path: '/api/analyze', handler: async (req, res, ctx) => analyze(await readBody(req)) },
  { method: 'POST', path: '/api/probe', handler: async (req) => probe(await readBody(req)) },
  { method: 'POST', path: '/api/trace', handler: async (req) => traceSync(await readBody(req)) },
  { method: 'GET', path: '/api/trace/stream', handler: async (req, res, ctx) => traceStream(req, res, ctx) },

  { method: 'POST', path: '/api/geo', handler: async (req) => geolocate(await readBody(req)) },
  { method: 'GET', path: '/api/local', handler: async (req) => localNetwork(parseQuery(req.url)) },
  { method: 'GET', path: '/api/egress', handler: async () => egress() },

  { method: 'POST', path: '/api/dns', handler: async (req) => dnsAnalyze(await readBody(req)) },
  { method: 'POST', path: '/api/dns/compare', handler: async (req) => dnsCompare(await readBody(req)) },
  { method: 'GET', path: '/api/dns/delegation/stream', handler: async (req, res) => dnsDelegationStream(req, res) },

  { method: 'POST', path: '/api/portscan', handler: async (req) => portScan(await readBody(req)) },
  { method: 'POST', path: '/api/security', handler: async (req) => securityReport(await readBody(req)) },
  { method: 'POST', path: '/api/diagnose', handler: async (req) => diagnoseSync(await readBody(req)) },
  { method: 'GET', path: '/api/diagnose/stream', handler: async (req, res) => diagnoseStream(req, res) },
  { method: 'POST', path: '/api/cancel', handler: async (req) => {
    const body = await readBody(req);
    return cancelTaskById(body.taskId);
  } },
];

module.exports = { routes, health, selfTest };
