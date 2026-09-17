'use strict';

/**
 * 高德地图（AMap）服务端接入层
 *
 * 为什么由服务端代理：
 *   1. 高德自 2021-12-02 起要求 Web 端请求携带"安全密钥（jscode）"，
 *      官方推荐做法是把 jscode 放在服务端拼接受保护请求，避免明文暴露在前端；
 *   2. Web 服务类接口（IP 定位、逆地理编码）按 IP 白名单鉴权，天然适合服务端调用；
 *   3. 前端只需拿到"能用的地图配置"，不必接触密钥。
 *
 * 密钥来源（优先级从高到低）：
 *   1. 请求头 x-amap-key / x-amap-security（前端设置面板填写后随请求带上）
 *   2. 环境变量 AMAP_KEY / AMAP_SECURITY
 *   3. 本地配置文件 data/amap-config.json（由设置面板保存，已加入 .gitignore）
 *
 * 未配置密钥时，所有接口返回结构化的"未配置"提示，前端据此回退到内置世界地图，
 * 不会出现空白页或报错弹窗。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const AMAP_CONFIG_FILE = path.join(config.dataDir, 'amap-config.json');

const ENDPOINTS = {
  // Web 服务类（按 IP 白名单鉴权）
  ip: 'https://restapi.amap.com/v3/ip',
  geo: 'https://restapi.amap.com/v3/geocode/geo',
  regeo: 'https://restapi.amap.com/v3/geocode/regeo',
  district: 'https://restapi.amap.com/v3/config/district',
  // JS API 脚本地址（前端动态引入）
  jsapi: 'https://webapi.amap.com/maps',
};

/* ------------------------------------------------------------------ */
/* 配置读写                                                            */
/* ------------------------------------------------------------------ */

function loadStoredConfig() {
  try {
    const raw = fs.readFileSync(AMAP_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveStoredConfig(input) {
  const current = loadStoredConfig();
  const next = {
    ...current,
    ...(input.key !== undefined ? { key: String(input.key || '').trim() } : {}),
    ...(input.security !== undefined ? { security: String(input.security || '').trim() } : {}),
    ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
    savedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(AMAP_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(AMAP_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 解析当前生效的密钥
 * @param {import('http').IncomingMessage} [req]
 */
function resolveCredentials(req) {
  const stored = loadStoredConfig();
  const headerKey = req && req.headers ? String(req.headers['x-amap-key'] || '').trim() : '';
  const headerSecurity = req && req.headers ? String(req.headers['x-amap-security'] || '').trim() : '';
  const key = headerKey || process.env.AMAP_KEY || stored.key || '';
  const security = headerSecurity || process.env.AMAP_SECURITY || stored.security || '';
  const enabled = stored.enabled === undefined ? true : Boolean(stored.enabled);
  return {
    key,
    security,
    enabled,
    source: headerKey ? 'request' : process.env.AMAP_KEY ? 'env' : stored.key ? 'file' : 'none',
  };
}

/** 密钥是否形如 32 位十六进制 */
function looksLikeKey(value) {
  return /^[0-9a-fA-F]{32}$/.test(String(value || '').trim());
}

/* ------------------------------------------------------------------ */
/* 请求高德                                                           */
/* ------------------------------------------------------------------ */

const HEADERS = {
  'User-Agent': 'NetScope/1.0 (+network-topology-visualizer)',
  Accept: 'application/json, text/plain, */*',
  // 高德要求 Web 端请求带 Referer；服务端调用时给一个合法来源，避免被判定为异常请求
  Referer: 'https://lbs.amap.com/',
};

async function fetchAmapJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: HEADERS });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(`高德返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 120)}`);
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 高德错误码 → 中文说明
 * 参考：https://lbs.amap.com/api/webservice/guide/tools/info
 */
const AMAP_ERRORS = {
  INVALID_USER_KEY: 'Key 无效或未激活：请确认 Key 属于「Web服务」类型且已生效',
  USERKEY_PLAT_NOMATCH: 'Key 类型不匹配：这是「Web端(JS API)」类型的 Key，不能用于 Web 服务接口。IP 定位等接口需要在控制台为同一个应用再添加一个「Web服务」类型的 Key',
  INVALID_USER_SCODE: '安全密钥（jscode）缺失或错误：新版 Key 必须同时提供安全密钥',
  USER_KEY_PLATFORM_MISMATCH: 'Key 类型不匹配：当前接口需要「Web服务」类型的 Key（在控制台新建一个）',
  INVALID_USER_SIGNATURE: '数字签名校验失败：请检查安全密钥是否正确',
  INVALID_USER_IP: '调用来源 IP 不在白名单内：请在控制台把本机公网 IP 加入白名单，或清空白名单',
  INVALID_USER_DOMAIN: '调用来源域名不在白名单内：请在 Key 设置里把域名白名单设为「不限制」',
  SERVICE_NOT_AVAILABLE: '该服务未开通或已到期：请在控制台确认服务与配额',
  DAILY_QUERY_OVER_LIMIT: '当日调用量已超限：请等待次日重置或提升配额',
  ACCESS_TOO_FREQUENT: '调用过于频繁：请稍后重试',
  INSUFFICIENT_PRIVILEGES: '权限不足：请确认该 Key 已开通对应服务',
  USER_KEY_RECYCLED: 'Key 已被删除：请重新创建',
  INVALID_PARAMS: '请求参数不合法',
  ENGINE_RESPONSE_DATA_ERROR: '高德返回数据异常：请稍后重试',
};

function describeAmapError(info) {
  const code = String(info || '').trim();
  if (!code || code === 'OK') return null;
  return AMAP_ERRORS[code] || `高德返回错误码：${code}`;
}

/**
 * 调用高德 Web 服务接口
 * @param {string} name ENDPOINTS 中的键
 * @param {Record<string, string|number>} params
 * @param {{ key: string, security: string }} credentials
 */
async function callAmap(name, params, credentials) {
  const base = ENDPOINTS[name];
  if (!base) throw new Error(`未知的高德接口：${name}`);
  if (!credentials.key) {
    return {
      ok: false,
      configured: false,
      error: '尚未配置高德 Key，请点击右上角 ⚙ 设置后重试',
    };
  }

  const query = new URLSearchParams({ key: credentials.key, output: 'JSON', ...params });
  // 安全密钥：以查询参数形式提交（高德 Web 服务支持的鉴权方式之一）
  if (credentials.security) query.set('jscode', credentials.security);

  let payload;
  try {
    payload = await fetchAmapJson(`${base}?${query.toString()}`);
  } catch (error) {
    return {
      ok: false,
      configured: true,
      error: `请求高德失败：${error.name === 'AbortError' ? '超时' : error.message}`,
    };
  }

  const info = payload.data && payload.data.info;
  const errorText = describeAmapError(info);
  if (errorText) {
    return { ok: false, configured: true, error: errorText, amapInfo: info, amapCode: payload.data && payload.data.infocode };
  }
  return { ok: true, configured: true, data: payload.data };
}

/* ------------------------------------------------------------------ */
/* 对外能力                                                            */
/* ------------------------------------------------------------------ */

/** 当前配置状态（不回传完整密钥，只回传掩码） */
function configStatus(req) {
  const credentials = resolveCredentials(req);
  const stored = loadStoredConfig();
  return {
    configured: Boolean(credentials.key),
    enabled: credentials.enabled,
    keySource: credentials.source,
    keyMasked: credentials.key ? `${credentials.key.slice(0, 6)}…${credentials.key.slice(-4)}` : null,
    hasSecurity: Boolean(credentials.security),
    keyLooksValid: credentials.key ? looksLikeKey(credentials.key) : null,
    securityLooksValid: credentials.security ? looksLikeKey(credentials.security) : null,
    savedAt: stored.savedAt || null,
    scriptUrl: credentials.key
      ? `${ENDPOINTS.jsapi}?v=2.0&key=${encodeURIComponent(credentials.key)}`
      : null,
    endpoints: ENDPOINTS,
  };
}

/**
 * 连通性测试：分别验证 JS API 脚本与 Web 服务接口
 * @param {import('http').IncomingMessage} req
 */
async function testConnection(req) {
  const credentials = resolveCredentials(req);
  const checks = [];

  if (!credentials.key) {
    return {
      ok: false,
      configured: false,
      error: '尚未配置高德 Key',
      checks: [
        { name: 'Key 配置', ok: false, detail: '未填写' },
      ],
      hints: AMAP_SETUP_HINTS,
    };
  }

  checks.push({
    name: 'Key 格式',
    ok: looksLikeKey(credentials.key),
    detail: looksLikeKey(credentials.key) ? '形如 32 位十六进制' : '格式可疑（高德 Key 通常是 32 位十六进制）',
  });
  checks.push({
    name: '安全密钥',
    ok: Boolean(credentials.security),
    detail: credentials.security
      ? (looksLikeKey(credentials.security) ? '已填写且格式正确' : '已填写但格式可疑')
      : '未填写（2021-12-02 之后申请的 Key 必须填写，否则会报 INVALID_USER_SCODE）',
  });

  // 1) JS API 脚本是否可下载（能下载说明 Key 至少被接受用于加载脚本）
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${ENDPOINTS.jsapi}?v=2.0&key=${encodeURIComponent(credentials.key)}`, {
      signal: controller.signal,
      headers: HEADERS,
    });
    const text = await res.text();
    clearTimeout(timer);
    const bad = /INVALID_USER_KEY|USER_KEY_PLATFORM_MISMATCH/.test(text);
    checks.push({
      name: 'JS API 脚本加载',
      ok: res.ok && !bad,
      detail: bad ? '脚本返回错误信息，Key 可能不是「Web端(JS API)」类型' : `HTTP ${res.status}，${text.length} 字节`,
    });
  } catch (error) {
    checks.push({ name: 'JS API 脚本加载', ok: false, detail: error.name === 'AbortError' ? '超时' : error.message });
  }

  // 2) Web 服务接口（IP 定位）—— 只对「Web服务」类型的 Key 有效，
  //    若用的是「Web端(JS API)」Key 会返回 USERKEY_PLAT_NOMATCH，
  //    这属于预期情况（底图能用，仅服务端接口不可用），因此不算致命失败
  const ipResult = await callAmap('ip', {}, credentials);
  const platformMismatch = ipResult.amapInfo === 'USERKEY_PLAT_NOMATCH' || ipResult.amapInfo === 'USER_KEY_PLATFORM_MISMATCH';
  checks.push({
    name: 'Web 服务接口（可选）',
    ok: Boolean(ipResult.ok),
    optional: platformMismatch,
    detail: ipResult.ok
      ? `IP 定位可用（${ipResult.data.province || '—'} ${ipResult.data.city || ''}）`
      : ipResult.error,
  });

  // 只要「JS API 脚本加载」通过，高德底图就能正常使用；
  // Web 服务接口失败只影响可选的 IP 定位功能，不影响地图本身
  const jsCheck = checks.find((c) => c.name === 'JS API 脚本加载');
  const ok = Boolean(jsCheck && jsCheck.ok);
  return {
    ok,
    configured: true,
    checks,
    hints: ok ? (platformMismatch ? [AMAP_HINT_WEB_SERVICE] : []) : AMAP_SETUP_HINTS,
    keyMasked: `${credentials.key.slice(0, 6)}…${credentials.key.slice(-4)}`,
    platformMismatch,
    message: ok
      ? (platformMismatch
          ? '高德底图可用（当前 Key 为「Web端(JS API)」类型）；如需服务端 IP 定位，请再添加一个「Web服务」Key'
          : '高德地图配置可用')
      : '高德地图不可用，请按提示检查 Key 与安全密钥',
  };
}

const AMAP_HINT_WEB_SERVICE =
  '同一应用下「添加 Key」时把服务平台选为「Web服务」，即可用于 IP 定位与逆地理编码；本工具的地图底图不依赖它。';

const AMAP_SETUP_HINTS = [
  '需要两个 Key：① 服务平台选「Web端(JS API)」用于加载底图；② 选「Web服务」用于 IP 定位等接口。',
  '2021-12-02 之后申请的 Key 必须同时配置「安全密钥 jscode」，否则报 INVALID_USER_SCODE。',
  'Web 服务类 Key 按 IP 白名单鉴权：若报 INVALID_USER_IP，请把本机公网 IP 加入白名单或清空白名单。',
  '用 127.0.0.1 打开页面时域名校验一般不拦截；若报 INVALID_USER_DOMAIN，把域名白名单设为「不限制」。',
  '申请地址：https://console.amap.com/dev/key/app （需先完成个人开发者实名认证）。',
];

/** IP 定位（用于把公网出口定位改由高德提供，国内 IP 精度更好） */
async function locateIp(req, ip) {
  const credentials = resolveCredentials(req);
  const params = {};
  if (ip) params.ip = ip;
  const result = await callAmap('ip', params, credentials);
  if (!result.ok) return result;
  const data = result.data || {};
  const rectangle = String(data.rectangle || '')
    .split(';')
    .map((p) => p.split(',').map(Number));
  const center = rectangle.length === 2 && rectangle[0].length === 2
    ? { lon: (rectangle[0][0] + rectangle[1][0]) / 2, lat: (rectangle[0][1] + rectangle[1][1]) / 2 }
    : null;
  return {
    ok: true,
    configured: true,
    result: {
      ip: data.ip || ip || null,
      province: data.province || null,
      city: data.city || null,
      adcode: data.adcode || null,
      rectangle: data.rectangle || null,
      center,
      provider: 'amap',
    },
  };
}

/** 逆地理编码：经纬度 → 地址（用于给地图上的节点补充中文地名） */
async function reverseGeocode(req, lon, lat) {
  const credentials = resolveCredentials(req);
  if (typeof lon !== 'number' || typeof lat !== 'number') {
    return { ok: false, configured: Boolean(credentials.key), error: '需要提供有效的经纬度' };
  }
  const result = await callAmap(
    'regeo',
    { location: `${lon.toFixed(6)},${lat.toFixed(6)}`, extensions: 'base', radius: 1000 },
    credentials,
  );
  if (!result.ok) return result;
  const regeocode = (result.data && result.data.regeocode) || {};
  const component = regeocode.addressComponent || {};
  return {
    ok: true,
    configured: true,
    result: {
      formattedAddress: regeocode.formatted_address || null,
      province: component.province || null,
      city: component.city || component.province || null,
      district: component.district || null,
      adcode: component.adcode || null,
      provider: 'amap',
    },
  };
}

module.exports = {
  AMAP_CONFIG_FILE,
  ENDPOINTS,
  AMAP_ERRORS,
  AMAP_SETUP_HINTS,
  loadStoredConfig,
  saveStoredConfig,
  resolveCredentials,
  configStatus,
  testConnection,
  locateIp,
  reverseGeocode,
  callAmap,
  looksLikeKey,
  describeAmapError,
};
