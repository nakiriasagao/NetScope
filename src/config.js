'use strict';

/**
 * NetScope 全局配置
 * 所有可调参数集中在此，便于使用者按需修改或通过环境变量覆盖。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

/**
 * 应用根目录
 *
 * 三种运行形态都要正确：
 *   1. 源码运行（node src/server.js）→ 项目根目录；
 *   2. 打包成单文件 exe（Node SEA）→ exe 所在目录（data/ 需要在它旁边可写）；
 *   3. 显式指定（NETSCOPE_ROOT）→ 优先使用，便于做绿色版/多实例。
 */
function resolveRoot() {
  if (process.env.NETSCOPE_ROOT) return path.resolve(process.env.NETSCOPE_ROOT);
  let seaMode = false;
  try {
    // eslint-disable-next-line global-require
    const sea = require('node:sea');
    seaMode = Boolean(sea && typeof sea.isSea === 'function' && sea.isSea());
  } catch (_) {
    seaMode = false;
  }
  if (seaMode) return path.dirname(process.execPath);
  return path.resolve(__dirname, '..');
}

const ROOT = resolveRoot();

/** 单文件模式下 public/ 可能不存在（资源已内嵌），因此单独判断 */
function resolvePublicDir(root) {
  const onDisk = path.join(root, 'public');
  try {
    if (fs.existsSync(path.join(onDisk, 'index.html'))) return onDisk;
  } catch (_) {
    /* ignore */
  }
  // 回退到源码目录（开发时从 dist/ 运行 exe 的场景）
  return path.join(path.resolve(__dirname, '..'), 'public');
}

const config = {
  root: ROOT,
  publicDir: resolvePublicDir(ROOT),
  dataDir: path.join(ROOT, 'data'),

  http: {
    port: envInt('NETSCOPE_PORT', 8787),
    host: process.env.NETSCOPE_HOST || '127.0.0.1',
    // 静态资源缓存时间（秒）
    staticMaxAge: 300,
  },

  probe: {
    // ping 默认次数与单次超时
    pingCount: envInt('NETSCOPE_PING_COUNT', 4),
    pingTimeoutMs: envInt('NETSCOPE_PING_TIMEOUT_MS', 1200),
    // traceroute 默认最大跳数与每跳探测次数
    traceMaxHops: envInt('NETSCOPE_TRACE_MAX_HOPS', 30),
    traceQueries: envInt('NETSCOPE_TRACE_QUERIES', 3),
    traceTimeoutMs: envInt('NETSCOPE_TRACE_TIMEOUT_MS', 900),
    // 单个探测任务硬超时（毫秒），防止子进程挂死
    traceHardTimeoutMs: envInt('NETSCOPE_TRACE_HARD_TIMEOUT_MS', 180000),
    pingHardTimeoutMs: envInt('NETSCOPE_PING_HARD_TIMEOUT_MS', 30000),
    // 端口扫描
    portScanTimeoutMs: envInt('NETSCOPE_PORTSCAN_TIMEOUT_MS', 700),
    portScanConcurrency: envInt('NETSCOPE_PORTSCAN_CONCURRENCY', 128),
    portScanMaxPorts: envInt('NETSCOPE_PORTSCAN_MAX_PORTS', 2048),
    // TCP 时延测量
    tcpProbeTimeoutMs: envInt('NETSCOPE_TCP_TIMEOUT_MS', 2500),
    // 并发的地理定位查询上限
    geoConcurrency: envInt('NETSCOPE_GEO_CONCURRENCY', 6),
  },

  geo: {
    // 在线地理定位服务提供方（按顺序尝试，失败自动降级）
    // 均可通过 NETSCOPE_GEO_PROVIDERS=ipwhois,ipapi 指定顺序；offline 表示只使用本地库
    providers: (process.env.NETSCOPE_GEO_PROVIDERS || 'ipwhois,ipapi,ipinfo')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    providerTimeoutMs: envInt('NETSCOPE_GEO_TIMEOUT_MS', 6000),
    // 缓存有效期
    cacheTtlMs: envInt('NETSCOPE_GEO_CACHE_TTL_MS', 1000 * 60 * 60 * 24 * 30),
    cacheFile: path.join(ROOT, 'data', 'geoip-cache.json'),
    // 是否允许在线查询（离线环境自动降级到内置库）
    enableOnline: envBool('NETSCOPE_GEO_ONLINE', true),
  },

  security: {
    // 危险目标拦截：默认阻止向保留地址发起扫描（本机/局域网诊断例外，见 allowPrivateTargets）
    allowPrivateTargets: envBool('NETSCOPE_ALLOW_PRIVATE_TARGETS', true),
    // 端口扫描是否强制要求确认目标为公网地址
    maxTargetLength: 255,
  },

  system: {
    platform: process.platform,
    tmpDir: os.tmpdir(),
  },
};

module.exports = config;
