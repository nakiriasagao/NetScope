'use strict';
// API 冒烟测试：逐个调用关键接口，输出精简结果
const http = require('http');

const BASE = process.env.NS_BASE || 'http://127.0.0.1:8787';

function request(method, path, body, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(path, BASE);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        timeout: timeoutMs,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* 保留原文 */ }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function sse(path, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const events = [];
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: 'GET' }, (res) => {
      let buffer = '';
      const timer = setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, events }); }, timeoutMs);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const ev = /^event: (.+)$/m.exec(part);
          const dt = /^data: (.+)$/m.exec(part);
          if (ev && dt) {
            let payload = null;
            try { payload = JSON.parse(dt[1]); } catch (e) { payload = dt[1]; }
            events.push({ event: ev[1], payload });
            if (ev[1] === 'done' || ev[1] === 'error') {
              clearTimeout(timer);
              req.destroy();
              resolve({ status: res.statusCode, events });
            }
          }
        }
      });
      res.on('end', () => {
        // 注意：只有收到 done / error 事件才算正常结束；
        // 若连接被提前关闭，交由超时兜底，避免把“连接被截断”误判为成功。
        clearTimeout(timer);
        resolve({ status: res.statusCode, events, ended: true });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message, events }));
    req.end();
  });
}

(async () => {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' → ' + detail : ''}`);
  };

  // 1. health
  let r = await request('GET', '/api/health');
  record('GET /api/health', r.status === 200 && r.json && r.json.ok, r.json ? `${r.json.name} ${r.json.version} node ${r.json.node}` : r.error || r.status);

  // 2. static index
  r = await request('GET', '/');
  record('GET / (静态页面)', r.status === 200 && /<html/i.test(r.text || ''), `status=${r.status} len=${(r.text || '').length}`);

  // 3. world map data
  r = await request('GET', '/data/world-110m.json');
  let countryCount = 0;
  try { countryCount = JSON.parse(r.text).countries.length; } catch (e) { /* ignore */ }
  record('GET /data/world-110m.json', r.status === 200 && countryCount > 100, `国家数=${countryCount}`);

  // 4. analyze
  r = await request('POST', '/api/analyze', { target: 'https://www.baidu.com/s?wd=test' });
  record('POST /api/analyze', r.status === 200 && r.json?.ok, r.json?.primaryIP ? `host=${r.json.host} ip=${r.json.primaryIP} kind=${r.json.classification?.kind}` : JSON.stringify(r.json)?.slice(0, 200));

  // 5. geo
  r = await request('POST', '/api/geo', { ips: ['8.8.8.8', '1.1.1.1', '192.168.1.1'] });
  const g = r.json?.results || {};
  record('POST /api/geo', r.status === 200 && Object.keys(g).length === 3, Object.entries(g).map(([ip, v]) => `${ip}=${v.city || v.status}(${v.provider})`).join(', '));

  // 6. local
  r = await request('GET', '/api/local?includePublicIP=0', null, 60000);
  record('GET /api/local', r.status === 200 && r.json?.ok, r.json ? `ifaces=${r.json.interfaces?.length} gw=${(r.json.gateways || []).join('/')} dns=${(r.json.dnsServers || []).length} arp=${r.json.neighbors?.length}` : r.error);

  // 7. trace (sync)
  r = await request('POST', '/api/trace', { target: 'www.baidu.com', maxHops: 10, resolveNames: false }, 180000);
  record('POST /api/trace', r.status === 200 && r.json?.ok, r.json?.trace ? `engine=${r.json.trace.engine} hops=${r.json.trace.hops.length} reached=${r.json.trace.summary?.reachedTarget}` : JSON.stringify(r.json)?.slice(0, 200));

  // 8. dns
  r = await request('POST', '/api/dns', { domain: 'www.baidu.com' }, 60000);
  record('POST /api/dns', r.status === 200 && r.json?.ok, r.json ? `A=${(r.json.summary?.addresses || []).join(',')} CNAME=${r.json.summary?.cname || '-'} NS=${(r.json.summary?.nameservers || []).length}` : r.error);

  // 9. portscan (小范围，避免耗时)
  r = await request('POST', '/api/portscan', { target: 'www.baidu.com', mode: 'list', ports: [80, 443, 8080] }, 90000);
  record('POST /api/portscan', r.status === 200 && r.json?.ok, r.json?.scan ? `open=${r.json.scan.open.map((p) => p.port).join(',') || '无'} 耗时=${r.json.scan.durationMs}ms` : r.error);

  // 10. security
  r = await request('POST', '/api/security', { target: 'www.baidu.com' }, 60000);
  record('POST /api/security', r.status === 200 && r.json?.ok, r.json?.certificate ? `cert=${r.json.certificate.ok ? (r.json.certificate.issuer?.O || '已获取') + ' 剩余' + r.json.certificate.daysRemaining + '天' : r.json.certificate.error} 观察=${r.json.observations?.length}` : r.error);

  // 11. SSE trace stream
  const s = await sse('/api/trace/stream?target=223.5.5.5&maxHops=8&resolveNames=0', 180000);
  const hopEvents = s.events
    .filter((e) => e.event === 'progress' && e.payload && (e.payload.stage === 'hops' || e.payload.stage === 'hop'))
    .reduce((acc, e) => acc + (e.payload.hops ? e.payload.hops.length : 1), 0);
  const doneEvent = s.events.find((e) => e.event === 'done');
  record(
    'GET /api/trace/stream (SSE)',
    Boolean(doneEvent) && hopEvents > 0,
    `事件=${s.events.length} 逐跳推送=${hopEvents} 引擎=${doneEvent?.payload?.engine || doneEvent?.payload?.result?.trace?.engine || '-'}`,
  );

  // 12. 结果回取接口
  const taskId = doneEvent?.payload?.taskId;
  if (taskId) {
    const rr = await request('GET', `/api/result?taskId=${taskId}`, null, 30000);
    const hopsInResult = rr.json?.result?.trace?.hops?.length || 0;
    record('GET /api/result', rr.status === 200 && rr.json?.ok && hopsInResult > 0, `taskId=${taskId} 跳数=${hopsInResult}`);
  } else {
    record('GET /api/result', false, '未能从 done 事件取得 taskId');
  }

  console.log('\n================ 汇总 ================');
  const passed = results.filter((x) => x.ok).length;
  console.log(`${passed}/${results.length} 通过`);
  const failed = results.filter((x) => !x.ok);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log('  - ' + f.name + ' → ' + f.detail);
  }
  process.exit(failed.length ? 1 : 0);
})();
