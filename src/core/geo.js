'use strict';

/**
 * 地理定位（GeoIP）模块
 *
 * 设计要点：
 *  1. 多提供方降级：ipwho.is → ipapi.co → ipinfo.io → 内置离线库
 *  2. 本地磁盘缓存：避免重复查询、降低被限流风险，离线时仍可复用历史结果
 *  3. 私有地址与特殊地址不发出网络请求，直接本地推断（基于本机时区/网关位置）
 *  4. 所有坐标统一为 { lat, lon }，并提供所在时区用于“日/夜”渲染
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { classifyIP, isIPv4 } = require('./iputils');
const OFFLINE_TABLE = require('../data/offline-geo');

/* ------------------------------------------------------------------ */
/* 本机推断（时区 / 语言）                                             */
/* ------------------------------------------------------------------ */

/**
 * 时区 → 近似经纬度表（用于给私有地址、以及离线环境的节点定位）
 * 覆盖全球主要时区，精度到城市级别即可满足拓扑图展示。
 */
const TIMEZONE_ANCHORS = {
  'Asia/Shanghai': { lat: 31.22, lon: 121.46, city: '上海', country: '中国', countryCode: 'CN' },
  'Asia/Chongqing': { lat: 29.56, lon: 106.55, city: '重庆', country: '中国', countryCode: 'CN' },
  'Asia/Urumqi': { lat: 43.83, lon: 87.62, city: '乌鲁木齐', country: '中国', countryCode: 'CN' },
  'Asia/Harbin': { lat: 45.75, lon: 126.65, city: '哈尔滨', country: '中国', countryCode: 'CN' },
  'Asia/Hong_Kong': { lat: 22.32, lon: 114.17, city: '香港', country: '中国香港', countryCode: 'HK' },
  'Asia/Macau': { lat: 22.2, lon: 113.55, city: '澳门', country: '中国澳门', countryCode: 'MO' },
  'Asia/Taipei': { lat: 25.03, lon: 121.57, city: '台北', country: '中国台湾', countryCode: 'TW' },
  'Asia/Tokyo': { lat: 35.68, lon: 139.69, city: '东京', country: '日本', countryCode: 'JP' },
  'Asia/Seoul': { lat: 37.57, lon: 126.98, city: '首尔', country: '韩国', countryCode: 'KR' },
  'Asia/Singapore': { lat: 1.35, lon: 103.82, city: '新加坡', country: '新加坡', countryCode: 'SG' },
  'Asia/Bangkok': { lat: 13.76, lon: 100.5, city: '曼谷', country: '泰国', countryCode: 'TH' },
  'Asia/Kolkata': { lat: 22.57, lon: 88.36, city: '加尔各答', country: '印度', countryCode: 'IN' },
  'Asia/Dubai': { lat: 25.2, lon: 55.27, city: '迪拜', country: '阿联酋', countryCode: 'AE' },
  'Asia/Jakarta': { lat: -6.21, lon: 106.85, city: '雅加达', country: '印度尼西亚', countryCode: 'ID' },
  'Asia/Manila': { lat: 14.6, lon: 120.98, city: '马尼拉', country: '菲律宾', countryCode: 'PH' },
  'Asia/Ho_Chi_Minh': { lat: 10.82, lon: 106.63, city: '胡志明市', country: '越南', countryCode: 'VN' },
  'Asia/Kuala_Lumpur': { lat: 3.14, lon: 101.69, city: '吉隆坡', country: '马来西亚', countryCode: 'MY' },
  'Asia/Riyadh': { lat: 24.71, lon: 46.68, city: '利雅得', country: '沙特阿拉伯', countryCode: 'SA' },
  'Asia/Tehran': { lat: 35.69, lon: 51.39, city: '德黑兰', country: '伊朗', countryCode: 'IR' },
  'Europe/London': { lat: 51.51, lon: -0.13, city: '伦敦', country: '英国', countryCode: 'GB' },
  'Europe/Paris': { lat: 48.86, lon: 2.35, city: '巴黎', country: '法国', countryCode: 'FR' },
  'Europe/Berlin': { lat: 52.52, lon: 13.4, city: '柏林', country: '德国', countryCode: 'DE' },
  'Europe/Amsterdam': { lat: 52.37, lon: 4.9, city: '阿姆斯特丹', country: '荷兰', countryCode: 'NL' },
  'Europe/Frankfurt': { lat: 50.11, lon: 8.68, city: '法兰克福', country: '德国', countryCode: 'DE' },
  'Europe/Madrid': { lat: 40.42, lon: -3.7, city: '马德里', country: '西班牙', countryCode: 'ES' },
  'Europe/Rome': { lat: 41.9, lon: 12.5, city: '罗马', country: '意大利', countryCode: 'IT' },
  'Europe/Moscow': { lat: 55.76, lon: 37.62, city: '莫斯科', country: '俄罗斯', countryCode: 'RU' },
  'Europe/Stockholm': { lat: 59.33, lon: 18.07, city: '斯德哥尔摩', country: '瑞典', countryCode: 'SE' },
  'Europe/Zurich': { lat: 47.37, lon: 8.54, city: '苏黎世', country: '瑞士', countryCode: 'CH' },
  'Europe/Dublin': { lat: 53.35, lon: -6.26, city: '都柏林', country: '爱尔兰', countryCode: 'IE' },
  'Europe/Warsaw': { lat: 52.23, lon: 21.01, city: '华沙', country: '波兰', countryCode: 'PL' },
  'America/New_York': { lat: 40.71, lon: -74.01, city: '纽约', country: '美国', countryCode: 'US' },
  'America/Chicago': { lat: 41.88, lon: -87.63, city: '芝加哥', country: '美国', countryCode: 'US' },
  'America/Denver': { lat: 39.74, lon: -104.99, city: '丹佛', country: '美国', countryCode: 'US' },
  'America/Phoenix': { lat: 33.45, lon: -112.07, city: '凤凰城', country: '美国', countryCode: 'US' },
  'America/Los_Angeles': { lat: 34.05, lon: -118.24, city: '洛杉矶', country: '美国', countryCode: 'US' },
  'America/Seattle': { lat: 47.61, lon: -122.33, city: '西雅图', country: '美国', countryCode: 'US' },
  'America/Toronto': { lat: 43.65, lon: -79.38, city: '多伦多', country: '加拿大', countryCode: 'CA' },
  'America/Vancouver': { lat: 49.28, lon: -123.12, city: '温哥华', country: '加拿大', countryCode: 'CA' },
  'America/Sao_Paulo': { lat: -23.55, lon: -46.63, city: '圣保罗', country: '巴西', countryCode: 'BR' },
  'America/Mexico_City': { lat: 19.43, lon: -99.13, city: '墨西哥城', country: '墨西哥', countryCode: 'MX' },
  'America/Argentina/Buenos_Aires': { lat: -34.6, lon: -58.38, city: '布宜诺斯艾利斯', country: '阿根廷', countryCode: 'AR' },
  'America/Bogota': { lat: 4.71, lon: -74.07, city: '波哥大', country: '哥伦比亚', countryCode: 'CO' },
  'Australia/Sydney': { lat: -33.87, lon: 151.21, city: '悉尼', country: '澳大利亚', countryCode: 'AU' },
  'Australia/Melbourne': { lat: -37.81, lon: 144.96, city: '墨尔本', country: '澳大利亚', countryCode: 'AU' },
  'Australia/Perth': { lat: -31.95, lon: 115.86, city: '珀斯', country: '澳大利亚', countryCode: 'AU' },
  'Pacific/Auckland': { lat: -36.85, lon: 174.76, city: '奥克兰', country: '新西兰', countryCode: 'NZ' },
  'Africa/Cairo': { lat: 30.04, lon: 31.24, city: '开罗', country: '埃及', countryCode: 'EG' },
  'Africa/Johannesburg': { lat: -26.2, lon: 28.05, city: '约翰内斯堡', country: '南非', countryCode: 'ZA' },
  'Africa/Lagos': { lat: 6.52, lon: 3.38, city: '拉各斯', country: '尼日利亚', countryCode: 'NG' },
  'UTC': { lat: 51.48, lon: 0, city: '格林尼治', country: '英国', countryCode: 'GB' },
};

/** 经纬度 → 时区（粗略，用于渲染昼夜分界线） */
function approximateTimezone(lat, lon) {
  if (lat === null || lon === null) return null;
  const abbrev = Math.round(lon / 15);
  return { utcOffsetHours: Math.max(-12, Math.min(14, abbrev)), estimated: true };
}

function localAnchor() {
  let tz = null;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (_) {
    tz = null;
  }
  const anchor = (tz && TIMEZONE_ANCHORS[tz]) || TIMEZONE_ANCHORS['Asia/Shanghai'];
  return { ...anchor, timezone: tz || 'Asia/Shanghai', source: 'local-timezone', precision: 'city' };
}

/* ------------------------------------------------------------------ */
/* 本机位置锚点（带缓存）                                              */
/* ------------------------------------------------------------------ */

let localAnchorCache = { value: null, at: 0 };
const LOCAL_ANCHOR_TTL_MS = 10 * 60 * 1000;

/**
 * 获取“本机在世界地图上的位置”
 *
 * 优先使用公网出口 IP 的定位结果——这才是本机在互联网上的真实位置；
 * 只有当公网出口不可得（离线/受限网络）时，才退回按系统时区估算的城市。
 * 私有地址（本机回环、局域网网关）都会跟随这个锚点落位。
 *
 * @param {{ force?: boolean }} [options]
 */
async function resolveLocalAnchor(options = {}) {
  const now = Date.now();
  if (!options.force && localAnchorCache.value && now - localAnchorCache.at < LOCAL_ANCHOR_TTL_MS) {
    return localAnchorCache.value;
  }

  const fallback = localAnchor();
  let anchor = {
    lat: fallback.lat,
    lon: fallback.lon,
    city: fallback.city,
    country: fallback.country,
    countryCode: fallback.countryCode,
    timezone: fallback.timezone,
    source: 'local-timezone',
    precision: 'city',
  };

  if (config.geo.enableOnline !== false) {
    try {
      // 延迟 require，避免与 sysinfo（其依赖 geo）形成循环依赖
      const sysinfo = require('./sysinfo');
      const publicIP = await sysinfo.detectPublicIP({ timeoutMs: 4000 });
      if (publicIP && publicIP.ip) {
        const info = await resolveIP(publicIP.ip);
        if (typeof info.lat === 'number' && typeof info.lon === 'number') {
          anchor = {
            lat: info.lat,
            lon: info.lon,
            city: info.city || fallback.city,
            country: info.country || fallback.country,
            countryCode: info.countryCode || fallback.countryCode,
            timezone: info.timezone || fallback.timezone,
            source: `public-ip(${publicIP.ip})`,
            precision: info.precision || 'city',
            isp: info.isp || null,
            asn: info.asn || null,
          };
        }
      }
    } catch (_) {
      /* 保持时区兜底 */
    }
  }

  localAnchorCache = { value: anchor, at: now };
  return anchor;
}

function clearLocalAnchorCache() {
  localAnchorCache = { value: null, at: 0 };
}

/* ------------------------------------------------------------------ */
/* 提供方实现                                                          */
/* ------------------------------------------------------------------ */

const PROVIDERS = {
  ipwhois: {
    name: 'ipwho.is',
    url: (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`,
    parse: (data, ip) => {
      if (!data || data.success === false || !data.ip) return null;
      const lat = num(data.latitude);
      const lon = num(data.longitude);
      if (lat === null || lon === null) return null;
      return {
        ip,
        lat,
        lon,
        city: data.city || null,
        region: data.region || null,
        country: data.country || null,
        countryCode: data.country_code || null,
        continent: data.continent || null,
        timezone: data.timezone?.id || null,
        utcOffset: data.timezone?.utc || null,
        isp: data.connection?.isp || data.connection?.org || null,
        org: data.connection?.org || null,
        asn: data.connection?.asn ? `AS${data.connection.asn}` : null,
        asName: data.connection?.domain || null,
      };
    },
  },
  ipapi: {
    name: 'ipapi.co',
    url: (ip) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    parse: (data, ip) => {
      if (!data || data.error || !data.country_code) return null;
      const lat = num(data.latitude);
      const lon = num(data.longitude);
      if (lat === null || lon === null) return null;
      return {
        ip,
        lat,
        lon,
        city: data.city || null,
        region: data.region || null,
        country: data.country_name || null,
        countryCode: data.country_code || null,
        continent: data.continent_code || null,
        timezone: data.timezone || null,
        utcOffset: data.utc_offset || null,
        isp: data.org || null,
        org: data.org || null,
        asn: data.asn || null,
        asName: data.org || null,
      };
    },
  },
  ipinfo: {
    name: 'ipinfo.io',
    url: (ip) => `https://ipinfo.io/${encodeURIComponent(ip)}/json`,
    parse: (data, ip) => {
      if (!data || data.error || !data.loc) return null;
      const [latS, lonS] = String(data.loc).split(',');
      const lat = num(latS);
      const lon = num(lonS);
      if (lat === null || lon === null) return null;
      const orgParts = String(data.org || '').split(' ');
      const asn = orgParts[0] && /^AS\d+$/.test(orgParts[0]) ? orgParts[0] : null;
      return {
        ip,
        lat,
        lon,
        city: data.city || null,
        region: data.region || null,
        country: data.country || null,
        countryCode: data.country || null,
        continent: null,
        timezone: data.timezone || null,
        utcOffset: null,
        isp: orgParts.slice(1).join(' ') || data.org || null,
        org: data.org || null,
        asn,
        asName: orgParts.slice(1).join(' ') || null,
      };
    },
  },
  // 纯离线：只使用内置库
  offline: {
    name: 'offline-db',
    url: null,
    parse: null,
  },
};

function num(v) {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

const memoryCache = new Map();
let diskCache = null;
let diskDirty = false;
let flushTimer = null;

function loadDiskCache() {
  if (diskCache) return diskCache;
  try {
    const raw = fs.readFileSync(config.geo.cacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    diskCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    diskCache = {};
  }
  return diskCache;
}

function scheduleFlush() {
  diskDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!diskDirty) return;
    diskDirty = false;
    try {
      fs.mkdirSync(path.dirname(config.geo.cacheFile), { recursive: true });
      const entries = Object.entries(diskCache || {});
      // 控制体积：最多保留 5000 条
      const trimmed = entries.slice(-5000);
      fs.writeFileSync(config.geo.cacheFile, JSON.stringify(Object.fromEntries(trimmed)), 'utf8');
    } catch (_) {
      /* 缓存写失败不影响主流程 */
    }
  }, 400);
  if (flushTimer.unref) flushTimer.unref();
}

function cacheGet(ip) {
  const now = Date.now();
  const mem = memoryCache.get(ip);
  if (mem && now - mem.cachedAt < config.geo.cacheTtlMs) return mem.value;
  const disk = loadDiskCache()[ip];
  if (disk && now - disk.cachedAt < config.geo.cacheTtlMs) {
    memoryCache.set(ip, disk);
    return disk.value;
  }
  return null;
}

function cacheSet(ip, value) {
  const entry = { cachedAt: Date.now(), value };
  memoryCache.set(ip, entry);
  loadDiskCache()[ip] = entry;
  scheduleFlush();
}

/* ------------------------------------------------------------------ */
/* 离线内置库                                                          */
/* ------------------------------------------------------------------ */

function lookupOffline(ip) {
  if (!isIPv4(ip)) return null;
  const n = ipToInt(ip);

  // 1) 精确地址段匹配（最长前缀优先）
  let best = null;
  let bestBits = -1;
  for (const row of OFFLINE_TABLE.ranges) {
    const start = ipToInt(row.start);
    const end = ipToInt(row.end);
    if (n >= start && n <= end) {
      const bits = Number.parseInt(String(row.prefix).split('/')[1], 10) || 0;
      if (bits > bestBits) {
        best = row;
        bestBits = bits;
      }
    }
  }

  if (best) {
    return {
      ip,
      lat: best.lat,
      lon: best.lon,
      city: best.city,
      region: best.city,
      country: best.country,
      countryCode: best.countryCode,
      continent: null,
      timezone: best.timezone || null,
      utcOffset: null,
      isp: best.isp || null,
      org: best.isp || null,
      asn: best.asn || null,
      asName: best.isp || null,
      precision: 'city',
      matchedPrefix: best.prefix,
    };
  }

  // 2) 命名规律启发式（仅为粗略落点，标注来源以便用户判断可信度）
  for (const rule of OFFLINE_TABLE.heuristicPrefixes) {
    if (ip.startsWith(rule.prefix)) {
      return {
        ip,
        lat: rule.lat,
        lon: rule.lon,
        city: rule.city,
        region: rule.city,
        country: rule.country,
        countryCode: rule.countryCode,
        continent: null,
        timezone: null,
        utcOffset: null,
        isp: rule.isp || null,
        org: rule.isp || null,
        asn: null,
        asName: rule.isp || null,
        precision: 'heuristic',
        matchedPrefix: `${rule.prefix}*`,
        note: rule.note,
      };
    }
  }

  return null;
}

function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/* ------------------------------------------------------------------ */
/* 在线查询                                                            */
/* ------------------------------------------------------------------ */

async function fetchJSON(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'NetScope/1.0 (+network-topology-visualizer)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查询单个 IP 的地理信息
 * @param {string} ip
 * @param {{ signal?: AbortSignal, allowOnline?: boolean }} [options]
 */
async function resolveIP(ip, options = {}) {
  const value = String(ip || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  if (!value) {
    return { ip: '', status: 'invalid', error: '空地址' };
  }

  const cls = classifyIP(value);

  if (cls.kind === 'invalid') {
    return { ip: value, status: 'invalid', error: '非法 IP 地址', classification: cls };
  }

  if (!cls.isPublic) {
    const anchor = localAnchor();
    const tz = anchor.timezone ? { utcOffsetHours: timezoneOffset(anchor.timezone), estimated: true } : approximateTimezone(anchor.lat, anchor.lon);
    return {
      ip: value,
      status: 'private',
      classification: cls,
      lat: anchor.lat,
      lon: anchor.lon,
      city: anchor.city,
      region: anchor.city,
      country: anchor.country,
      countryCode: anchor.countryCode,
      isp: cls.kind === 'loopback' ? '本机回环' : '局域网 / 内网地址',
      org: cls.label,
      asn: null,
      timezone: anchor.timezone,
      utcOffsetHours: tz ? tz.utcOffsetHours : null,
      provider: 'builtin-local',
      precision: 'city',
      online: false,
      cached: false,
      note: `${cls.label}，已按本机所在位置（${anchor.city}）估算坐标`,
    };
  }

  const cached = cacheGet(value);
  if (cached) {
    return { ...cached, cached: true };
  }

  const allowOnline = options.allowOnline !== false && config.geo.enableOnline;
  const errors = [];

  if (allowOnline) {
    for (const key of config.geo.providers) {
      const provider = PROVIDERS[key];
      if (!provider || !provider.url) continue;
      try {
        const data = await fetchJSON(provider.url(value), config.geo.providerTimeoutMs);
        const parsed = provider.parse(data, value);
        if (parsed) {
          const result = {
            ...parsed,
            status: 'public',
            classification: cls,
            provider: provider.name,
            precision: parsed.city ? 'city' : 'country',
            online: true,
            cached: false,
          };
          const tzInfo = approximateTimezone(result.lat, result.lon);
          if (result.utcOffsetHours === undefined || result.utcOffsetHours === null) {
            result.utcOffsetHours = tzInfo ? tzInfo.utcOffsetHours : null;
          }
          cacheSet(value, result);
          return result;
        }
        errors.push(`${provider.name}: 返回数据不完整`);
      } catch (error) {
        errors.push(`${provider.name}: ${error.name === 'AbortError' ? '超时' : error.message}`);
      }
    }
  }

  // 离线库兜底
  const offline = lookupOffline(value);
  if (offline) {
    const tzInfo = approximateTimezone(offline.lat, offline.lon);
    const result = {
      ...offline,
      status: 'public',
      classification: cls,
      provider: 'offline-db',
      online: false,
      cached: false,
      utcOffsetHours: tzInfo ? tzInfo.utcOffsetHours : null,
      note: allowedFallbackNote(errors),
    };
    // 离线结果缓存时间较短，避免网络恢复后一直用旧数据
    const entry = { cachedAt: Date.now() - config.geo.cacheTtlMs + 1000 * 60 * 30, value: result };
    memoryCache.set(value, entry);
    return result;
  }

  return {
    ip: value,
    status: 'unknown',
    classification: cls,
    lat: null,
    lon: null,
    city: null,
    country: null,
    countryCode: null,
    provider: 'none',
    precision: 'none',
    online: false,
    cached: false,
    note: errors.length ? `在线地理定位失败：${errors.join('；')}` : '在线地理定位已关闭，且不在内置离线库范围内',
    errors,
  };
}

function allowedFallbackNote(errors) {
  if (!errors.length) return '使用内置离线地理库估算（国家级精度）';
  return `在线定位失败（${errors.join('；')}），已降级到内置离线库`;
}

function timezoneOffset(tz) {
  try {
    const now = new Date();
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = dtf.formatToParts(now).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return Math.round(((asUTC - now.getTime()) / 3600000) * 2) / 2;
  } catch (_) {
    return null;
  }
}

/**
 * 批量解析（带并发限制，保持结果顺序）
 */
async function resolveMany(ips, options = {}) {
  const unique = [...new Set(ips.filter(Boolean).map((s) => String(s).trim()).filter(Boolean))];
  const concurrency = Math.max(1, config.probe.geoConcurrency);
  const results = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < unique.length) {
      const index = cursor;
      cursor += 1;
      const ip = unique[index];
      if (options.signal?.aborted) return;
      try {
        results.set(ip, await resolveIP(ip, options));
      } catch (error) {
        results.set(ip, { ip, status: 'unknown', error: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return results;
}

function cacheStats() {
  const disk = loadDiskCache();
  return {
    memoryEntries: memoryCache.size,
    diskEntries: Object.keys(disk).length,
    cacheFile: config.geo.cacheFile,
    onlineEnabled: config.geo.enableOnline,
    providers: config.geo.providers,
  };
}

module.exports = {
  resolveIP,
  resolveMany,
  classifyIP,
  cacheStats,
  localAnchor,
  resolveLocalAnchor,
  clearLocalAnchorCache,
  lookupOffline,
  TIMEZONE_ANCHORS,
  PROVIDERS,
  approximateTimezone,
};
