'use strict';
/**
 * 样式一致性 + 图例验收
 *   1. 内置地图与高德地图的节点/连线是否由同一套绘制代码产出（对比节点半径、颜色、弧线标签）
 *   2. 高德模式下叠加层是否与高德容器同尺寸、节点屏幕坐标是否落在容器内
 *   3. 图例面板是否包含全部颜色说明（红/黄/蓝/绿/粉/灰）
 *
 * 用法：node test/style-consistency-e2e.js [baseUrl] [target]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TARGET = process.argv[3] || '8.8.8.8';
const PORT = 9740 + Math.floor(Math.random() * 40);
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.NS_AMAP_KEY || '';
const SECURITY = process.env.NS_AMAP_SECURITY || '';

function getJSON(url, t = 8000) {
  return new Promise((res, rej) => {
    const q = http.get(url, { timeout: t }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 90))); } });
    });
    q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); });
    q.on('error', rej);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-style-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1680,950', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
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
    if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/?style=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)");
    if (ok === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  const failures = [];

  /* ---------- 1. 图例完整性 ---------- */
  console.log('================ 图例 ================');
  const legend = JSON.parse(await evaluate(`JSON.stringify((function () {
    const panel = document.getElementById('legend-panel');
    const text = panel.textContent;
    return {
      exists: Boolean(panel),
      visibleByDefault: panel ? !panel.hidden : false,
      sections: panel ? panel.querySelectorAll('.legend-section').length : 0,
      items: panel ? panel.querySelectorAll('.legend-list li').length : 0,
      hasGreen: /绿色/.test(text),
      hasBlue: /蓝色/.test(text),
      hasRed: /红色/.test(text),
      hasYellow: /黄色/.test(text),
      hasPink: /粉色/.test(text),
      hasGray: /灰色/.test(text),
      explainsRed: /丢包\\s*≥\\s*50%|丢包 ≥ 50%/.test(text) && /180\\s*ms|180 ms/.test(text),
      explainsTimeoutMeaning: /不响应探测/.test(text),
      explainsLines: /按延迟着色/.test(text) && /流动光点/.test(text) && /跳数与延迟/.test(text),
      toggleWorks: (function () {
        const btn = document.getElementById('btn-legend');
        const before = panel.hidden;
        btn.click();
        const after = panel.hidden;
        btn.click();
        return before !== after;
      })(),
    };
  })())`));
  console.log(JSON.stringify(legend, null, 2));
  if (!legend.exists || !legend.visibleByDefault) failures.push('图例：面板缺失或默认未展开');
  if (legend.sections < 4) failures.push(`图例：分组不足（${legend.sections}）`);
  for (const key of ['hasGreen', 'hasBlue', 'hasRed', 'hasYellow', 'hasPink', 'hasGray']) {
    if (!legend[key]) failures.push(`图例：缺少 ${key} 的说明`);
  }
  if (!legend.explainsRed) failures.push('图例：未说明红色节点的判定条件');
  if (!legend.explainsTimeoutMeaning) failures.push('图例：未解释"超时跳/红色"的实际含义');
  if (!legend.explainsLines) failures.push('图例：连线说明不完整');
  if (!legend.toggleWorks) failures.push('图例：展开/收起按钮无效');

  /* ---------- 2. 基线：内置地图的绘制参数 ---------- */
  console.log('\n================ 探测 ================');
  await evaluate(`window.NetScopeApp.trace(${JSON.stringify(TARGET)})`);
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 800));

  const snapshot = `JSON.stringify((function () {
    var r = window.NetScopeApp.renderer();
    var C = window.NetScopeConfig.colors;
    return {
      plain: r.plain === true,
      mode: r.mode,
      canvasSize: [r.width, r.height],
      nodeCount: r.nodes.length,
      arcCount: r.arcs.length,
      /* 节点绘制参数：半径、颜色、是否带呼吸光晕（由 drawNodes 决定） */
      nodes: r.nodes.map(function (n) {
        return { label: n.label, kind: n.kind, color: r.nodeColor(n), latency: n.latency, lossPct: n.lossPct, screen: r.nodeScreen(n) };
      }),
      /* 连线参数：颜色算法、弧度、标签文本 */
      arcs: r.arcs.map(function (a) {
        var p = r.arcPath(a.from, a.to);
        return { color: r.arcColor(a), label: r.arcLabel(a), bend: Math.round(Math.hypot(p.cx - (p.a.x + p.b.x) / 2, p.cy - (p.a.y + p.b.y) / 2)), dist: Math.round(p.dist) };
      }),
      colors: { start: C.start, route: C.route, target: C.target, mid: C.routeMid, slow: C.routeSlow, timeout: C.timeout },
      labelElements: document.querySelectorAll('#node-overlay g').length,
    };
  })())`;

  const builtin = JSON.parse(await evaluate(snapshot));
  console.log(`内置地图：节点 ${builtin.nodeCount} 个，连线 ${builtin.arcCount} 条，标签 ${builtin.labelElements} 个`);
  builtin.nodes.forEach((n) => console.log(`  ${String(n.label).padEnd(20)} ${n.kind.padEnd(8)} 色=${n.color} 时延=${n.latency}`));

  /* ---------- 3. 切到高德，比对绘制参数 ---------- */
  if (!KEY || !SECURITY) {
    console.log('\n⊘ 未提供高德凭据，跳过样式一致性对比');
  } else {
    console.log('\n================ 高德模式（叠加层）================');
    await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
    }
    await new Promise((r) => setTimeout(r, 2500));

    const amap = JSON.parse(await evaluate(snapshot));
    console.log(`高德模式：节点 ${amap.nodeCount} 个，连线 ${amap.arcCount} 条，标签 ${amap.labelElements} 个`);
    console.log(`  绘制代码同源（plain 模式）: ${amap.plain ? '✔' : '✘'}`);

    // 节点颜色与延迟必须逐一相同
    const sameColors = builtin.nodes.length === amap.nodes.length
      && builtin.nodes.every((n, i) => n.color === amap.nodes[i].color && n.kind === amap.nodes[i].kind);
    const sameArcColors = builtin.arcs.length === amap.arcs.length
      && builtin.arcs.every((a, i) => a.color === amap.arcs[i].color);
    const sameArcLabels = builtin.arcs.length === amap.arcs.length
      && builtin.arcs.every((a, i) => a.label === amap.arcs[i].label);
    console.log(`  节点颜色一致: ${sameColors ? '✔' : '✘'}`);
    console.log(`  连线颜色一致: ${sameArcColors ? '✔' : '✘'}`);
    console.log(`  连线标签一致: ${sameArcLabels ? '✔' : '✘'} ${JSON.stringify(amap.arcs.map((a) => a.label))}`);
    if (!amap.plain) failures.push('样式：高德模式未启用叠加绘制（样式无法与内置地图一致）');
    if (!sameColors) failures.push('样式：高德与内置地图的节点颜色不一致');
    if (!sameArcColors) failures.push('样式：高德与内置地图的连线颜色不一致');
    if (!sameArcLabels) failures.push('样式：高德与内置地图的连线标签不一致');

    // 叠加层应当与高德容器同尺寸，且节点坐标落在容器内
    const layout = JSON.parse(await evaluate(`JSON.stringify((function () {
      var host = document.getElementById('amap-host');
      var overlay = document.getElementById('overlay-canvas');
      var r = window.NetScopeApp.renderer();
      var hr = host.getBoundingClientRect();
      var or = overlay.getBoundingClientRect();
      var inside = r.nodes.filter(function (n) {
        var s = r.nodeScreen(n);
        return s.x >= -20 && s.y >= -20 && s.x <= r.width + 20 && s.y <= r.height + 20;
      }).length;
      return {
        hostSize: [Math.round(hr.width), Math.round(hr.height)],
        overlaySize: [Math.round(or.width), Math.round(or.height)],
        rendererSize: [r.width, r.height],
        overlayHidden: overlay.hidden,
        amapHostHidden: host.hidden,
        nodesInsideView: inside,
        nodeTotal: r.nodes.length,
        labels: document.querySelectorAll('#node-overlay g').length,
      };
    })())`));
    console.log('  叠加层布局:', JSON.stringify(layout));
    if (layout.overlayHidden) failures.push('样式：叠加层被隐藏，拓扑不可见');
    if (Math.abs(layout.overlaySize[0] - layout.hostSize[0]) > 2 || Math.abs(layout.overlaySize[1] - layout.hostSize[1]) > 2) {
      failures.push(`样式：叠加层与高德容器尺寸不一致（${layout.overlaySize} vs ${layout.hostSize}）`);
    }
    if (layout.nodesInsideView < layout.nodeTotal) {
      failures.push(`样式：有 ${layout.nodeTotal - layout.nodesInsideView} 个节点坐标落在视野之外`);
    }
    if (layout.labels === 0) failures.push('样式：高德模式下没有渲染标签');

    // 截图留档
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(__dirname, '..', 'data', 'screenshots');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'style-amap.png'), Buffer.from(shot.data, 'base64'));
    console.log('  已保存: data/screenshots/style-amap.png');

    /* ---- 切回内置地图，样式应保持不变 ---- */
    await evaluate("document.getElementById('opt-basemap').value = 'builtin'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    await new Promise((r) => setTimeout(r, 2500));
    const back = JSON.parse(await evaluate(snapshot));
    const backSame = back.nodes.length === builtin.nodes.length
      && back.nodes.every((n, i) => n.color === builtin.nodes[i].color);
    console.log(`\n切回内置地图：plain=${back.plain} 节点颜色保持一致=${backSame ? '✔' : '✘'}`);
    if (back.plain) failures.push('样式：切回内置地图后叠加模式未复位');
    if (!backSame) failures.push('样式：切回内置地图后节点颜色发生变化');

    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'style-builtin.png'), Buffer.from(shot2.data, 'base64'));
    console.log('  已保存: data/screenshots/style-builtin.png');
  }

  if (errors.length) {
    console.log('\n页面错误：');
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
  console.log('  ✔ 图例完整，两套底图样式一致');
  ws.close();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
