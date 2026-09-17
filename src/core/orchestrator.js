'use strict';

/**
 * 任务编排层：把“解析目标 → 连通性探测 → 路由追踪 → 地理定位”串成完整流程，
 * 供 HTTP API、SSE 流式接口与 CLI 复用。
 */

const { parseTarget, classifyIP } = require('./iputils');
const reachability = require('./reachability');
const { traceRoute } = require('./trace');
const geo = require('./geo');
const sysinfo = require('./sysinfo');
const config = require('../config');

/**
 * 解析用户输入，并补充 DNS 与地址性质信息
 */
async function analyzeTarget(input, options = {}) {
  const target = parseTarget(input);
  const dnsInfo = await reachability.resolveHostname(target.host, { timeoutMs: options.dnsTimeoutMs || 6000 });

  const addresses = dnsInfo.addresses || [];
  const primary = addresses.find((a) => a.family === 4) || addresses[0] || null;

  if (!target.port) {
    target.port = target.defaultPort;
  }

  const classification = primary ? classifyIP(primary.address) : null;
  const blocked = classification && !classification.isPublic && !config.security.allowPrivateTargets;

  return {
    ...target,
    dns: dnsInfo,
    addresses,
    primaryIP: primary ? primary.address : null,
    ipFamily: primary ? primary.family : null,
    classification,
    blocked,
    blockedReason: blocked ? '策略禁止探测私有/保留地址（可通过 NETSCOPE_ALLOW_PRIVATE_TARGETS=1 放开）' : null,
    analyzedAt: new Date().toISOString(),
  };
}

/**
 * 获取本机位置锚点（用于地图上起点标记）
 *
 * 注意：私有地址（本机回环、局域网网关、内网 DNS）在 geo.resolveIP 中会落到
 * “本机时区城市”。但对一张世界地图来说，本机真正该出现的位置是公网出口所在地，
 * 因此这里统一把私有地址的地理信息改锚到出口位置，避免出现跨洲的假连线。
 */
async function localAnchorInfo() {
  const interfaces = sysinfo.listInterfaces();
  let location;
  try {
    location = await geo.resolveLocalAnchor();
  } catch (_) {
    const anchor = geo.localAnchor();
    location = {
      lat: anchor.lat,
      lon: anchor.lon,
      city: anchor.city,
      country: anchor.country,
      countryCode: anchor.countryCode,
      timezone: anchor.timezone,
      source: 'local-timezone',
      precision: 'city',
    };
  }
  return {
    hostname: require('os').hostname(),
    interfaces,
    location,
  };
}

/**
 * 把补丁应用到私有地址的地理信息上（原地修改 geoMap）
 * @param {Record<string, any>} geoMap
 */
function applyPrivateAnchor(geoMap, anchor) {
  if (!geoMap || !anchor || typeof anchor.lat !== 'number') return geoMap;
  for (const ip of Object.keys(geoMap)) {
    const info = geoMap[ip];
    if (!info) continue;
    if (info.status === 'private' || (info.classification && info.classification.isPrivate)) {
      info.lat = anchor.lat;
      info.lon = anchor.lon;
      info.city = anchor.city || info.city;
      info.country = anchor.country || info.country;
      info.countryCode = anchor.countryCode || info.countryCode;
      info.provider = anchor.source || info.provider;
      info.anchoredToEgress = true;
      info.note = `私有地址，已按公网出口位置（${anchor.city || '未知'}）落点`;
    }
  }
  return geoMap;
}

/**
 * 给一组 IP 补充地理信息
 * @param {Array<string|null>} ips
 */
async function geolocate(ips, options = {}) {
  const list = ips.filter(Boolean);
  const map = await geo.resolveMany(list, options);
  return Object.fromEntries(map);
}

/**
 * 完整诊断流程（非流式）：解析 → 探测 → 追踪 → 地理定位 → 拓扑图数据
 * @param {string} input
 * @param {{ onProgress?: Function, signal?: AbortSignal, maxHops?: number, queries?: number, includePortScan?: boolean, portScanMode?: string }} options
 */
async function diagnose(input, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal;

  onProgress({ stage: 'resolve', message: `正在解析目标 ${input}` });
  const target = await analyzeTarget(input, options);
  if (target.blocked) throw new Error(target.blockedReason);

  if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { code: 'ABORTED' });

  onProgress({ stage: 'probe', message: `正在探测 ${target.host} 的连通性与常用端口` });
  const probe = await reachability.probeTarget(target, {
    signal,
    pingCount: options.pingCount || config.probe.pingCount,
    skipPing: options.skipPing,
  });

  if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { code: 'ABORTED' });

  const traceTarget = target.primaryIP || target.host;
  onProgress({ stage: 'trace', message: `正在追踪到 ${traceTarget} 的路由路径` });
  const trace = await traceRoute(traceTarget, {
    targetIP: target.primaryIP || undefined,
    maxHops: options.maxHops || config.probe.traceMaxHops,
    queries: options.queries || config.probe.traceQueries,
    timeoutMs: options.traceTimeoutMs,
    resolveNames: options.resolveNames !== false,
    signal,
    engine: options.engine,
    useCache: options.useCache,
    onProgress: (p) => onProgress({ stage: 'trace', ...p }),
  });

  const hopIPs = (trace.hops || []).map((h) => h.ip).filter(Boolean);
  const geoIPs = [...new Set([...hopIPs, target.primaryIP].filter(Boolean))];

  onProgress({ stage: 'geo', message: `正在定位 ${geoIPs.length} 个节点` });

  // 本机位置锚点与地址定位并行获取：私有地址需要按“公网出口位置”落点
  const [geoMap, local] = await Promise.all([geolocate(geoIPs, { signal }), localAnchorInfo()]);
  applyPrivateAnchor(geoMap, local.location);

  // 将地理位置挂回跳点
  for (const hop of trace.hops || []) {
    if (hop.ip && geoMap[hop.ip]) hop.geo = geoMap[hop.ip];
  }

  // 允许调用方在拿到带地理信息的跳点后立即做流式推送
  if (typeof options.onTraceResult === 'function') {
    options.onTraceResult(trace, geoMap);
  }

  let portScan = null;
  if (options.includePortScan) {
    onProgress({ stage: 'ports', message: '正在扫描常用端口' });
    portScan = await reachability.scanPorts(target.primaryIP || target.host, {
      mode: options.portScanMode || 'quick',
      ports: options.ports,
      from: options.from,
      to: options.to,
      signal,
      onProgress: (p) => onProgress({ stage: 'ports', ...p }),
    });
  }

  onProgress({ stage: 'done', message: '诊断完成' });

  return {
    ok: true,
    input,
    target,
    probe,
    trace,
    geo: geoMap,
    portScan,
    local,
    generatedAt: new Date().toISOString(),
    config: {
      maxHops: options.maxHops || config.probe.traceMaxHops,
      queries: options.queries || config.probe.traceQueries,
      engine: options.engine || 'auto',
    },
  };
}

module.exports = {
  analyzeTarget,
  localAnchorInfo,
  applyPrivateAnchor,
  geolocate,
  diagnose,
};
