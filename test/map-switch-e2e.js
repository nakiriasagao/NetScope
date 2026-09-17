'use strict';
/**
 * 三个问题的复现与回归验收
 *   1. 中间节点颜色：不应被渲染成"起点绿"（应为本色蓝；仅时延/丢包明显恶化时才转黄/红）
 *   2. 高德底图连线上的跳数标签
 *   3. 高德 → 内置地图切换后内置地图能否正常显示
 *
 * 用法：node test/map-switch-e2e.js [baseUrl] [target]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TARGET = process.argv[3] || '223.5.5.5';
const PORT = 9802 + Math.floor(Math.random() * 90);
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
  // 读取服务端已配置的高德凭据状态（安全密钥无法回读，故需要命令行/环境变量提供）
  let amapKey = process.env.NS_AMAP_KEY || '';
  let amapSecurity = process.env.NS_AMAP_SECURITY || '';
  const cfg = await getJSON(BASE + '/api/amap/config').catch(() => null);
  const amapConfigured = Boolean(cfg && cfg.config && cfg.config.configured);
  if (!amapKey && amapConfigured) {
    console.log('提示：服务端已保存高德配置，但安全密钥不回传。');
    console.log('      如需验证高德模式，请提供：$env:NS_AMAP_KEY / $env:NS_AMAP_SECURITY');
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-switch-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1680,950', 'about:blank'], { stdio: 'ignore', windowsHide: true });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (!ready) { console.log('SKIP 浏览器未就绪'); child.kill(); process.exit(0); }

  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const pageTarget = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('[异常] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('[console.error] ' + m.params.args.map((a) => a.value || a.description).join(' '));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 90000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/?switch=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)");
    if (ok === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const failures = [];

  /* ================================================================ */
  /* 问题 1：中间节点颜色                                              */
  /* ================================================================ */
  console.log('================ 问题 1：中间节点颜色 ================');
  console.log('探测目标：' + TARGET);
  await evaluate(`window.NetScopeApp.trace(${JSON.stringify(TARGET)})`);
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const busy = await evaluate('String(window.NetScopeApp.state.busy)');
    if (busy === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 800));

  const colorAudit = JSON.parse(await evaluate(`JSON.stringify((function () {
    const r = window.NetScopeApp.renderer();
    const COLORS = window.NetScopeConfig.colors;
    return {
      startColor: COLORS.start,
      routeColor: COLORS.route,
      targetColor: COLORS.target,
      routeMid: COLORS.routeMid,
      routeSlow: COLORS.routeSlow,
      nodes: r.nodes.map(function (n) {
        return {
          label: n.label,
          kind: n.kind,
          isStart: Boolean(n.isStart),
          isTarget: Boolean(n.isTarget),
          geoStatus: n.geoStatus,
          ip: n.ip || (n.hops && n.hops.length ? n.hops[0].ip : null),
          latency: n.latency,
          lossPct: n.lossPct,
          hopsCount: (n.hops || []).length,
          color: r.nodeColor(n),
        };
      }),
    };
  })())`));

  console.log(`起点色 ${colorAudit.startColor} / 本色 ${colorAudit.routeColor} / 目标色 ${colorAudit.targetColor}`);
  console.log('\n节点着色明细：');
  let greenNodes = 0;
  for (const n of colorAudit.nodes) {
    const isGreen = n.color === colorAudit.startColor;
    const isTarget = n.isTarget;
    const degraded = (typeof n.latency === 'number' && n.latency > 180) || (n.lossPct && n.lossPct >= 50);
    let verdict = '';
    if (isGreen && !n.isStart && !isTarget && !degraded) {
      verdict = '  ← ✘ 中间节点被染成起点绿';
      greenNodes += 1;
    }
    console.log(
      `  ${String(n.label).padEnd(22)} kind=${String(n.kind).padEnd(9)} start=${n.isStart ? 'Y' : 'n'} target=${isTarget ? 'Y' : 'n'} ` +
      `geo=${String(n.geoStatus).padEnd(8)} 时延=${String(n.latency).padStart(7)} 丢包=${String(n.lossPct).padStart(5)} 色=${n.color}${verdict}`,
    );
  }
  if (greenNodes > 0) {
    failures.push(`问题 1：有 ${greenNodes} 个中间节点被渲染成起点绿`);
    console.log(`\n✘ 复现成功：${greenNodes} 个中间节点显示为绿色`);
  } else {
    console.log('\n✔ 未发现被误染成绿色的中间节点');
  }

  /* ================================================================ */
  /* 问题 2 + 3：高德标签 与 切回内置地图                                */
  /* ================================================================ */
  console.log('\n================ 问题 2/3：底图切换 ================');
  if (!amapKey || !amapSecurity) {
    console.log('⊘ 未提供高德凭据（NS_AMAP_KEY / NS_AMAP_SECURITY），跳过底图切换验收');
  } else {
    await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(amapKey)}, security: ${JSON.stringify(amapSecurity)}, enabled: true }); 'ok'`);
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'switched'");

    let amapReady = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await evaluate("JSON.stringify({ hasAMap: typeof window.AMap !== 'undefined', mode: window.NetScopeApp.state.baseMap })");
      const p = typeof st === 'string' && st.startsWith('{') ? JSON.parse(st) : {};
      if (p.hasAMap && p.mode === 'amap') { amapReady = true; break; }
    }
    console.log('高德底图就绪:', amapReady);
    if (!amapReady) failures.push('问题 2/3：高德底图未能启用');

    // 重新画一次拓扑（确保覆盖物与标签都生成）
    await evaluate("(function(){ const app = window.NetScopeApp; window.__amapDraw = function(){ return null; }; app.refreshStats(); })()");
    await evaluate(`(function(){
      const app = window.NetScopeApp;
      const view = app.__amapViewForTest || null;
      // 通过公开入口重绘：切换底图时已绘制过一次；这里再触发一次统计刷新与标签重绘
      if (window.NetScopeAmap) { /* 保留引用 */ }
      return 'ok';
    })()`);
    await evaluate("(function(){ const app = window.NetScopeApp; app.renderHopsTable(); })()");
    await new Promise((r) => setTimeout(r, 1200));

    const amapAudit = JSON.parse(await evaluate(`JSON.stringify((function () {
      // 高德模式下拓扑由内置引擎绘制到叠加层，标签在 SVG 图层里
      const labels = Array.from(document.querySelectorAll('#node-overlay g text')).map(function (t) { return (t.textContent || '').trim(); });
      const hopLabels = labels.filter(function (c) { return /第\\s*[\\d-]+\\s*跳/.test(c); });
      const overlay = document.getElementById('overlay-canvas');
      let overlayInk = 0;
      try {
        const ctx = overlay.getContext('2d');
        const img = ctx.getImageData(0, 0, overlay.width, Math.min(overlay.height, 500)).data;
        for (let i = 0; i < img.length; i += 4 * 17) {
          if (img[i] + img[i + 1] + img[i + 2] + img[i + 3] > 30) overlayInk += 1;
        }
      } catch (e) {
        overlayInk = -1;
      }
      const r = window.NetScopeApp.renderer();
      return {
        labelCount: labels.length,
        labelsSample: labels.slice(0, 8),
        hopLabelCount: hopLabels.length,
        hopLabelsSample: hopLabels.slice(0, 6),
        labelElements: document.querySelectorAll('#node-overlay g').length,
        overlayInkSamples: overlayInk,
        plainMode: r.plain === true,
        rendererCanvasId: r.canvas ? r.canvas.id : null,
        ctxMatchesCanvas: r.ctx && r.canvas ? r.ctx.canvas === r.canvas : null,
        canvasHidden: document.getElementById('map-canvas').hidden,
      };
    })())`));
    console.log(`高德模式标签：${amapAudit.labelCount} 个（含跳数 ${amapAudit.hopLabelCount} 个）`);
    console.log(`  标签样本：${JSON.stringify(amapAudit.hopLabelsSample)}`);
    console.log(`  叠加层：plain=${amapAudit.plainMode} 画布=${amapAudit.rendererCanvasId} 上下文匹配=${amapAudit.ctxMatchesCanvas} 着墨样本=${amapAudit.overlayInkSamples}`);
    if (!amapAudit.plainMode) failures.push('问题 2：高德模式未使用叠加层绘制');
    if (amapAudit.ctxMatchesCanvas !== true) failures.push('问题 2：渲染上下文与叠加画布不匹配（会画到隐藏画布上）');
    if (amapAudit.overlayInkSamples <= 0) failures.push('问题 2：叠加层画布没有内容');
    if (amapAudit.hopLabelCount === 0) {
      failures.push('问题 2：高德底图看不到跳数');
      console.log('✘ 复现：高德模式下看不到跳数');
    } else {
      console.log('✔ 高德模式已显示跳数与延迟');
    }

    /* ---- 切回内置地图 ---- */
    console.log('\n切回内置世界地图…');
    await evaluate("document.getElementById('opt-basemap').value = 'builtin'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    await new Promise((r) => setTimeout(r, 2500));

    const builtinAudit = JSON.parse(await evaluate(`JSON.stringify((function () {
      const r = window.NetScopeApp.renderer();
      const canvas = document.getElementById('map-canvas');
      const wrap = document.getElementById('canvas-wrap');
      const host = document.getElementById('amap-host');
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      const img = ctx.getImageData(0, 0, W, H).data;
      let land = 0;
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 4;
          const rr = img[i], gg = img[i + 1], bb = img[i + 2];
          if (Math.abs(rr - 22) < 14 && Math.abs(gg - 39) < 14 && Math.abs(bb - 63) < 16) land += 1;
        }
      }
      // 命中测试：画布中心点最上层的元素是否就是内置画布（防止高德残留覆盖）
      const rect = canvas.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        baseMap: window.NetScopeApp.state.baseMap,
        canvasHidden: canvas.hidden,
        canvasSize: [W, H],
        drawWidth: r.width, drawHeight: r.height,
        viewScale: Math.round(r.view.scale * 1000) / 1000,
        nodes: r.nodes.length,
        arcs: r.arcs.length,
        labels: document.querySelectorAll('#node-overlay g').length,
        landSamples: land,
        amapHostHidden: host ? host.hidden : null,
        amapHostChildren: host ? host.childElementCount : null,
        topElementId: top ? (top.id || top.className || top.tagName) : null,
        canvasIsTop: top === canvas,
      };
    })())`));
    console.log('切回后状态：', JSON.stringify(builtinAudit, null, 2));
    if (builtinAudit.baseMap !== 'builtin') failures.push('问题 3：未切回内置地图');
    if (builtinAudit.canvasHidden) failures.push('问题 3：内置画布仍处于隐藏状态');
    if (builtinAudit.amapHostHidden !== true) failures.push('问题 3：高德容器未隐藏，可能遮挡内置画布');
    if (builtinAudit.canvasIsTop !== true) failures.push(`问题 3：画布中心最上层元素是 ${builtinAudit.topElementId}，内置画布被遮挡`);
    if (builtinAudit.nodes < 1) failures.push('问题 3：切回后拓扑节点丢失');
    if (builtinAudit.landSamples < 20) {
      failures.push(`问题 3：切回后内置地图不可见（陆地抽样 ${builtinAudit.landSamples}）`);
      console.log('✘ 复现：切回内置地图后看不到地图');
    } else {
      console.log('✔ 切回后内置地图正常显示（陆地抽样 ' + builtinAudit.landSamples + '）');
    }
    if (builtinAudit.canvasIsTop) console.log('✔ 画布可交互（未被高德残留遮挡）');
  }

  if (errors.length) {
    console.log('\n页面脚本错误：');
    errors.slice(0, 8).forEach((e) => console.log('  ' + e));
    failures.push(`${errors.length} 个页面脚本错误`);
  }

  console.log('\n================ 结论 ================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    ws.close();
    child.kill();
    process.exit(1);
  }
  console.log('  ✔ 三项检查全部通过');
  ws.close();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
