#!/usr/bin/env node
'use strict';

/**
 * NetScope 命令行工具
 *
 * 用法示例：
 *   node bin/netscope.js 8.8.8.8
 *   node bin/netscope.js www.baidu.com --hops 20 --json
 *   node bin/netscope.js github.com --csv > github.csv
 *   node bin/netscope.js --local
 *   node bin/netscope.js --dns example.com
 *   node bin/netscope.js example.com --ports 80,443,8080
 *
 * 说明：CLI 与网页界面共用同一套核心探测模块，因此输出内容完全一致。
 */

const path = require('path');

const { diagnose, analyzeTarget } = require('../src/core/orchestrator');
const geo = require('../src/core/geo');
const sysinfo = require('../src/core/sysinfo');
const dnsTool = require('../src/core/dns');
const reachability = require('../src/core/reachability');
const { traceRoute, socketCapabilityInfo } = require('../src/core/trace');
const { classifyIP } = require('../src/core/iputils');
const pkg = require('../package.json');

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const options = {
    target: null,
    json: false,
    csv: false,
    local: false,
    dns: null,
    ports: null,
    maxHops: 30,
    queries: 3,
    timeoutMs: 900,
    resolveNames: true,
    engine: 'auto',
    noGeo: false,
    help: false,
    version: false,
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--csv') options.csv = true;
    else if (arg === '--local') options.local = true;
    else if (arg === '--no-geo') options.noGeo = true;
    else if (arg === '--no-names') options.resolveNames = false;
    else if (arg === '--hops') options.maxHops = Number.parseInt(next(), 10) || options.maxHops;
    else if (arg === '--queries') options.queries = Number.parseInt(next(), 10) || options.queries;
    else if (arg === '--timeout') options.timeoutMs = Number.parseInt(next(), 10) || options.timeoutMs;
    else if (arg === '--engine') options.engine = next();
    else if (arg === '--dns') options.dns = next();
    else if (arg === '--ports') options.ports = next();
    else if (!arg.startsWith('-')) positional.push(arg);
    else {
      console.error(`未知参数：${arg}（使用 --help 查看用法）`);
      process.exit(2);
    }
  }
  if (positional.length) options.target = positional[0];
  return options;
}

const HELP = `
NetScope v${pkg.version} · 网络连接探测与世界地图拓扑可视化（CLI）

用法：
  netscope <目标> [选项]

目标可以是 IP、域名或网址，例如 8.8.8.8、www.baidu.com、https://github.com。

选项：
  --hops <n>        最大跳数（默认 30）
  --queries <n>     每跳探测次数（默认 3）
  --timeout <ms>    单跳超时毫秒（默认 900）
  --engine <name>   追踪引擎：auto | socket | system（默认 auto）
  --no-names        不做反向 DNS 解析（更快）
  --no-geo          跳过多余的地理定位查询（仍会用缓存与内置库）
  --json            输出完整 JSON（可直接管道给 jq）
  --csv             输出逐跳 CSV 表格
  --local           查看本机网络拓扑（网卡/网关/DNS/ARP）
  --dns <域名>      仅做 DNS 诊断
  --ports <列表>    额外扫描指定端口，如 80,443,8080
  -h, --help        显示帮助
  -v, --version     显示版本

示例：
  netscope 8.8.8.8
  netscope www.baidu.com --hops 20 --no-names
  netscope github.com --json > route.json
  netscope --local
  netscope --dns example.com
`;

/* ------------------------------ 输出工具 ------------------------------ */

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: COLOR ? '\u001b[0m' : '',
  dim: COLOR ? '\u001b[2m' : '',
  bold: COLOR ? '\u001b[1m' : '',
  cyan: COLOR ? '\u001b[36m' : '',
  green: COLOR ? '\u001b[32m' : '',
  yellow: COLOR ? '\u001b[33m' : '',
  red: COLOR ? '\u001b[31m' : '',
  magenta: COLOR ? '\u001b[35m' : '',
};

function latencyColor(value) {
  if (typeof value !== 'number') return c.dim;
  if (value <= 60) return c.green;
  if (value <= 180) return c.yellow;
  return c.red;
}

function pad(text, width) {
  const s = String(text === null || text === undefined ? '' : text);
  // 中文按两个字符宽度计算
  let len = 0;
  for (const ch of s) len += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uff60]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - len));
}

function fmtMs(value) {
  return typeof value === 'number' ? `${Math.round(value * 10) / 10}` : '—';
}

/* ------------------------------ 各命令实现 ---------------------------- */

async function runTrace(options) {
  const result = await diagnose(options.target, {
    maxHops: options.maxHops,
    queries: options.queries,
    traceTimeoutMs: options.timeoutMs,
    resolveNames: options.resolveNames,
    engine: options.engine,
    includePortScan: Boolean(options.ports),
    portScanMode: options.ports ? 'list' : undefined,
    ports: options.ports
      ? options.ports.split(',').map((v) => Number.parseInt(v, 10)).filter((v) => Number.isInteger(v))
      : undefined,
    onProgress: options.json || options.csv ? undefined : (p) => {
      if (p.message) process.stderr.write(`${c.dim}· ${p.message}${c.reset}\n`);
    },
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (options.csv) {
    const rows = [['ttl', 'ip', 'hostname', 'city', 'country', 'isp', 'asn', 'min_ms', 'avg_ms', 'max_ms', 'jitter_ms', 'loss_pct', 'lat', 'lon', 'source']];
    for (const hop of result.trace.hops || []) {
      const g = hop.geo || {};
      rows.push([
        hop.ttl, hop.ip || '', hop.hostname || '', g.city || '', g.country || '', g.isp || '', g.asn || '',
        hop.latency?.min ?? '', hop.latency?.avg ?? '', hop.latency?.max ?? '', hop.latency?.jitter ?? '',
        hop.latency?.lossPct ?? '', g.lat ?? '', g.lon ?? '', g.provider || '',
      ]);
    }
    process.stdout.write(`${rows.map((r) => r.join(',')).join('\n')}\n`);
    return 0;
  }

  printTraceReport(result);
  return 0;
}

function printTraceReport(result) {
  const target = result.target || {};
  const summary = result.trace?.summary || {};
  const line = '─'.repeat(96);

  console.log('');
  console.log(`${c.bold}${c.cyan}NetScope${c.reset} ${c.dim}v${pkg.version}${c.reset}`);
  console.log(line);
  console.log(`${pad('目标', 10)}${c.bold}${target.host || result.input}${c.reset}`);
  if (target.primaryIP) console.log(`${pad('解析地址', 10)}${target.primaryIP}  ${c.dim}${target.classification?.label || ''}${c.reset}`);
  if (result.probe?.reverseDns) console.log(`${pad('反向解析', 10)}${result.probe.reverseDns}`);
  if (result.probe?.ping) {
    const ping = result.probe.ping;
    console.log(
      `${pad('ICMP', 10)}${ping.alive ? `${c.green}可达${c.reset}` : `${c.red}无响应${c.reset}`}  ` +
        `平均 ${fmtMs(ping.avg)} ms  丢包 ${ping.lossPct ?? '—'}%  抖动 ${fmtMs(ping.jitter)} ms`,
    );
  }
  if (result.local?.location) {
    const loc = result.local.location;
    console.log(`${pad('本机位置', 10)}${loc.city || '—'} ${loc.country || ''} ${c.dim}(${loc.lat?.toFixed(4)}, ${loc.lon?.toFixed(4)} · ${loc.source})${c.reset}`);
  }
  console.log(`${pad('追踪引擎', 10)}${result.trace?.engine === 'icmp-socket' ? '原生 ICMP 套接字' : '系统命令'}${result.trace?.cached ? c.dim + '（缓存）' + c.reset : ''}`);

  console.log('');
  console.log(`${pad('#', 4)}${pad('地址', 18)}${pad('位置', 22)}${pad('延迟(ms)', 11)}${pad('丢包', 8)}运营商 / 主机名`);
  console.log(line);

  for (const hop of result.trace?.hops || []) {
    const g = hop.geo || {};
    const place = [g.city, g.country].filter(Boolean).join(', ') || (hop.classification?.label || '未知');
    const addr = hop.ip || '*';
    const color = hop.ip ? latencyColor(hop.latency?.avg) : c.dim;
    const extra = [g.isp, hop.hostname].filter(Boolean).join(' · ');
    console.log(
      `${pad(hop.ttl, 4)}${pad(addr, 18)}${pad(place.slice(0, 20), 22)}` +
        `${color}${pad(hop.latency?.avg === null || hop.latency?.avg === undefined ? '—' : fmtMs(hop.latency.avg), 11)}${c.reset}` +
        `${pad(`${hop.latency?.lossPct ?? '—'}%`, 8)}${c.dim}${extra.slice(0, 40)}${c.reset}`,
    );
  }

  console.log(line);
  console.log(
    `${c.bold}摘要${c.reset}  跳数 ${summary.hopCount ?? 0} · 有响应 ${summary.respondedHops ?? 0} · ` +
      `拒绝响应 ${summary.timeouts ?? 0} · 平均 ${fmtMs(summary.avgRtt)} ms · 最小 ${fmtMs(summary.minRtt)} / 最大 ${fmtMs(summary.maxRtt)} ms`,
  );
  const countries = [...new Set((result.trace?.hops || []).map((h) => h.geo?.country).filter(Boolean))];
  if (countries.length) console.log(`      途经国家/地区：${countries.join(' → ')}`);
  if (summary.reachedTarget) console.log(`      ${c.green}已到达目标主机${c.reset}`);
  if (result.trace?.fallbackNotes?.length) {
    for (const note of result.trace.fallbackNotes) console.log(`      ${c.yellow}提示：${note}${c.reset}`);
  }

  if (result.portScan) {
    console.log('');
    console.log(`${c.bold}端口扫描${c.reset}（${result.portScan.total} 个端口，耗时 ${result.portScan.durationMs} ms）`);
    const open = result.portScan.open || [];
    console.log(open.length ? open.map((p) => `${c.green}${p.port}${c.reset}${p.service ? '/' + p.service : ''}`).join('  ') : '  未发现开放端口');
  }

  console.log('');
  console.log(`${c.dim}提示：运行 node src/server.js 打开网页界面，可在世界地图上查看完整拓扑图。${c.reset}`);
  console.log('');
}

async function runLocal() {
  const info = await sysinfo.discoverLocalNetwork({ includePorts: true, includeNeighbors: true });
  const line = '─'.repeat(96);
  console.log('');
  console.log(`${c.bold}${c.cyan}本机网络拓扑${c.reset}`);
  console.log(line);
  console.log(`${pad('主机名', 12)}${info.hostname}`);
  console.log(`${pad('系统', 12)}${info.platform} / ${info.arch}`);
  console.log(`${pad('出口 IP', 12)}${info.publicIP?.ip || '（获取失败）'}${info.geo?.[info.publicIP?.ip] ? `  ${c.dim}${info.geo[info.publicIP.ip].city || ''} ${info.geo[info.publicIP.ip].isp || ''}${c.reset}` : ''}`);
  console.log('');
  console.log(`${c.bold}网络接口${c.reset}`);
  for (const iface of info.interfaces) {
    console.log(`  ${pad(iface.address, 20)}${pad(iface.family, 8)}${c.dim}${iface.name}${iface.mac ? ' · ' + iface.mac : ''}${c.reset}`);
  }
  if (info.gateways.length) {
    console.log('');
    console.log(`${c.bold}默认网关${c.reset}  ${info.gateways.join(', ')}`);
  }
  if (info.dnsServers.length) {
    console.log(`${c.bold}DNS 服务器${c.reset}  ${info.dnsServers.join(', ')}`);
  }
  if (info.neighbors.length) {
    console.log('');
    console.log(`${c.bold}局域网邻居（ARP，${info.neighbors.length}）${c.reset}`);
    for (const item of info.neighbors.slice(0, 30)) {
      console.log(`  ${pad(item.ip, 18)}${pad(item.mac, 20)}${c.dim}${item.type}${c.reset}`);
    }
  }
  if (info.listeners.length) {
    console.log('');
    console.log(`${c.bold}本机监听端口（${info.listeners.length}）${c.reset}`);
    for (const item of info.listeners.slice(0, 40)) {
      console.log(`  ${pad(item.port, 8)}${pad(item.proto, 6)}${pad(item.address, 20)}${c.dim}PID ${item.pid ?? '-'}${c.reset}`);
    }
  }
  console.log('');
  return 0;
}

async function runDns(domain) {
  const report = await dnsTool.analyzeDomain(domain, { timeoutMs: 5000 });
  const geoMap = await geo.resolveMany(report.summary.addresses || []);
  const line = '─'.repeat(96);
  console.log('');
  console.log(`${c.bold}${c.cyan}DNS 诊断${c.reset}  ${domain}  ${c.dim}${report.durationMs} ms${c.reset}`);
  console.log(line);
  if (report.summary.cname) console.log(`${pad('CNAME', 12)}${report.summary.cname}`);
  if (report.summary.cnameChain.length) console.log(`${pad('解析链', 12)}${report.summary.cnameChain.join(' → ')}`);
  console.log(`${pad('A 记录', 12)}${report.summary.addresses.length ? '' : '（无）'}`);
  for (const ip of report.summary.addresses) {
    const g = geoMap.get(ip) || {};
    console.log(`  ${pad(ip, 18)}${pad(g.city || '—', 18)}${c.dim}${g.isp || ''}${c.reset}`);
  }
  for (const record of report.records) {
    if (record.type === 'A' || record.type === 'AAAA') continue;
    const values = record.ok && record.values.length ? record.values.map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)).slice(0, 4).join(' | ') : `${c.dim}${record.errorMessage || record.error || '无记录'}${c.reset}`;
    console.log(`${pad(record.type, 12)}${values}`);
  }
  const localDns = dnsTool.localDnsConfig();
  if (localDns.servers.length) console.log(`\n${pad('本机 DNS', 12)}${localDns.servers.join(', ')}`);
  console.log('');
  return 0;
}

async function runAnalyzeOnly(options) {
  const target = await analyzeTarget(options.target, {});
  console.log(JSON.stringify(target, null, 2));
  return 0;
}

/* ------------------------------ 入口 ---------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.version) {
    console.log(`NetScope v${pkg.version}`);
    return 0;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.local) return runLocal();
  if (options.dns) return runDns(options.dns);
  if (!options.target) {
    console.log(HELP);
    return 1;
  }
  if (options.noGeo) {
    console.log(JSON.stringify({ note: '已通过 --no-geo 跳过地理定位', ip: options.target, classification: classifyIP(options.target) }, null, 2));
    return 0;
  }
  try {
    return await runTrace(options);
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
      return 1;
    }
    throw error;
  }
}

main()
  .then((code) => {
    process.exitCode = code || 0;
  })
  .catch((error) => {
    console.error(`\n${c.red}错误：${error.message}${c.reset}\n`);
    if (process.env.NETSCOPE_DEBUG === '1') console.error(error.stack);
    process.exitCode = 1;
  });
