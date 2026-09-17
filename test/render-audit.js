'use strict';

/**
 * 地图渲染对抗性测试
 *
 * 用多组合成数据（含"中间跳点无法地理定位"、跨洲、极端纬度、全部未定位等）
 * 反复驱动渲染器，审计：
 *   1. 是否抛出脚本异常
 *   2. 陆地图元是否真的画在画布内（像素抽样）
 *   3. 连线是否跨越"未定位"节点
 *   4. 视图平移/缩放后地图是否仍可见（是否存在拖出视野无法恢复的问题）
 *   5. 视图切换后是否残留旧坐标
 *
 * 用法：node test/render-audit.js [baseUrl]
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const DEBUG_PORT = 9411 + Math.floor(Math.random() * 400);

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

function getJSON(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { reject(new Error('非 JSON: ' + t.slice(0, 160))); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')); });
    req.on('error', reject);
  });
}

/** 合成一份含未定位跳点的轨迹数据 */
const SYNTHETIC_HOPS = [
  { ttl: 1, ip: '192.168.1.1', hostname: null, latency: { attempts: 3, responded: 3, lossPct: 0, min: 1, avg: 1.2, max: 2, jitter: 1 }, geo: { lat: 31.22, lon: 121.46, city: '上海', country: '中国', provider: 'builtin-local', status: 'private', precision: 'city' } },
  { ttl: 2, ip: '101.95.39.226', hostname: null, latency: { attempts: 3, responded: 3, lossPct: 0, min: 3, avg: 4, max: 5, jitter: 2 }, geo: { lat: 31.22, lon: 121.46, city: '上海', country: '中国', provider: 'ipwho.is', status: 'public', precision: 'city' } },
  // 关键样本：中间这几跳地理定位失败（geo 为 null）
  { ttl: 3, ip: '10.0.0.9', hostname: null, latency: { attempts: 3, responded: 0, lossPct: 100, min: null, avg: null, max: null, jitter: 0 }, isTimeout: true, geo: null },
  { ttl: 4, ip: '203.0.113.7', hostname: null, latency: { attempts: 3, responded: 2, lossPct: 33.3, min: 40, avg: 55, max: 70, jitter: 30 }, geo: null },
  { ttl: 5, ip: '202.97.58.90', hostname: null, latency: { attempts: 3, responded: 3, lossPct: 0, min: 44, avg: 46, max: 48, jitter: 4 }, geo: { lat: 31.22, lon: 121.46, city: '上海', country: '中国', provider: 'offline-db', status: 'public', precision: 'city' } },
  { ttl: 6, ip: '62.115.120.1', hostname: null, latency: { attempts: 3, responded: 3, lossPct: 0, min: 180, avg: 185, max: 190, jitter: 10 }, geo: { lat: 50.11, lon: 8.68, city: '法兰克福', country: '德国', provider: 'ipwho.is', status: 'public', precision: 'city' } },
  { ttl: 7, ip: '80.81.192.5', hostname: null, latency: { attempts: 3, responded: 3, lossPct: 0, min: 190, avg: 195, max: 200, jitter: 10 }, geo: { lat: 50.11, lon: 8.68, city: '法兰克福', country: '德国', provider: 'ipwho.is', status: 'public', precision: 'city' } },
  { ttl: 8, ip: '142.250.60.155', hostname: null, latency: { attempts: 3, responded: 3, lossPct: 0, min: 240, avg: 245, max: 250, jitter: 10 }, geo: { lat: 37.42, lon: -122.08, city: '山景城', country: '美国', provider: 'ipwho.is', status: 'public', precision: 'city' } },
];

const CASES = [
  { name: 'GPS 缺失（中间 2 跳无定位）', hops: SYNTHETIC_HOPS, local: { lat: 31.22, lon: 121.46, city: '上海', country: '中国' } },
  { name: '全部跳点均无定位', hops: SYNTHETIC_HOPS.map((h) => ({ ...h, geo: null })), local: null },
  { name: '仅有本机（无跳点）', hops: [], local: { lat: 31.22, lon: 121.46, city: '上海', country: '中国' } },
  {
    name: '跨洲 + 极端纬度',
    hops: [
      { ttl: 1, ip: '10.0.0.1', latency: { attempts: 1, responded: 1, lossPct: 0, avg: 1 }, geo: { lat: 78.22, lon: 15.63, city: '朗伊尔城', country: '挪威', provider: 'x', status: 'public' } },
      { ttl: 2, ip: '10.0.0.2', latency: { attempts: 1, responded: 1, lossPct: 0, avg: 200 }, geo: { lat: -54.8, lon: -68.3, city: '乌斯怀亚', country: '阿根廷', provider: 'x', status: 'public' } },
      { ttl: 3, ip: '10.0.0.3', latency: { attempts: 1, responded: 1, lossPct: 0, avg: 300 }, geo: { lat: 64.15, lon: -21.94, city: '雷克雅未克', country: '冰岛', provider: 'x', status: 'public' } },
    ],
    local: { lat: 0, lon: 0, city: '几内亚湾', country: '大西洋' },
  },
];

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('SKIP 未找到 Chrome/Edge');
    process.exit(0);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netscope-render-'));
  const child = spawn(browser, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,900', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const failures = [];
  const consoleErrors = [];
  let ws = null;

  const cleanup = () => {
    try { if (ws) ws.close(); } catch (_) { /* ignore */ }
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
  };

  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i += 1) {
      try { await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 2000); ready = true; }
      catch (e) { await new Promise((r) => setTimeout(r, 300)); }
    }
    if (!ready) throw new Error('DevTools 未就绪');

    const list = await getJSON(`http://127.0.0.1:${DEBUG_PORT}/json/list`, 10000);
    const target = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
    if (!target) throw new Error('未找到页面目标');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        consoleErrors.push('未捕获异常：' + (d.exception?.description || d.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push('console.error：' + m.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    });
    await new Promise((r) => ws.addEventListener('open', r));
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 60000);
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面脚本异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '/' });

    // 等待应用与地图数据就绪
    for (let i = 0; i < 60; i += 1) {
      const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)").catch(() => false);
      if (ok) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    // 注入"像素抽样 + 连线规则"审计工具
    await evaluate(`window.__audit = function () {
      const r = window.NetScopeApp.renderer();
      const canvas = document.getElementById('map-canvas');
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      const img = ctx.getImageData(0, 0, W, H).data;
      let land = 0, anyInk = 0;
      // 采样步长 2（每 4 像素取 1 个），保证结果稳定且不会因为采样过稀而漏判
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 4;
          const rr = img[i], gg = img[i + 1], bb = img[i + 2];
          if (rr + gg + bb > 40) anyInk++;
          if (Math.abs(rr - 22) < 14 && Math.abs(gg - 39) < 14 && Math.abs(bb - 63) < 16) land++;
        }
      }
      const badArcs = r.arcs.filter(function (a) {
        return typeof a.from.lat !== 'number' || typeof a.to.lat !== 'number';
      });
      return {
        land: land, ink: anyInk, scale: r.view.scale,
        offsetX: r.view.offsetX, offsetY: r.view.offsetY,
        nodes: r.nodes.length, arcs: r.arcs.length, mode: r.mode,
        unlocated: (r.unlocated || []).length,
        badArcs: badArcs.length,
        statUnlocated: document.getElementById('stat-unlocated').textContent,
        statLocated: document.getElementById('stat-located').textContent,
      };
    };`);
    // 注入"渲染指定数据"的工具
    await evaluate(`window.__render = function (hops, local) {
      const app = window.NetScopeApp;
      app.state.hops = hops;
      app.state.local = local ? { hostname: 'TEST-PC', interfaces: [{ family: 'IPv4', address: '192.168.1.100', name: 'eth0' }], location: local } : null;
      app.state.target = { host: 'test.target', primaryIP: hops.length ? hops[hops.length - 1].ip : null };
      const r = app.renderer();
      r.setTrace(hops, { local: app.state.local, target: app.state.target });
      r.fitToNodes();
    };`);

    console.log('\n================ 地图渲染对抗性审计 ================\n');

    for (const testCase of CASES) {
      const before = consoleErrors.length;
      await evaluate(`window.__render(${JSON.stringify(testCase.hops)}, ${JSON.stringify(testCase.local)})`);
      await new Promise((r) => setTimeout(r, 500));
      const audit = await evaluate('JSON.stringify(window.__audit())');
      const a = JSON.parse(audit);

      const locatedHops = testCase.hops.filter((h) => h.geo && typeof h.geo.lat === 'number').length;
      const expectUnlocated = testCase.hops.length - locatedHops;
      // 有定位的跳点可能因坐标相同而合并；起点若与首跳同址也会合并
      const distinctKeys = new Set(testCase.hops.filter((h) => h.geo && typeof h.geo.lat === 'number').map((h) => h.geo.lat.toFixed(2) + ',' + h.geo.lon.toFixed(2)));
      const hasStart = testCase.local && typeof testCase.local.lat === 'number';
      const startKey = hasStart ? testCase.local.lat.toFixed(2) + ',' + testCase.local.lon.toFixed(2) : null;
      const expectNodes = distinctKeys.size + (hasStart && !distinctKeys.has(startKey) ? 1 : 0);

      console.log(`【${testCase.name}】`);
      console.log(`   跳点 ${testCase.hops.length} · 已定位 ${locatedHops} · 未定位 ${a.unlocated} · 地图节点 ${a.nodes}（期望 ${expectNodes}）· 连线 ${a.arcs} 条`);
      console.log(`   跨越未定位节点的连线 ${a.badArcs} 条 · 统计栏 已定位=${a.statLocated} 未定位=${a.statUnlocated}`);

      if (a.badArcs > 0) failures.push(`${testCase.name}：有 ${a.badArcs} 条连线跨越了未定位节点`);
      if (a.unlocated !== expectUnlocated) failures.push(`${testCase.name}：未定位跳点数应为 ${expectUnlocated}，实际 ${a.unlocated}`);
      if (a.nodes !== expectNodes) failures.push(`${testCase.name}：地图节点数应为 ${expectNodes}，实际 ${a.nodes}`);
      if (a.arcs !== Math.max(0, expectNodes - 1)) failures.push(`${testCase.name}：连线数应为 ${Math.max(0, expectNodes - 1)}，实际 ${a.arcs}`);
      if (hasStart && a.land < 20) failures.push(`${testCase.name}：地图陆地几乎不可见（land=${a.land}）`);
      if (consoleErrors.length > before) failures.push(`${testCase.name}：渲染过程中出现脚本错误`);
      console.log('');
    }

    // ---- 平移越界测试：把地图强行拖出视野，检查是否还能恢复可见 ----
    console.log('【视图平移越界】');
    await evaluate(`window.__render(${JSON.stringify(SYNTHETIC_HOPS)}, ${JSON.stringify({ lat: 31.22, lon: 121.46 })});`);
    await new Promise((r) => setTimeout(r, 300));
    // 模拟持续向右下拖动 40 次（每次 200px）
    await evaluate(`(function () {
      const r = window.NetScopeApp.renderer();
      for (let i = 0; i < 40; i++) r.panBy(200, 200);
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const panned = JSON.parse(await evaluate('JSON.stringify(window.__audit())'));
    console.log(`   拖动 40×200px 后：offset=(${Math.round(panned.offsetX)}, ${Math.round(panned.offsetY)}) · 陆地抽样 ${panned.land} · 着墨 ${panned.ink}`);
    if (panned.land < 20) {
      failures.push(`平移越界：地图被拖出视野后完全不可见（land=${panned.land}），用户无法自行恢复`);
    }

    // ---- 缩放越界测试：以画布中心为锚点反复缩放，检查地图是否仍可见 ----
    await evaluate(`(function () {
      const r = window.NetScopeApp.renderer();
      r.fitToNodes();
      for (let i = 0; i < 30; i++) r.zoomAt(r.width / 2, r.height / 2, 0.8);
      for (let i = 0; i < 30; i++) r.zoomAt(r.width / 2, r.height / 2, 1.25);
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const zoomed = JSON.parse(await evaluate('JSON.stringify(window.__audit())'));
    console.log(`   极限缩放后：scale=${zoomed.scale.toFixed(3)} · offset=(${Math.round(zoomed.offsetX)}, ${Math.round(zoomed.offsetY)}) · 陆地抽样 ${zoomed.land} · 着墨 ${zoomed.ink}`);
    if (zoomed.land < 20 && zoomed.ink < 500) failures.push(`缩放越界：缩放后地图不可见（land=${zoomed.land}）`);
    if (zoomed.scale > 12.001) failures.push(`缩放上限未生效（scale=${zoomed.scale}）`);

    // ---- 缩放后仍能把视图复位（用户可自行恢复） ----
    await evaluate("document.getElementById('btn-reset-view').click()");
    await new Promise((r) => setTimeout(r, 300));
    const afterReset = JSON.parse(await evaluate('JSON.stringify(window.__audit())'));
    console.log(`   点击复位后：scale=${afterReset.scale.toFixed(2)} · 陆地抽样 ${afterReset.land}`);
    if (afterReset.land < 20) failures.push(`视图复位无效（land=${afterReset.land}）`);

    // ---- 视图切换后再切回，检查是否残留旧坐标 ----
    await evaluate(`window.__render(${JSON.stringify(SYNTHETIC_HOPS)}, ${JSON.stringify({ lat: 31.22, lon: 121.46 })});`);
    await evaluate("document.querySelector('[data-view=\"graph\"]').click()");
    await new Promise((r) => setTimeout(r, 400));
    const graph = JSON.parse(await evaluate('JSON.stringify(window.__audit())'));
    await evaluate("document.querySelector('[data-view=\"map\"]').click()");
    await new Promise((r) => setTimeout(r, 400));
    const backToMap = JSON.parse(await evaluate('JSON.stringify(window.__audit())'));
    console.log(`\n【视图切换】逻辑拓扑 land=${graph.land} → 切回世界地图 land=${backToMap.land} · scale=${backToMap.scale.toFixed(2)}`);
    if (backToMap.land < 20) failures.push(`视图切换：切回世界地图后地图不可见（land=${backToMap.land}）`);

    // ---- 缩放到很小的窗口，检查布局是否崩坏 ----
    await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 620, deviceScaleFactor: 1, mobile: false });
    await new Promise((r) => setTimeout(r, 600));
    await evaluate('window.NetScopeApp.renderer().resize(); window.NetScopeApp.renderer().fitToNodes();');
    await new Promise((r) => setTimeout(r, 400));
    const narrow = JSON.parse(await evaluate(`JSON.stringify(Object.assign(window.__audit(), {
      sidebarVisible: getComputedStyle(document.getElementById('sidebar')).display !== 'none',
      canvasWidth: document.getElementById('map-canvas').clientWidth,
      canvasHeight: document.getElementById('map-canvas').clientHeight,
    }))`));
    console.log(`【窄窗口 760×620】侧栏默认可见=${narrow.sidebarVisible} · 画布 ${narrow.canvasWidth}×${narrow.canvasHeight} · 陆地抽样 ${narrow.land}`);
    if (narrow.land < 15) failures.push(`窄窗口：地图不可见（land=${narrow.land}）`);

    // 通过 ☰ 按钮展开侧栏，验证仍然可操作
    const canOpen = await evaluate(`(function () {
      const btn = document.getElementById('btn-sidebar');
      if (!btn) return 'no-button';
      btn.click();
      const sidebar = document.getElementById('sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      return JSON.stringify({
        visible: getComputedStyle(sidebar).display !== 'none',
        backdropShown: backdrop ? backdrop.classList.contains('is-visible') : null,
      });
    })()`);
    const opened = JSON.parse(canOpen);
    console.log(`   点击 ☰ 后：控制面板可见=${opened.visible} · 遮罩显示=${opened.backdropShown}`);
    if (!opened.visible) failures.push('窄窗口：点击 ☰ 后控制面板仍未显示（用户无法操作）');
    await evaluate("document.getElementById('btn-sidebar').click()");

    // ---- 统计栏布局：超长目标地址不得遮挡"跳数"等其它项 ----
    console.log('\n【统计栏布局（超长目标地址）】');
    await evaluate(`(function () {
      const app = window.NetScopeApp;
      const longHost = 'a.really.extremely.long.hostname.that.keeps.going.example.org';
      const longIP = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
      const hops = [
        { ttl: 1, ip: '192.168.1.1', latency: { attempts: 3, responded: 3, lossPct: 0, avg: 1 }, geo: { lat: 31.2, lon: 121.4, city: '上海', country: '中国', status: 'private' } },
        { ttl: 2, ip: longIP, latency: { attempts: 3, responded: 3, lossPct: 0, avg: 30 }, geo: { lat: 35.6, lon: 139.7, city: '东京', country: '日本', status: 'public' } },
      ];
      app.state.hops = hops;
      app.state.input = longHost;
      app.state.target = { host: longHost, primaryIP: longIP };
      app.state.local = { hostname: 'TEST-PC', interfaces: [{ family: 'IPv4', address: '192.168.1.100', name: 'eth0' }], location: { lat: 31.2, lon: 121.4, city: '上海', country: '中国' } };
      const r = app.renderer();
      r.setTrace(hops, { local: app.state.local, target: app.state.target });
      r.fitToNodes();
      document.getElementById('map-stats').hidden = false;
      app.refreshStats();
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    const layout = JSON.parse(await evaluate(`JSON.stringify((function () {
      const stats = document.getElementById('map-stats');
      const canvasWrap = document.getElementById('canvas-wrap');
      const rects = {};
      stats.querySelectorAll('.stat').forEach(function (s) {
        const label = s.querySelector('.stat-label').textContent;
        const b = s.querySelector('.stat-value');
        const rb = b.getBoundingClientRect();
        const rs = s.getBoundingClientRect();
        rects[label] = { x: rs.left, y: rs.top, w: rs.width, h: rs.height, textW: b.scrollWidth, boxW: rb.width, overflow: b.scrollWidth > Math.ceil(rb.width) + 1 };
      });
      const keys = Object.keys(rects);
      const overlaps = [];
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
          const a = rects[keys[i]], b2 = rects[keys[j]];
          if (!(a.x + a.w <= b2.x || b2.x + b2.w <= a.x || a.y + a.h <= b2.y || b2.y + b2.h <= a.y)) overlaps.push(keys[i] + ' × ' + keys[j]);
        }
      }
      // 与画布左右对齐检查：统计栏左右内边距应一致，且整条贴合画布宽度
      const statsRect = stats.getBoundingClientRect();
      const wrapRect = canvasWrap.getBoundingClientRect();
      const leftGap = Math.round(statsRect.left - wrapRect.left);
      const rightGap = Math.round(wrapRect.right - statsRect.right);
      // KPI 行是否铺满整行（最后一个 KPI 的右边缘接近统计栏内边界）
      const kpiLabels = keys.filter(function (k) { return k !== '目标'; });
      const kpiRight = Math.max.apply(null, kpiLabels.map(function (k) { return rects[k].x + rects[k].w; }));
      const kpiRowFill = Math.round(((kpiRight - statsRect.left) / statsRect.width) * 100);
      return {
        overlaps: overlaps,
        targetOverflow: rects['目标'] ? rects['目标'].overflow : null,
        targetTextW: rects['目标'] ? rects['目标'].textW : 0,
        targetBoxW: rects['目标'] ? Math.round(rects['目标'].boxW) : 0,
        leftGap: leftGap, rightGap: rightGap, kpiRowFill: kpiRowFill,
        statsWidth: Math.round(statsRect.width), wrapWidth: Math.round(wrapRect.width),
      };
    })())`));
    console.log(`   超长地址文本宽 ${layout.targetTextW} / 容器宽 ${layout.targetBoxW} · 溢出=${layout.targetOverflow} · 项目重叠=${layout.overlaps.length ? layout.overlaps.join('、') : '无'}`);
    console.log(`   左右对齐：距画布左 ${layout.leftGap}px / 右 ${layout.rightGap}px（统计栏宽 ${layout.statsWidth}，画布宽 ${layout.wrapWidth}）· KPI 行铺满度 ${layout.kpiRowFill}%`);
    if (layout.overlaps.length) failures.push(`统计栏布局：项目重叠（${layout.overlaps.join('、')}）`);
    // 目标行独占整行，长地址可以完整显示；关键是"不得溢出容器"，而不是必须截断
    if (layout.targetOverflow) failures.push('统计栏布局：目标地址溢出容器，可能遮挡相邻项');
    if (Math.abs(layout.leftGap - layout.rightGap) > 1) failures.push(`统计栏未与画布左右对齐（左 ${layout.leftGap}px / 右 ${layout.rightGap}px）`);
    if (layout.kpiRowFill < 95) failures.push(`统计栏 KPI 行未铺满整行（铺满度 ${layout.kpiRowFill}%）`);

    if (consoleErrors.length) {
      console.log('\n页面脚本错误：');
      consoleErrors.slice(0, 10).forEach((e) => console.log('  - ' + e));
      failures.push(`${consoleErrors.length} 个页面脚本错误`);
    } else {
      console.log('\n✔ 全部用例均无脚本错误');
    }
  } catch (error) {
    failures.push('执行异常：' + error.message);
    console.error(error.stack);
  } finally {
    cleanup();
  }

  console.log('\n================ 审计结论 ================');
  if (failures.length) {
    console.log(`发现 ${failures.length} 个问题：`);
    failures.forEach((f) => console.log('  ✘ ' + f));
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
}

main();
