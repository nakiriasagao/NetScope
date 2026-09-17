'use strict';

/**
 * 浏览器端到端验证（无第三方依赖）
 *
 * 原理：
 *   1. 以 --headless=new --remote-debugging-port 启动本机已安装的 Chrome / Edge
 *   2. 通过 HTTP 拿到 DevTools 目标列表，用原生 WebSocket 连接
 *   3. Runtime.evaluate 注入脚本、轮询页面状态；Page.captureScreenshot 抓图
 *   4. 全程收集 console 报错与未捕获异常，任一即失败
 *
 * 用法：node test/browser-e2e.js [http://127.0.0.1:8787] [截图输出目录]
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT_DIR = process.argv[3] || path.join(__dirname, '..', 'data', 'screenshots');
const DEBUG_PORT = 9333 + Math.floor(Math.random() * 300);

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* ignore */
    }
  }
  return null;
}

function httpGetJSON(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(new Error(`响应不是 JSON：${text.slice(0, 120)}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

/**
 * 选择一个可用的页面目标
 * 注意：新版 Chrome 的 /json/new 只接受 PUT，用 GET 会返回错误文本；
 * 因此这里优先从 /json/list 里挑选 type === 'page' 的目标。
 */
async function pickPageTarget() {
  const list = await httpGetJSON(`http://127.0.0.1:${DEBUG_PORT}/json/list`, 10000);
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  // 刚启动时可能有多个 page 目标（含浏览器内部页面），优先选 about:blank / 非 chrome:// 的页面
  const usable = pages.filter((t) => !/^chrome(-|:)/.test(t.url || ''));
  if (usable.length) return usable[usable.length - 1];
  if (pages.length) return pages[pages.length - 1];
  // 兜底：尝试用 PUT 新建标签页
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: DEBUG_PORT, path: '/json/new?about:blank', method: 'PUT', timeout: 8000 },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(new Error('无法创建浏览器标签页：' + text.slice(0, 120)));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('创建标签页超时'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForDevTools(timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await httpGetJSON(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 3000);
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  throw new Error(`DevTools 端口未就绪：${lastError && lastError.message}`);
}

/** 极简 CDP 客户端（原生 WebSocket） */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (event) => reject(new Error(`WebSocket 连接失败：${event.message || 'unknown'}`)));
      ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        if (message.id && this.pending.has(message.id)) {
          const { resolve: res, reject: rej } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) rej(new Error(message.error.message));
          else res(message.result);
          return;
        }
        this.listeners.forEach((fn) => fn(message));
      });
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 120000);
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(`页面脚本异常：${text || result.exceptionDetails.text}`);
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('SKIP  未找到 Chrome / Edge，跳过浏览器端到端测试');
    process.exit(0);
  }
  console.log(`使用浏览器：${browser}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netscope-e2e-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--hide-scrollbars',
    'about:blank',
  ];

  const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
  const failures = [];
  const consoleErrors = [];
  let cdp = null;

  const cleanup = () => {
    try {
      if (cdp) cdp.close();
    } catch (_) {
      /* ignore */
    }
    try {
      child.kill('SIGKILL');
    } catch (_) {
      /* ignore */
    }
  };

  try {
    await waitForDevTools();
    console.log('DevTools 已就绪');

    const target = await pickPageTarget();
    if (!target || !target.webSocketDebuggerUrl) throw new Error('未找到可用的浏览器页面目标');

    cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable').catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

    cdp.on((message) => {
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        consoleErrors.push('未捕获异常：' + (details.exception?.description || details.text));
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push('console.error：' + message.params.args.map((a) => a.value || a.description || '').join(' '));
      }
    });

    const url = `${BASE}/?autorun=1&target=${encodeURIComponent(process.env.NS_TARGET || '223.5.5.5')}&maxHops=24&resolveNames=0&deep=1`;
    console.log('打开页面：' + url);
    const nav = await cdp.send('Page.navigate', { url });
    if (nav.errorText) {
      console.log('导航警告：' + nav.errorText + '（继续等待页面加载）');
    }

    // 确认确实导航到了目标页面
    const originDeadline = Date.now() + 15000;
    let landed = false;
    while (Date.now() < originDeadline) {
      const href = await cdp.evaluate('location.href').catch(() => null);
      if (href && href.indexOf(BASE) === 0) {
        landed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!landed) failures.push('页面导航未到达目标地址');
    else console.log('✔ 页面已加载：' + BASE);

    // 等待应用初始化完成
    const readyDeadline = Date.now() + 25000;
    let ready = false;
    let lastDiag = null;
    while (Date.now() < readyDeadline) {
      const diag = await cdp
        .evaluate(`JSON.stringify({
          app: typeof window.NetScopeApp,
          renderer: window.NetScopeApp && typeof window.NetScopeApp.renderer === 'function' ? typeof window.NetScopeApp.renderer() : 'n/a',
          world: Boolean(window.NetScopeApp && window.NetScopeApp.renderer && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world),
          toasts: Array.from(document.querySelectorAll('.toast')).map(function (t) { return t.textContent.slice(0, 120); }),
          serverStatus: document.getElementById('server-status') ? document.getElementById('server-status').textContent : null,
        })`)
        .catch((error) => JSON.stringify({ evalError: error.message }));
      lastDiag = diag;
      try {
        const parsed = JSON.parse(diag);
        if (parsed.world) {
          ready = true;
          break;
        }
      } catch (_) {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) {
      failures.push('页面初始化失败：世界地图数据未加载（renderer().world 为空）');
      console.log('诊断信息：' + lastDiag);
    } else {
      console.log('✔ 页面初始化完成，世界地图已加载');
    }

    // 等待探测完成（跳点表格出现数据且不再增长）
    const traceDeadline = Date.now() + 180000;
    let hops = 0;
    let stableRounds = 0;
    while (Date.now() < traceDeadline) {
      const info = await cdp
        .evaluate(
          'JSON.stringify({hops: (window.NetScopeApp.state.hops||[]).length, busy: window.NetScopeApp.state.busy, nodes: window.NetScopeApp.renderer().nodes.length, engine: window.NetScopeApp.state.engine})',
        )
        .catch(() => null);
      if (info) {
        const parsed = JSON.parse(info);
        if (parsed.hops > 0 && parsed.hops === hops && !parsed.busy) stableRounds += 1;
        else stableRounds = 0;
        hops = parsed.hops;
        if (stableRounds >= 3) {
          console.log(`✔ 探测完成：${parsed.hops} 跳，引擎 ${parsed.engine}，地图节点 ${parsed.nodes} 个`);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (hops === 0) failures.push('探测未返回任何跳点（180 秒超时）');

    // 校验渲染结果
    const audit = await cdp.evaluate(`(() => {
      const app = window.NetScopeApp;
      const r = app.renderer();
      const canvas = document.getElementById('map-canvas');
      const ctx = canvas.getContext('2d');
      // 采样画布中心区域，确认确实绘制了内容（非纯黑）
      const w = canvas.width, h = canvas.height;
      const data = ctx.getImageData(Math.floor(w*0.2), Math.floor(h*0.2), Math.floor(w*0.6), Math.floor(h*0.6)).data;
      let nonBlack = 0, landPixels = 0;
      for (let i = 0; i < data.length; i += 4 * 37) {
        const r0 = data[i], g0 = data[i+1], b0 = data[i+2];
        if (r0 + g0 + b0 > 40) nonBlack++;
        if (r0 > 12 && r0 < 60 && g0 > 25 && g0 < 80 && b0 > 45 && b0 < 110) landPixels++;
      }
      return JSON.stringify({
        canvasSize: [w, h],
        nodes: r.nodes.length,
        arcs: r.arcs.length,
        countries: r.world ? r.world.countries.length : 0,
        countriesDrawn: r.world ? r.world.countries.length : 0,
        nonBlackSamples: nonBlack,
        landSamples: landPixels,
        hopsRows: document.querySelectorAll('#hops-table tbody tr[data-index]').length,
        svgLabels: document.querySelectorAll('#node-overlay g').length,
        statsHops: document.getElementById('stat-hops').textContent,
        statsRtt: document.getElementById('stat-rtt').textContent,
        statsCountries: document.getElementById('stat-countries').textContent,
        tabActive: document.querySelector('.tab.is-active').getAttribute('data-tab'),
        target: app.state.target && (app.state.target.primaryIP || app.state.target.host),
        avgRtt: app.state.summary && app.state.summary.avgRtt,
        reached: app.state.summary && app.state.summary.reachedTarget,
        portScanOpen: app.state.portScan ? app.state.portScan.open.length : null,
        dnsAddresses: app.state.dns && app.state.dns.summary ? app.state.dns.summary.addresses.length : null,
        connRendered: document.getElementById('conn-content').innerHTML.length,
        localRendered: document.getElementById('local-content').innerHTML.length,
      });
    })()`);
    const a = JSON.parse(audit);
    console.log('渲染审计：', JSON.stringify(a, null, 2));

    const checks = [
      ['世界地图数据加载', a.countries > 100],
      ['Canvas 尺寸有效', a.canvasSize[0] > 800 && a.canvasSize[1] > 400],
      ['画布已绘制内容', a.nonBlackSamples > 200],
      ['绘制了陆地多边形', a.landSamples > 20],
      ['生成了拓扑节点', a.nodes >= 2],
      ['生成了拓扑连线', a.arcs >= 1],
      ['跳点表格有数据', a.hopsRows > 0],
      ['节点标签层已渲染', a.svgLabels > 0],
      ['统计栏已更新', a.statsHops !== '—' && a.statsRtt !== '—'],
      ['连通性面板有内容', a.connRendered > 400],
    ];
    for (const [name, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
      if (!ok) failures.push(name);
    }

    // 交互：切换视图 / 缩放 / 悬停
    await cdp.evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click()");
    await new Promise((r) => setTimeout(r, 600));
    const graphOk = await cdp.evaluate('window.NetScopeApp.renderer().mode === "graph" && window.NetScopeApp.renderer().nodes.every(n => typeof n.lx === "number")');
    console.log(`${graphOk ? 'PASS' : 'FAIL'}  逻辑拓扑视图切换`);
    if (!graphOk) failures.push('逻辑拓扑视图切换');

    await cdp.evaluate("document.querySelector('[data-view=\\\"map\\\"]').click()");
    await new Promise((r) => setTimeout(r, 400));

    await cdp.evaluate(`(() => {
      const canvas = document.getElementById('map-canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new WheelEvent('wheel', {deltaY: -240, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, bubbles: true, cancelable: true}));
    })()`);
    const zoomed = await cdp.evaluate('window.NetScopeApp.renderer().view.scale');
    console.log(`PASS  滚轮缩放（scale=${zoomed.toFixed(2)}）`);

    // 悬停命中测试：把鼠标移到第一个节点上
    const hoverOk = await cdp.evaluate(`(() => {
      const app = window.NetScopeApp; const r = app.renderer();
      const node = r.nodes.find(n => typeof n.x === 'number');
      if (!node) return 'no-node';
      const pos = r.nodeScreen(node);
      const rect = document.getElementById('map-canvas').getBoundingClientRect();
      const found = r.hitTest(pos.x, pos.y);
      return found ? found.label : 'miss';
    })()`);
    console.log(`${hoverOk !== 'miss' && hoverOk !== 'no-node' ? 'PASS' : 'FAIL'}  节点命中测试（${hoverOk}）`);
    if (hoverOk === 'miss' || hoverOk === 'no-node') failures.push('节点命中测试');

    // 导出功能（仅验证不抛错）
    const exportOk = await cdp.evaluate(`(() => {
      try {
        const app = window.NetScopeApp;
        window.NetScopeExport.toJSON(app.state);
        return 'ok';
      } catch (e) { return 'error: ' + e.message; }
    })()`);
    console.log(`${exportOk === 'ok' ? 'PASS' : 'FAIL'}  JSON 导出（${exportOk}）`);
    if (exportOk !== 'ok') failures.push('JSON 导出');

    // 截图
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const shots = [
      { name: 'map-full.png', script: null },
      {
        name: 'map-zoom.png',
        script: `(() => { const r = window.NetScopeApp.renderer(); r.fitToNodes(); r.zoomAt(r.width/2, r.height/2, 1.9); })()`,
      },
      {
        name: 'graph-view.png',
        script: `(() => { document.querySelector('[data-view="graph"]').click(); })()`,
      },
      {
        name: 'local-network.png',
        script: `(() => { document.getElementById('btn-local').click(); })()`,
      },
    ];
    for (const shot of shots) {
      if (shot.script) {
        await cdp.evaluate(shot.script);
        await new Promise((r) => setTimeout(r, shot.name === 'local-network.png' ? 9000 : 1200));
      }
      const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT_DIR, shot.name), Buffer.from(image.data, 'base64'));
      console.log(`截图已保存：${path.join(OUT_DIR, shot.name)}`);
    }

    if (consoleErrors.length) {
      console.log('\n页面控制台错误：');
      consoleErrors.slice(0, 20).forEach((e) => console.log('  - ' + e));
      failures.push(`${consoleErrors.length} 个页面脚本错误`);
    } else {
      console.log('\n✔ 页面无 console 错误与未捕获异常');
    }
  } catch (error) {
    failures.push('执行异常：' + error.message);
    console.error('E2E 执行失败：', error.stack);
  } finally {
    cleanup();
  }

  console.log('\n================ E2E 汇总 ================');
  if (failures.length) {
    console.log(`FAIL（${failures.length} 项）`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
}

main();
