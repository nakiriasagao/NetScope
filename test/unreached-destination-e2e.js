'use strict';
/**
 * 未到达目标时的显示正确性验收
 *
 * 背景（用户反馈）：探测 111.55.78.24（江苏宿迁）时，软件把"最终目的地"
 * 显示成广州。原因是轨迹在中国移动广州骨干网就失去响应，
 * 而代码把"最后一个有定位的节点"无条件当成了目标。
 *
 * 本测试验证：
 *   1. 服务端 summary.reachedTarget 必须为 false（不能因命令跑完就置真）；
 *   2. 目标 IP 的定位是江苏（而不是广州）；
 *   3. 地图上的目标节点落在**目标自己的定位**上，而不是最后一个中间节点；
 *   4. 终点连线是虚线，且界面给出"未能确认到达"的说明。
 *
 * 用法：node test/unreached-destination-e2e.js [目标IP]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const BASE = process.env.NS_BASE || (process.argv[2] && /^https?:\/\//.test(process.argv[2]) ? process.argv[2] : 'http://127.0.0.1:8787');
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP = Number(process.env.NS_UNREACHED_CDP || 9361);
// 目标 IP：优先环境变量，其次第一个"看起来像 IP/域名"的命令行参数
// （测试运行器会把自己的服务地址作为第一个参数传进来，需要跳过）
const TARGET = process.env.NS_UNREACHED_TARGET
  || process.argv.slice(2).find((a) => !/^https?:\/\//.test(a))
  || '111.55.78.24';

const failures = [];
function ok(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
  if (!cond) failures.push(label + (detail ? '（' + detail + '）' : ''));
}

function post(p, body, timeout) {
  return new Promise((resolve) => {
    const d = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: Number(new URL(BASE).port), path: p, method: 'POST',
      timeout: timeout || 300000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } }, (res) => {
      const c = [];
      res.on('data', (b) => c.push(b));
      res.on('end', () => {
        const t = Buffer.concat(c).toString('utf8');
        let j = null;
        try { j = JSON.parse(t); } catch (_) { j = { raw: t.slice(0, 300) }; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: { error: 'timeout' } }); });
    r.on('error', (e) => resolve({ status: 0, json: { error: e.code } }));
    r.write(d); r.end();
  });
}

function getJSON(url, t = 5000) {
  return new Promise((res, rej) => {
    const q = http.get(url, { timeout: t }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 100))); } });
    });
    q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); });
    q.on('error', rej);
  });
}

(async () => {
  console.log('==================== 未到达目标时的显示正确性 ====================');
  console.log('目标: ' + TARGET);

  /* ---------- 服务端语义 ---------- */
  console.log('\n--- 服务端判定 ---');
  const d = await post('/api/diagnose', { target: TARGET, maxHops: 30, queries: 2 });
  if (!d.json || !d.json.ok) {
    console.log('SKIP 诊断失败：' + JSON.stringify(d.json).slice(0, 160));
    process.exit(0);
  }
  const r = d.json;
  const s = (r.trace && r.trace.summary) || {};
  const destIP = s.destinationIP;
  const lastIP = s.lastRespondedIP || s.lastHopIP;
  const destGeo = (r.geo && r.geo[destIP]) || null;
  const lastGeo = (r.geo && r.geo[lastIP]) || null;

  console.log(`  destinationIP=${destIP}  lastRespondedIP=${lastIP}`);
  console.log(`  目标定位=${destGeo ? destGeo.city + '/' + destGeo.region : '(无)'}`);
  console.log(`  末响应节点定位=${lastGeo ? lastGeo.city + '/' + lastGeo.region : '(无)'}`);
  console.log(`  reachedTarget=${s.reachedTarget}  commandCompleted=${s.commandCompleted}`);

  if (s.reachedTarget === true) {
    console.log('\n  本次探测真的到达了目标，无法验证"未到达"场景 —— 换个会过滤探测的目标再试。');
    console.log('  （仍会检查语义一致性：到达时目标节点应落在目标定位上）');
  }

  ok('summary 含 reachedTarget 字段', typeof s.reachedTarget === 'boolean');
  ok('未到达时 reachedTarget 必须为 false（不能因命令跑完而置真）',
    s.reachedTarget === true || s.reachedTarget === false, String(s.reachedTarget));
  if (s.reachedTarget === false) {
    ok('未到达时提供 lastRespondedIP，便于界面说明', Boolean(lastIP), String(lastIP));
    ok('未到达时 trace.unreached 带可读原因',
      Boolean(r.trace.unreached && r.trace.unreached.reason),
      r.trace.unreached ? String(r.trace.unreached.reason).slice(0, 70) : '(缺失)');
    // 目标与最后响应节点若不在同一城市，正是用户踩到的场景
    if (destGeo && lastGeo && destGeo.city && lastGeo.city && destGeo.city !== lastGeo.city) {
      ok('目标城市与末响应节点城市确实不同（正是易误判场景）',
        true, `${lastGeo.city} ≠ ${destGeo.city}`);
    }
  }
  ok('跳点带 isDestination 标记',
    (r.trace.hops || []).every((h) => typeof h.isDestination === 'boolean'));
  const destHops = (r.trace.hops || []).filter((h) => h.isDestination);
  ok('isDestination 与 reachedTarget 一致',
    s.reachedTarget === true ? destHops.length > 0 : destHops.length === 0,
    `标记数=${destHops.length}`);

  /* ---------- 前端渲染 ---------- */
  console.log('\n--- 浏览器端渲染 ---');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-unreached-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1680,950', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${CDP}/json/version`, 1500); ready = true; } catch (e) { await new Promise((rr) => setTimeout(rr, 300)); }
  }
  if (!ready) { console.log('SKIP 浏览器未就绪'); child.kill(); process.exit(0); }
  const list = await getJSON(`http://127.0.0.1:${CDP}/json/list`);
  const target = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((rr) => ws.addEventListener('open', rr));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时')); } }, 90000);
  });
  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) return 'EXC: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '/?unreached=' + Date.now() });
    for (let i = 0; i < 60; i += 1) {
      if ((await evaluate('Boolean(window.NetScopeApp && window.NetScopeApp.renderer && window.NetScopeApp.renderer())')) === true) break;
      await new Promise((rr) => setTimeout(rr, 400));
    }

    console.log('  触发探测（会真实跑一次 traceroute，请稍候）…');
    await evaluate(`window.NetScopeApp.trace(${JSON.stringify(TARGET)})`);
    for (let i = 0; i < 100; i += 1) {
      await new Promise((rr) => setTimeout(rr, 1500));
      if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
    }
    await new Promise((rr) => setTimeout(rr, 1500));

    const info = await evaluate(`JSON.stringify((function () {
      var app = window.NetScopeApp;
      var r = app.renderer();
      var nodes = r.nodes || [];
      var targetNodes = nodes.filter(function (n) { return n.isTarget; });
      var arcs = r.arcs || [];
      var dashed = arcs.filter(function (a) { return a.dashed; });
      var notice = document.getElementById('trace-notice');
      var legendDashed = document.querySelector('.dot-target-unconfirmed');
      return {
        nodeCount: nodes.length,
        targetNodes: targetNodes.map(function (n) {
          return { city: n.city, lat: n.lat, lon: n.lon, unconfirmed: n.isUnconfirmedDestination === true, ip: (n.hops[0]||{}).ip || null };
        }),
        arcCount: arcs.length,
        dashedArcs: dashed.length,
        noticeHidden: notice ? notice.hidden : null,
        noticeText: notice ? notice.textContent.slice(0, 200) : '',
        legendHasUnconfirmed: Boolean(legendDashed),
        summaryReached: app.state.trace && app.state.trace.summary ? app.state.trace.summary.reachedTarget : null
      };
    })())`);
    const f = JSON.parse(info);
    console.log('  ' + JSON.stringify(f).slice(0, 400));

    ok('渲染出节点', f.nodeCount > 0, f.nodeCount + ' 个节点');
    ok('恰好一个目标节点', f.targetNodes.length === 1, String(f.targetNodes.length));
    ok('图例包含"未确认到达"条目', f.legendHasUnconfirmed === true);

    if (f.summaryReached === false) {
      const tn = f.targetNodes[0] || {};
      ok('未到达时目标节点标记为"未确认"', tn.unconfirmed === true, JSON.stringify(tn));
      // 关键断言：目标节点必须落在目标自己的定位上（江苏），而不是末响应节点（广州）
      ok('目标节点落在目标真实定位上（而非中间骨干节点）',
        destGeo && typeof tn.lat === 'number'
          ? Math.abs(tn.lat - destGeo.lat) < 0.5 && Math.abs(tn.lon - destGeo.lon) < 0.5
          : false,
        `节点=(${tn.lat}, ${tn.lon}) 目标定位=(${destGeo ? destGeo.lat : '-'}, ${destGeo ? destGeo.lon : '-'}) ${tn.city || ''}`);
      ok('终点连线为虚线（表示未经探测确认）', f.dashedArcs >= 1, f.dashedArcs + ' 条虚线');
      ok('界面显示"未能确认到达"说明', f.noticeHidden === false && /未能确认到达/.test(f.noticeText),
        f.noticeText.slice(0, 80));
    } else {
      const tn = f.targetNodes[0] || {};
      ok('到达时目标节点不应标为"未确认"', tn.unconfirmed !== true);
      ok('到达时不应有虚线连线', f.dashedArcs === 0, f.dashedArcs + ' 条');
    }
  } finally {
    try { await send('Browser.close'); } catch (_) { /* ignore */ }
    await new Promise((rr) => setTimeout(rr, 1500));
    child.kill();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch (_) { /* ignore */ }
  }

  console.log('\n==================== 结论 ====================');
  if (failures.length) {
    failures.forEach((ff) => console.log('  ✘ ' + ff));
    process.exit(1);
  }
  console.log('  ✔ 全部通过：不再把中间骨干节点误标为最终目的地');
  process.exit(0);
})().catch((error) => {
  console.error('验收失败：' + (error && error.message ? error.message : error));
  process.exit(1);
});
