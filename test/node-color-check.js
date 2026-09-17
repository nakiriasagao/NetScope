'use strict';
/**
 * 节点着色逻辑的针对性验证
 * 直接在浏览器里对 renderer.nodeColor 注入合成节点，覆盖各种角色组合。
 * 用法：node test/node-color-check.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9790 + Math.floor(Math.random() * 60);
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-color-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const target = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 60000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: BASE + '/?color=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)");
    if (ok === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const report = await evaluate(`JSON.stringify((function () {
    const r = window.NetScopeApp.renderer();
    const C = window.NetScopeConfig.colors;
    const mk = function (over) {
      return Object.assign({
        kind: 'hop', label: 'x', isStart: false, isTarget: false, geoStatus: 'public',
        latency: 10, lossPct: 0, hops: [], deviceType: null, lanMode: false,
      }, over);
    };
    const cases = [
      { name: '起点（本机，合并了接入点）', node: mk({ kind: 'start', isStart: true, geoStatus: 'private', label: '本机 / 接入点' }), expect: C.start },
      { name: '独立本机节点', node: mk({ kind: 'start', isStart: true, geoStatus: 'private', label: '本机' }), expect: C.start },
      { name: '私网中间跳（运营商侧 10.x，低时延）', node: mk({ kind: 'hop', geoStatus: 'private', latency: 4, label: '10.0.0.1' }), expect: C.route },
      { name: '普通公网中间跳（低时延 6ms）', node: mk({ kind: 'hop', latency: 6, label: '上海' }), expect: C.route },
      { name: '普通公网中间跳（中时延 90ms，未超阈值）', node: mk({ kind: 'hop', latency: 90, label: '东京' }), expect: C.route },
      { name: '高时延中间跳（220ms，超阈值）', node: mk({ kind: 'hop', latency: 220, label: '法兰克福' }), expect: C.routeSlow },
      { name: '高丢包中间跳（100%，时延很小）', node: mk({ kind: 'hop', latency: 5, lossPct: 100, label: '丢包跳' }), expect: C.routeSlow },
      { name: '中等丢包中间跳（33%）', node: mk({ kind: 'hop', latency: 5, lossPct: 33, label: '中等丢包跳' }), expect: C.routeMid },
      { name: '完全无响应的跳（* * *）', node: mk({ kind: 'hop', latency: null, lossPct: 100, isTimeout: true, hops: [{ isTimeout: true, latency: { lossPct: 100 } }], label: '无响应' }), expect: C.timeout },
      { name: '目标节点', node: mk({ kind: 'target', isTarget: true, latency: 8, label: '目标' }), expect: C.target },
      { name: '局域网：网关', node: mk({ kind: 'gateway', lanMode: true, label: '网关' }), expect: null },
      { name: '局域网：设备', node: mk({ kind: 'device', lanMode: true, deviceType: 'printer', label: '打印机' }), expect: null },
      { name: '局域网：本机', node: mk({ kind: 'start', isStart: true, lanMode: true, label: '本机' }), expect: null },
    ];
    return cases.map(function (c) {
      const got = r.nodeColor(c.node);
      return { name: c.name, expect: c.expect, got: got, ok: c.expect === null ? true : got === c.expect };
    });
  })())`);

  const results = JSON.parse(report);
  console.log('================ 节点着色规则验证 ================');
  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? '✔' : '✘';
    if (!r.ok) failed += 1;
    console.log(`  ${mark} ${r.name.padEnd(38)} 期望 ${String(r.expect || '（不限）').padEnd(9)} 实际 ${r.got}`);
  }
  console.log(failed ? `\n✘ ${failed} 项不符合预期` : '\n✔ 全部符合预期');
  ws.close();
  child.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('验证失败：', e.message); process.exit(1); });
