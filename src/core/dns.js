'use strict';

/**
 * DNS 诊断模块
 *  - 记录类型查询：A / AAAA / CNAME / MX / NS / TXT / SOA / SRV / CAA
 *  - 递归链路追踪：从根开始逐级向权威服务器查询，还原“根→顶级域→权威”的委派链路
 *  - 多递归服务器对比：本机 / 223.5.5.5 / 8.8.8.8 等，观察解析结果与时延差异
 */

const dns = require('dns');
const dnsPromises = require('dns').promises;
const { isIP, isIPv4 } = require('./iputils');

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'SRV', 'CAA', 'PTR'];

/**
 * 查询单条记录（不抛错，统一返回 { type, ok, values, error, durationMs }）
 */
async function queryRecord(host, type, timeoutMs = 5000) {
  const started = Date.now();
  const method = `resolve${type.charAt(0)}${type.slice(1).toLowerCase()}`;
  try {
    let values;
    if (typeof dnsPromises[method] !== 'function') {
      throw new Error(`不支持记录类型 ${type}`);
    }
    values = await Promise.race([
      dnsPromises[method](host),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('查询超时'), { code: 'ETIMEOUT' })), timeoutMs)),
    ]);
    return { type, ok: true, values: normalizeValues(type, values), durationMs: Date.now() - started };
  } catch (error) {
    return {
      type,
      ok: false,
      values: [],
      error: error.code || error.message,
      errorMessage: describeDnsError(error),
      durationMs: Date.now() - started,
    };
  }
}

function normalizeValues(type, values) {
  if (!Array.isArray(values)) values = [values];
  if (type === 'MX') return values.map((v) => ({ priority: v.priority, exchange: v.exchange }));
  if (type === 'SOA') return values.map((v) => ({ nsname: v.nsname, hostmaster: v.hostmaster, serial: v.serial, refresh: v.refresh, retry: v.retry, expire: v.expire, minttl: v.minttl }));
  if (type === 'SRV') return values.map((v) => ({ name: v.name, port: v.port, priority: v.priority, weight: v.weight }));
  if (type === 'TXT') return values.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
  return values;
}

function describeDnsError(error) {
  const map = {
    ENOTFOUND: '域名不存在（NXDOMAIN）',
    ENODATA: '该记录类型无数据',
    ETIMEOUT: '查询超时',
    ESERVFAIL: 'DNS 服务器返回 SERVFAIL（解析失败）',
    EREFUSED: 'DNS 服务器拒绝查询',
    EBADNAME: '域名格式不合法',
    ECONNREFUSED: 'DNS 服务器拒绝连接',
  };
  return map[error.code] || error.message || '未知错误';
}

/**
 * 完整解析报告
 */
async function analyzeDomain(domain, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const types = options.types || ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];

  const started = Date.now();
  const records = await Promise.all(types.map((t) => queryRecord(domain, t, timeoutMs)));

  const aRecord = records.find((r) => r.type === 'A' && r.ok && r.values.length);
  const cnameRecord = records.find((r) => r.type === 'CNAME' && r.ok && r.values.length);

  const cnameChain = [];
  if (cnameRecord) {
    let current = cnameRecord.values[0];
    for (let depth = 0; depth < 8 && current; depth += 1) {
      cnameChain.push(current);
      try {
        const next = await dnsPromises.resolveCname(current);
        if (!next || !next.length) break;
        current = next[0];
      } catch (_) {
        break;
      }
    }
  }

  const nsRecords = records.find((r) => r.type === 'NS');
  const txtRecords = records.find((r) => r.type === 'TXT');

  return {
    domain,
    durationMs: Date.now() - started,
    records,
    summary: {
      addresses: aRecord ? aRecord.values : [],
      primaryAddress: aRecord && aRecord.values.length ? aRecord.values[0] : null,
      cname: cnameRecord ? cnameRecord.values[0] : null,
      cnameChain,
      nameservers: nsRecords && nsRecords.ok ? nsRecords.values : [],
      mailServers: records.find((r) => r.type === 'MX' && r.ok)?.values || [],
      hasSpf: Boolean(txtRecords && txtRecords.ok && txtRecords.values.some((v) => /^v=spf1/i.test(v))),
      hasDmarc: false,
      txtPreview: txtRecords && txtRecords.ok ? txtRecords.values.slice(0, 5) : [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 递归链路追踪                                                        */
/* ------------------------------------------------------------------ */

const ROOT_SERVERS = [
  { name: 'a.root-servers.net', ip: '198.41.0.4' },
  { name: 'b.root-servers.net', ip: '199.9.14.201' },
  { name: 'c.root-servers.net', ip: '192.33.4.12' },
  { name: 'd.root-servers.net', ip: '199.7.91.13' },
  { name: 'e.root-servers.net', ip: '192.203.230.10' },
  { name: 'f.root-servers.net', ip: '192.5.5.241' },
  { name: 'g.root-servers.net', ip: '192.112.36.4' },
  { name: 'h.root-servers.net', ip: '198.97.190.53' },
  { name: 'i.root-servers.net', ip: '192.36.148.17' },
  { name: 'j.root-servers.net', ip: '192.58.128.30' },
  { name: 'k.root-servers.net', ip: '193.0.14.129' },
  { name: 'l.root-servers.net', ip: '199.7.83.42' },
  { name: 'm.root-servers.net', ip: '202.12.27.33' },
];

/**
 * 用指定 DNS 服务器做查询（Node 的 Resolver）
 */
function queryWithServer(server, name, type, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
    try {
      resolver.setServers([server]);
    } catch (error) {
      resolve({ ok: false, error: error.message, durationMs: 0 });
      return;
    }
    const started = Date.now();
    const method = `resolve${type.charAt(0)}${type.slice(1).toLowerCase()}`;
    const timer = setTimeout(() => {
      try {
        resolver.cancel();
      } catch (_) {
        /* ignore */
      }
      resolve({ ok: false, error: 'ETIMEOUT', durationMs: Date.now() - started });
    }, timeoutMs + 500);
    resolver[method](name, (error, records) => {
      clearTimeout(timer);
      if (error) {
        resolve({ ok: false, error: error.code || error.message, durationMs: Date.now() - started });
        return;
      }
      resolve({ ok: true, records: normalizeValues(type, records), durationMs: Date.now() - started });
    });
  });
}

/**
 * 递归解析链路：从根服务器开始，逐级获取委派，直到权威服务器返回最终记录
 * @param {string} domain
 * @param {{ timeoutMs?: number, maxDepth?: number, onStep?: Function }} [options]
 */
async function traceDelegation(domain, options = {}) {
  const timeoutMs = options.timeoutMs || 4000;
  const maxDepth = options.maxDepth || 8;
  const chain = [];

  const labels = String(domain).split('.').filter(Boolean);
  if (labels.length < 2) {
    return { domain, chain, error: '需要至少二级域名才能追踪委派链路' };
  }

  let currentZone = labels.slice(-1).join('.'); // 从顶级域开始
  let nameservers = ROOT_SERVERS.slice(0, 3).map((r) => ({ name: r.name, ip: r.ip, level: 'root' }));
  let depth = 0;

  while (depth < maxDepth && nameservers.length) {
    const zoneLabels = currentZone.split('.');
    const targetZone = labels.slice(-(zoneLabels.length + 1)).join('.');
    const step = {
      depth,
      zone: targetZone,
      queriedZone: currentZone,
      servers: [],
      delegation: [],
      answer: null,
    };

    // 依次询问该层的权威服务器，直到得到 NS 委派或最终 A 记录
    for (const server of nameservers.slice(0, 3)) {
      const nsQuery = await queryWithServer(server.ip, targetZone, 'NS', timeoutMs);
      const aQuery = await queryWithServer(server.ip, targetZone, 'A', timeoutMs);
      const record = {
        server: server.name || server.ip,
        serverIP: server.ip,
        level: server.level || 'authoritative',
        ns: nsQuery.ok ? nsQuery.records.slice(0, 6) : null,
        nsError: nsQuery.ok ? null : nsQuery.error,
        a: aQuery.ok ? aQuery.records : null,
        aError: aQuery.ok ? null : aQuery.error,
        durationMs: nsQuery.durationMs + aQuery.durationMs,
      };
      step.servers.push(record);
      if (typeof options.onStep === 'function') options.onStep(step, record);

      if (aQuery.ok && aQuery.records && aQuery.records.length && targetZone === domain) {
        step.answer = aQuery.records;
      }
      if (nsQuery.ok && nsQuery.records && nsQuery.records.length) {
        step.delegation = nsQuery.records;
        break;
      }
    }

    chain.push(step);

    if (targetZone === domain && step.answer) {
      return { domain, chain, resolved: step.answer, complete: true };
    }

    if (!step.delegation.length) {
      return {
        domain,
        chain,
        complete: false,
        note: `在 ${currentZone} 处未获得继续向下的委派（可能该域不存在或使用了其它解析机制）`,
      };
    }

    // 解析下一级权威服务器的 IP
    const nextServers = [];
    for (const nsName of step.delegation.slice(0, 3)) {
      const resolved = await queryWithServer(nameservers[0].ip, nsName, 'A', timeoutMs);
      if (resolved.ok && resolved.records.length) {
        nextServers.push({ name: nsName, ip: resolved.records[0], level: 'authoritative' });
      }
    }
    if (!nextServers.length) {
      return { domain, chain, complete: false, note: '无法解析权威服务器地址（胶水记录缺失）' };
    }
    nameservers = nextServers;
    currentZone = targetZone;
    depth += 1;
  }

  return { domain, chain, complete: false, note: '达到最大追踪深度' };
}

/**
 * 多递归服务器对比
 */
async function compareResolvers(domain, servers, options = {}) {
  const list = servers && servers.length ? servers : ['223.5.5.5', '119.29.29.29', '8.8.8.8', '1.1.1.1', '9.9.9.9'];
  const timeoutMs = options.timeoutMs || 4000;

  const results = await Promise.all(
    list.filter((s) => isIPv4(s)).map(async (server) => {
      const a = await queryWithServer(server, domain, 'A', timeoutMs);
      const aaaa = await queryWithServer(server, domain, 'AAAA', timeoutMs);
      return {
        server,
        ok: a.ok,
        addresses: a.ok ? a.records : [],
        ipv6: aaaa.ok ? aaaa.records : [],
        durationMs: a.durationMs,
        error: a.ok ? null : describeDnsError({ code: a.error }),
      };
    }),
  );
  return { domain, resolvers: results };
}

/**
 * 本机 DNS 配置
 */
function localDnsConfig() {
  let servers = [];
  try {
    servers = dns.getServers();
  } catch (_) {
    servers = [];
  }
  return { servers, isIP: servers.map((s) => isIP(s)) };
}

module.exports = {
  RECORD_TYPES,
  ROOT_SERVERS,
  queryRecord,
  analyzeDomain,
  queryWithServer,
  traceDelegation,
  compareResolvers,
  localDnsConfig,
  describeDnsError,
};
