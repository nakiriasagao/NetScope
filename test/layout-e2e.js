'use strict';
/**
 * 最终视觉验收：真实探测一个跨洲目标，截图确认
 *   1) 地图纵横比是否正常（不再被拉升）
 *   2) 底部统计栏是否与画布左右对齐、目标行是否自适应长度
 *   3) 是否存在横条纹
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TARGET = process.argv[3] || '8.8.8.8';
const PORT = 9970 + Math.floor(Math.random() * 20);
const BROWSER = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function getJSON(url, t = 8000) {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-final-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1680,950', 'about:blank'], { stdio: 'ignore', windowsHide: true });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const target = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 120000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?autorun=1&target=${encodeURIComponent(TARGET)}&maxHops=24&resolveNames=0&v=${Date.now()}` });
  console.log('已加载页面，目标：' + TARGET);

  for (let i = 0; i < 150; i += 1) {
    const busy = await evaluate('window.NetScopeApp ? String(window.NetScopeApp.state.busy) : "noapp"').catch(() => 'noapp');
    const hops = await evaluate('window.NetScopeApp ? window.NetScopeApp.state.hops.length : -1').catch(() => -1);
    if (busy === 'false' && hops > 0) { console.log(`探测完成：${hops} 跳`); break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  await new Promise((r) => setTimeout(r, 800));

  const audit = await evaluate(`JSON.stringify((function () {
    const r = window.NetScopeApp.renderer();
    const world = r.world;
    const xDeg = world.width / (world.lonMax - world.lonMin);
    const yDeg = world.height / (world.latMax - world.latMin);
    const stats = document.getElementById('map-stats').getBoundingClientRect();
    const wrap = document.getElementById('canvas-wrap').getBoundingClientRect();
    const tv = document.getElementById('stat-target');
    return {
      world: [world.width, world.height],
      pxPerDeg: [xDeg.toFixed(3), yDeg.toFixed(3)],
      aspectOK: Math.abs(xDeg / yDeg - 1) < 0.001,
      statsAlign: { left: Math.round(stats.left - wrap.left), right: Math.round(wrap.right - stats.right), width: Math.round(stats.width), wrapWidth: Math.round(wrap.width) },
      targetText: tv.textContent,
      targetFull: tv.title,
      targetOverflow: tv.scrollWidth > Math.ceil(tv.getBoundingClientRect().width) + 1,
      hops: window.NetScopeApp.state.hops.length,
      unlocated: r.unlocated ? r.unlocated.length : 0,
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      badArcs: r.arcs.filter(function (a) { return typeof a.from.lat !== 'number' || typeof a.to.lat !== 'number'; }).length,
    };
  })())`);
  const a = JSON.parse(audit);
  console.log('\n=== 验收数据 ===');
  console.log('地图画布:', a.world.join('x'), '| 每度像素 经度', a.pxPerDeg[0], '纬度', a.pxPerDeg[1], '| 等比例:', a.aspectOK ? '✔' : '✘');
  console.log('统计栏对齐: 距左', a.statsAlign.left + 'px', '距右', a.statsAlign.right + 'px', '| 宽', a.statsAlign.width, '画布宽', a.statsAlign.wrapWidth);
  console.log('目标显示:', JSON.stringify(a.targetText), '| 完整值:', JSON.stringify(a.targetFull), '| 溢出:', a.targetOverflow);
  console.log('拓扑: 跳点', a.hops, '| 已定位节点', a.nodes, '| 未定位', a.unlocated, '| 连线', a.arcs, '| 跨越未定位的连线', a.badArcs);

  const outDir = path.join(__dirname, 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'final-map.png'), Buffer.from(shot.data, 'base64'));
  console.log('\n已保存: data/screenshots/final-map.png');

  // 长地址场景
  await evaluate(`(function () {
    const app = window.NetScopeApp;
    app.state.input = 'a.really.extremely.long.hostname.that.keeps.going.forever.example.org';
    app.state.target = { host: 'a.really.extremely.long.hostname.that.keeps.going.forever.example.org', primaryIP: '2001:0db8:85a3:0000:0000:8a2e:0370:7334' };
    app.refreshStats();
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'final-map-long-target.png'), Buffer.from(shot.data, 'base64'));
  console.log('已保存: data/screenshots/final-map-long-target.png（超长地址场景）');

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 8).forEach((e) => console.log('  - ' + e));
  } else {
    console.log('\n✔ 页面无 console 错误');
  }

  ws.close();
  child.kill();
  const ok = a.aspectOK && !a.targetOverflow && a.badArcs === 0 && Math.abs(a.statsAlign.left - a.statsAlign.right) <= 1 && errors.length === 0;
  console.log(ok ? '\n✔ 全部验收项通过' : '\n✘ 存在未通过项');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
