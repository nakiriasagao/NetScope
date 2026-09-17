'use strict';
/**
 * 局域网拓扑图界面验收
 * 1. 点击「扫描局域网设备」，等待扫描完成
 * 2. 校验星型拓扑是否正确绘制（节点数 / 连线数 / 设备与网关标签）
 * 3. 校验统计栏与设备表
 * 4. 打开设置面板确认高德配置入口可用
 * 5. 截图 data/screenshots/lan-topology.png
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9880 + Math.floor(Math.random() * 60);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-lan-'));
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
  await send('Page.navigate', { url: BASE + '/?v=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)").catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('页面已加载');

  // 设置面板入口
  const settingsOk = await evaluate(`(function () {
    document.getElementById('btn-settings').click();
    const modal = document.getElementById('settings-modal');
    const visible = !modal.hidden;
    const hasKey = Boolean(document.getElementById('amap-key'));
    const hasSecurity = Boolean(document.getElementById('amap-security'));
    document.getElementById('settings-close').click();
    return JSON.stringify({ visible: visible, hasKey: hasKey, hasSecurity: hasSecurity, closed: document.getElementById('settings-modal').hidden });
  })()`);
  const s = JSON.parse(settingsOk);
  console.log(`设置面板：可打开=${s.visible} Key 输入框=${s.hasKey} 安全密钥输入框=${s.hasSecurity} 可关闭=${s.closed}`);

  // 触发局域网扫描
  console.log('开始扫描局域网…');
  await evaluate("document.getElementById('opt-deepscan').checked = true; document.getElementById('btn-lanscan').click();");

  let done = false;
  let lastState = '{}';
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await evaluate(`JSON.stringify({
      busy: window.NetScopeApp.state.busy,
      lan: Boolean(window.NetScopeApp.state.lan),
      nodes: window.NetScopeApp.renderer().nodes.length,
      arcs: window.NetScopeApp.renderer().arcs.length,
      lanMode: window.NetScopeApp.renderer().lanMode === true,
      progress: document.getElementById('progress-text').textContent,
      toasts: Array.from(document.querySelectorAll('.toast')).map(function (t) { return t.textContent.slice(0, 100); }),
    })`).catch(() => '{}');
    lastState = st;
    const parsed = JSON.parse(st);
    if (parsed.lan && !parsed.busy && parsed.nodes > 0) { done = true; break; }
  }
  if (!done) {
    console.log('✘ 扫描未在预期时间内完成，最后状态：');
    console.log('  ' + lastState);
  }

  const audit = JSON.parse(await evaluate(`JSON.stringify((function () {
    const app = window.NetScopeApp;
    const r = app.renderer();
    const lan = app.state.lan || {};
    const topo = lan.topology || {};
    const devices = (topo.nodes || []).filter(function (n) { return n.role === 'device'; });
    const roles = r.nodes.map(function (n) { return n.kind; });
    return {
      lanMode: r.lanMode === true,
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      roles: roles,
      devices: devices.length,
      deviceSample: devices.slice(0, 12).map(function (d) { return { ip: d.ip, mac: d.mac, vendor: d.vendor, hostname: d.hostname, type: d.typeLabel }; }),
      subnet: lan.lan && lan.lan.subnet,
      gateway: lan.lan && lan.lan.gateway,
      scanned: lan.lan && lan.lan.scanned,
      egress: lan.egress,
      statsTarget: document.getElementById('stat-target').textContent,
      statsHops: document.getElementById('stat-hops').textContent,
      tableRows: document.querySelectorAll('#hops-table tbody tr[data-lan-index]').length,
      activeTab: document.querySelector('.tab.is-active').getAttribute('data-tab'),
      viewActive: document.querySelector('[data-view].is-active').getAttribute('data-view'),
      svgLabels: document.querySelectorAll('#node-overlay g').length,
    };
  })())`));

  console.log('\n=== 局域网拓扑审计 ===');
  console.log('局域网模式:', audit.lanMode, '| 视图:', audit.viewActive, '| 激活标签:', audit.activeTab);
  console.log('网段:', audit.subnet, '| 网关:', audit.gateway);
  console.log('扫描统计:', JSON.stringify(audit.scanned));
  console.log('公网出口:', audit.egress && audit.egress.ip, '| 定位:', audit.egress && audit.egress.provider);
  console.log('拓扑节点:', audit.nodes, '| 连线:', audit.arcs, '| 节点角色:', audit.roles.join(','));
  console.log('设备数:', audit.devices, '| 设备表行数:', audit.tableRows, '| SVG 标签:', audit.svgLabels);
  console.log('统计栏: 目标=' + audit.statsTarget + ' 设备数=' + audit.statsHops);
  console.log('\n设备明细:');
  for (const d of audit.deviceSample) {
    console.log(`  ${String(d.ip || '—').padEnd(16)} ${String(d.mac || '—').padEnd(18)} ${String(d.vendor || '未知厂商').padEnd(30)} ${String(d.type || '').padEnd(10)} ${d.hostname || ''}`);
  }

  // 截图统一输出到项目根目录的 data/screenshots（该目录已在 .gitignore 中）
  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'lan-topology.png'), Buffer.from(shot.data, 'base64'));
  console.log('\n已保存: data/screenshots/lan-topology.png');

  const checks = [
    ['设置面板可用', s.visible && s.hasKey && s.hasSecurity && s.closed],
    ['扫描完成并进入局域网模式', audit.lanMode],
    ['拓扑有节点与连线', audit.nodes >= 2 && audit.arcs >= 1],
    ['包含网关节点', audit.roles.includes('gateway')],
    ['包含本机节点', audit.roles.includes('start')],
    ['包含互联网节点', audit.roles.includes('internet')],
    ['设备表已填充', audit.tableRows >= 2],
    ['统计栏显示网段', /\/\d+/.test(audit.statsTarget || '')],
    ['无页面脚本错误', errors.length === 0],
  ];
  console.log('\n=== 验收结果 ===');
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed += 1;
  }
  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 8).forEach((e) => console.log('  - ' + e));
  }
  ws.close();
  child.kill();
  console.log(failed ? `\n✘ ${failed} 项未通过` : '\n✔ 全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
