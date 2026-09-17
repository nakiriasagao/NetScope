/* NetScope 主应用
 * 负责：界面事件绑定、调用 API、消费 SSE 流、渲染表格与面板、导出。
 */
(function () {
  'use strict';

  var cfg = window.NetScopeConfig;
  var api = window.NetScopeAPI;
  var D = window.NetScopeDraw;
  var Exporter = window.NetScopeExport;
  var Amap = window.NetScopeAmap;

  /* ------------------------------ 全局状态 ------------------------------ */

  var state = {
    input: null,
    target: null,
    trace: null,
    hops: [],
    geo: {},
    summary: null,
    probe: null,
    dns: null,
    security: null,
    portScan: null,
    local: null,
    lan: null,
    engine: null,
    fallbackNotes: [],
    selectedNode: null,
    stream: null,
    busy: false,
    view: 'map',
    baseMap: 'builtin',
    /** 因局域网扫描而临时切到内置地图时，记住用户原本选择的底图，下次探测时恢复 */
    pendingBaseMap: null,
  };

  var renderer = null;
  var amapView = null;
  var el = {};

  /** 当前生效的渲染目标：高德视图或内置渲染器 */
  function activeView() {
    return amapView || renderer;
  }

  /** 在两种底图上执行同一个绘制动作 */
  function withView(fn) {
    if (!fn) return;
    if (amapView) fn(amapView, true);
    else fn(renderer, false);
  }

  /* ------------------------------ 工具函数 ------------------------------ */

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function fmtMs(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    return (Math.round(value * 10) / 10).toFixed(1) + ' ms';
  }

  function fmtPct(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    return (Math.round(value * 10) / 10).toFixed(1) + '%';
  }

  function latencyClass(value) {
    if (typeof value !== 'number') return '';
    if (value <= cfg.latencyThresholds.good) return 'lat-good';
    if (value <= cfg.latencyThresholds.mid) return 'lat-mid';
    return 'lat-bad';
  }

  function toast(message, kind, timeoutMs) {
    var stack = el.toastStack;
    if (!stack) return;
    var node = document.createElement('div');
    node.className = 'toast' + (kind ? ' is-' + kind : '');
    node.innerHTML = message;
    stack.appendChild(node);
    var life = timeoutMs || (kind === 'error' ? 9000 : 4500);
    setTimeout(function () {
      node.style.transition = 'opacity .3s';
      node.style.opacity = '0';
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 320);
    }, life);
  }

  function setBusy(busy, text) {
    state.busy = busy;
    if (el.btnRun) {
      el.btnRun.disabled = busy;
      var label = el.btnRun.querySelector('.btn-label');
      if (label) label.textContent = busy ? '探测中…' : '开始探测';
    }
    if (el.progressBar) el.progressBar.hidden = !busy;
    if (busy && text && el.progressText) el.progressText.textContent = text;
    if (!busy && el.progressInner) el.progressInner.style.width = '0%';
  }

  function setProgress(percent, text) {
    if (el.progressInner) el.progressInner.style.width = Math.max(0, Math.min(100, percent)) + '%';
    if (text && el.progressText) el.progressText.textContent = text;
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('is-active', tab.getAttribute('data-tab') === name);
    });
    document.querySelectorAll('.tab-panel').forEach(function (panel) {
      panel.classList.toggle('is-active', panel.getAttribute('data-panel') === name);
    });
    // 窄屏下数据面板是浮层：切换标签页时自动展开，否则用户看不到内容
    var inspector = $('inspector');
    if (inspector && window.matchMedia('(max-width: 1200px)').matches) {
      inspector.classList.add('is-open');
    }
  }

  /** 窄屏浮层面板的展开/收起 */
  function toggleSidebar(force) {
    var sidebar = $('sidebar');
    var backdrop = $('sidebar-backdrop');
    if (!sidebar) return;
    var next = typeof force === 'boolean' ? force : !sidebar.classList.contains('is-open');
    sidebar.classList.toggle('is-open', next);
    if (backdrop) backdrop.classList.toggle('is-visible', next);
  }

  function toggleInspector(force) {
    var inspector = $('inspector');
    if (!inspector) return;
    var next = typeof force === 'boolean' ? force : !inspector.classList.contains('is-open');
    inspector.classList.toggle('is-open', next);
  }

  /* ------------------------------ 初始化 -------------------------------- */

  async function init() {
    el = {
      targetForm: $('target-form'),
      targetInput: $('target-input'),
      btnRun: $('btn-run'),
      btnDiagnose: $('btn-diagnose'),
      btnExport: $('btn-export'),
      btnSelfTest: $('btn-selftest'),
      serverStatus: $('server-status'),
      quickTargets: $('quick-targets'),
      canvas: $('map-canvas'),
      canvasWrap: $('canvas-wrap'),
      amapHost: $('amap-host'),
      overlayCanvas: $('overlay-canvas'),
      overlay: $('node-overlay'),
      legendPanel: $('legend-panel'),
      btnLegend: $('btn-legend'),
      legendClose: $('legend-close'),
      mapHint: $('map-hint'),
      mapStats: $('map-stats'),
      statTarget: $('stat-target'),
      statHops: $('stat-hops'),
      statLocated: $('stat-located'),
      statUnlocated: $('stat-unlocated'),
      statRtt: $('stat-rtt'),
      statCountries: $('stat-countries'),
      statDistance: $('stat-distance'),
      hopsTable: $('hops-table'),
      hopsCount: $('hops-count'),
      latencyChart: $('latency-chart'),
      connContent: $('conn-content'),
      portsContent: $('ports-content'),
      portsCount: $('ports-count'),
      localContent: $('local-content'),
      dnsContent: $('dns-content'),
      securityContent: $('security-content'),
      nodeCard: $('node-card'),
      nodeCardBody: $('node-card-body'),
      nodeCardClose: $('node-card-close'),
      toastStack: $('toast-stack'),
      progressBar: $('progress-bar'),
      progressInner: $('progress-inner'),
      progressText: $('progress-text'),
      btnLocal: $('btn-local'),
      btnLanScan: $('btn-lanscan'),
      btnSettings: $('btn-settings'),
      optDeepScan: $('opt-deepscan'),
      optBaseMap: $('opt-basemap'),
      baseMapStatus: $('basemap-status'),
      settingsModal: $('settings-modal'),
      settingsClose: $('settings-close'),
      amapKey: $('amap-key'),
      amapSecurity: $('amap-security'),
      amapEnabled: $('amap-enabled'),
      amapSave: $('amap-save'),
      amapTest: $('amap-test'),
      amapClear: $('amap-clear'),
      amapTestResult: $('amap-test-result'),
      btnEgress: $('btn-egress'),
      btnScan: $('btn-scan'),
      optListenPorts: $('opt-listenports'),
      optScanMode: $('opt-scanmode'),
      fieldScanPorts: $('field-scanports'),
      fieldScanRange: $('field-scanrange'),
      optScanPorts: $('opt-scanports'),
      optScanFrom: $('opt-scanfrom'),
      optScanTo: $('opt-scanto'),
      optMaxHops: $('opt-maxhops'),
      optQueries: $('opt-queries'),
      optTimeout: $('opt-timeout'),
      optResolveNames: $('opt-resolvenames'),
      optEngine: $('opt-engine'),
      optColor: $('opt-color'),
      optShowLabels: $('opt-show-labels'),
      optShowLinks: $('opt-show-links'),
      optShowGrid: $('opt-show-grid'),
      optAnimate: $('opt-animate'),
      optNight: $('opt-night'),
    };

    renderer = new D.Renderer(el.canvas, el.overlay);
    renderer.resize();
    bindEvents();
    setBusy(false);
    syncRangeLabels();
    initBaseMap();

    await loadWorld();
    await checkHealth();
    maybeAutoRun();

    window.addEventListener('resize', function () {
      if (amapView) amapView.resize();
      else {
        renderer.resize();
        renderer.draw();
      }
      if (state.hops.length) D.drawLatencyChart(el.latencyChart, state.hops);
    });
  }

  async function loadWorld() {
    try {
      var res = await fetch('data/world-110m.json', { cache: 'force-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var world = await res.json();
      renderer.setWorld(world);
      renderer.resize();
      renderer.fitToContainer();
    } catch (error) {
      toast('世界地图数据加载失败：' + escapeHtml(error.message) + '<br/>请确认 public/data/world-110m.json 存在（可用 npm run build:map 重新生成）', 'error', 12000);
    }
  }

  async function checkHealth() {
    try {
      var health = await api.health();
      el.serverStatus.textContent = '服务正常 · ' + health.node;
      el.serverStatus.className = 'status-pill is-ok';
      el.serverStatus.title = '接口地址：' + api.base + '\n平台：' + health.platform + '\n可用捕获策略：' + (health.capabilities && health.capabilities.pipeBlocked ? '文件重定向（管道被环境禁止）' : '标准管道');
    } catch (error) {
      el.serverStatus.textContent = '服务未连接';
      el.serverStatus.className = 'status-pill is-bad';
      toast(
        '无法连接后端服务：' + escapeHtml(error.message) + '<br/>请先启动：<code>node src/server.js</code>',
        'error',
        12000,
      );
    }
  }

  /** 同步一个数值区间的显示标签 */
  function syncRangeLabels() {
    var pairs = [
      [el.optMaxHops, $('val-maxhops')],
      [el.optQueries, $('val-queries')],
      [el.optTimeout, $('val-timeout')],
    ];
    pairs.forEach(function (pair) {
      if (!pair[0] || !pair[1]) return;
      pair[1].textContent = pair[0].value;
      pair[0].addEventListener('input', function () {
        pair[1].textContent = pair[0].value;
      });
    });
  }

  /* ------------------------------ 底图管理 ------------------------------ */

  var BASE_MAP_KEY = 'netscope.basemap';

  /** 启动时恢复上次选择的底图 */
  function initBaseMap() {
    var saved = 'builtin';
    try {
      saved = window.localStorage.getItem(BASE_MAP_KEY) || 'builtin';
    } catch (e) {
      /* ignore */
    }
    if (el.optBaseMap) el.optBaseMap.value = saved;
    state.baseMap = saved;
    updateBaseMapStatus();
    if (saved === 'amap') {
      // 页面加载后异步切换，避免阻塞首屏
      setTimeout(function () {
        switchBaseMap('amap');
      }, 300);
    }
  }

  function updateBaseMapStatus(extra) {
    if (!el.baseMapStatus) return;
    if (state.baseMap === 'builtin') {
      el.baseMapStatus.textContent = '内置（全球）';
      el.baseMapStatus.className = 'basemap-status';
      return;
    }
    el.baseMapStatus.textContent = extra || (amapView ? '高德已启用' : '高德未就绪');
    el.baseMapStatus.className = 'basemap-status ' + (amapView ? 'is-ok' : 'is-warn');
  }

  /**
   * 切换底图
   * @param {'builtin'|'amap'} mode
   * @param {{ silent?: boolean }} [options]
   */
  function switchBaseMap(mode, options) {
    var opts = options || {};
    if (mode === state.baseMap && ((mode === 'amap' && amapView) || (mode === 'builtin' && !amapView))) {
      return Promise.resolve();
    }

    if (mode === 'builtin') {
      if (amapView) {
        amapView.destroy();
        amapView = null;
      }
      if (el.amapHost) {
        el.amapHost.hidden = true;
        el.amapHost.innerHTML = '';
      }
      if (el.overlayCanvas) el.overlayCanvas.hidden = true;
      // 双保险：确保渲染器确实回到内置画布（destroy 已做，这里再兜一次）
      if (renderer.canvas !== el.canvas) {
        renderer.canvas = el.canvas;
        renderer.overlay = el.overlay;
      }
      renderer.plain = false;
      renderer.reproject = null;
      el.canvas.hidden = false;
      el.overlay.hidden = false;
      state.baseMap = 'builtin';
      try {
        window.localStorage.setItem(BASE_MAP_KEY, 'builtin');
      } catch (e) {
        /* ignore */
      }
      // 画布此前被隐藏过，重新显示后必须按当前布局重新量尺寸，
      // 否则渲染尺寸仍是旧值（或在极端情况下取不到父元素）
      renderer.resize();
      if (state.lan && renderer.lanMode && state.lan.topology) {
        renderer.setLanTopology(state.lan.topology);
      } else if (state.hops.length) {
        // 尊重当前视图：逻辑拓扑视图下切换底图仍应保持逻辑拓扑，
        // 否则会出现"画面变成世界地图、但按钮还显示逻辑拓扑"的不一致
        if (state.view === 'graph') renderer.setMode('graph');
        drawCurrentTrace();
        if (renderer.options.animate) renderer.startAnimation();
      } else {
        renderer.setMode(state.view === 'graph' ? 'graph' : 'map');
        renderer.fitToContainer();
      }
      updateBaseMapStatus();
      return Promise.resolve();
    }

    // 切到高德
    var credentials = Amap ? Amap.credentials() : { key: '' };
    if (!credentials.key) {
      updateBaseMapStatus('未配置 Key');
      if (el.optBaseMap) el.optBaseMap.value = 'builtin';
      if (!opts.silent) {
        toast('尚未配置高德 Key：点击左侧「⚙ 地图设置」填写后即可启用高德底图', 'warn', 9000);
        openSettings();
      }
      return Promise.resolve();
    }

    return api
      .amapConfig()
      .catch(function () {
        return null;
      })
      .then(function () {
        return Amap.loadAmap({ plugins: [] });
      })
      .then(function () {
        if (amapView) return amapView;
        el.canvas.hidden = true;
        el.overlay.hidden = false;
        if (el.amapHost) {
          el.amapHost.hidden = false;
          el.amapHost.innerHTML = '';
        }
        // 注意：必须用独立的高德容器。高德的 destroy() 会清空容器内容，
        // 若直接挂在 canvas-wrap 上，切回内置地图时会把画布/标签层/统计栏一起删掉。
        var host = el.amapHost || el.canvasWrap;
        // 高德只负责底图；节点、连线、标签、动画全部交给内置引擎绘制到叠加层，
        // 这样两套底图的拓扑样式完全一致（共用同一份绘制代码）。
        var view = Amap.createOverlayView({
          host: host,
          overlayCanvas: el.overlayCanvas,
          labelLayer: el.overlay,
          renderer: renderer,
          callbacks: {
            onReady: function () {
              updateBaseMapStatus('高德已启用');
            },
          },
        });
        return view.init({ zoom: 3, center: [110, 32], mapStyle: 'amap://styles/darkblue' }).then(function () {
          amapView = view;
          state.baseMap = 'amap';
          try {
            window.localStorage.setItem(BASE_MAP_KEY, 'amap');
          } catch (e) {
            /* ignore */
          }
          updateBaseMapStatus('高德已启用');
          // 把当前数据重绘到高德底图上。
          // 注意：若当前是「逻辑拓扑」视图，必须立刻挂起高德——
          // 否则画面会变成世界地图，而上方按钮仍显示逻辑拓扑（状态不一致）。
          if (state.view === 'graph' && !renderer.lanMode) {
            view.suspend();
            renderer.setMode('graph');
            drawCurrentTrace();
            if (renderer.options.animate) renderer.startAnimation();
          } else if (state.lan && state.lan.topology) {
            view.setLanTopology(state.lan.topology);
          } else if (state.hops.length) {
            view.setTrace(state.hops, { local: state.local, target: state.target });
          }
          if (!opts.silent) toast('已切换到高德地图底图', 'ok');
          return view;
        });
      })
      .catch(function (error) {
        // 回退到内置地图，并说明原因
        if (amapView) {
          amapView.destroy();
          amapView = null;
        }
        el.canvas.hidden = false;
        el.overlay.hidden = false;
        state.baseMap = 'builtin';
        if (el.optBaseMap) el.optBaseMap.value = 'builtin';
        try {
          window.localStorage.setItem(BASE_MAP_KEY, 'builtin');
        } catch (e) {
          /* ignore */
        }
        renderer.resize();
        // 回退时同样尊重当前视图（逻辑拓扑视图下不要切成世界地图）
        if (state.view === 'graph' && !renderer.lanMode) renderer.setMode('graph');
        if (state.hops.length) drawCurrentTrace();
        if (renderer.options.animate) renderer.startAnimation();
        updateBaseMapStatus('加载失败，已回退');
        if (!opts.silent) {
          toast('高德地图加载失败：' + escapeHtml(error.message) + '<br/>已回退到内置世界地图', 'error', 12000);
        }
      });
  }

  /* ------------------------------ 设置面板 ------------------------------ */

  function openSettings() {
    if (!el.settingsModal) return;
    var cred = Amap ? Amap.loadLocalCredentials() : { key: '', security: '', enabled: true };
    if (el.amapKey) el.amapKey.value = cred.key || '';
    if (el.amapSecurity) el.amapSecurity.value = cred.security || '';
    if (el.amapEnabled) el.amapEnabled.checked = cred.enabled !== false;
    if (el.amapTestResult) el.amapTestResult.innerHTML = '';
    el.settingsModal.hidden = false;
  }

  function closeSettings() {
    if (el.settingsModal) el.settingsModal.hidden = true;
  }

  function readSettingsForm() {
    return {
      key: el.amapKey ? el.amapKey.value.trim() : '',
      security: el.amapSecurity ? el.amapSecurity.value.trim() : '',
      enabled: el.amapEnabled ? el.amapEnabled.checked : true,
    };
  }

  function renderAmapTestResult(result) {
    if (!el.amapTestResult) return;
    var html = '';
    if (result.checks && result.checks.length) {
      result.checks.forEach(function (check) {
        html +=
          '<div class="check"><span class="mark" style="color:' + (check.ok ? 'var(--ok)' : 'var(--bad)') + '">' +
          (check.ok ? '✔' : '✘') + '</span><span>' + escapeHtml(check.name) + '：' + escapeHtml(check.detail) + '</span></div>';
      });
    }
    if (result.error) html += '<div class="check"><span class="mark" style="color:var(--bad)">✘</span><span>' + escapeHtml(result.error) + '</span></div>';
    if (result.message) {
      html += '<div style="margin-top:6px;color:' + (result.ok ? 'var(--ok)' : 'var(--warn)') + '">' + escapeHtml(result.message) + '</div>';
    }
    if (result.hints && result.hints.length) {
      html += '<div class="hint-block"><b>常见原因与处理：</b><ul class="hint-list" style="margin:6px 0 0">';
      result.hints.forEach(function (hint) {
        html += '<li>' + escapeHtml(hint) + '</li>';
      });
      html += '</ul></div>';
    }
    el.amapTestResult.innerHTML = html;
  }

  async function runAmapTest() {
    var form = readSettingsForm();
    if (el.amapTestResult) el.amapTestResult.innerHTML = '<div style="color:var(--text-mute)">正在检测…</div>';
    try {
      // 用表单里的临时值测试，不落盘
      var result = await api.request('/api/amap/test', {
        method: 'POST',
        body: { key: form.key, security: form.security },
      });
      renderAmapTestResult(result);
      return result;
    } catch (error) {
      renderAmapTestResult({ ok: false, error: error.message, hints: [] });
      return { ok: false };
    }
  }

  async function saveAmapSettings() {
    var form = readSettingsForm();
    if (form.key && !/^[0-9a-fA-F]{32}$/.test(form.key)) {
      toast('Key 格式不正确：应为 32 位十六进制字符', 'error', 9000);
      return;
    }
    if (form.security && !/^[0-9a-fA-F]{32}$/.test(form.security)) {
      toast('安全密钥格式不正确：应为 32 位十六进制字符', 'error', 9000);
      return;
    }
    try {
      await api.request('/api/amap/config', { method: 'POST', body: form });
      if (Amap) {
        Amap.saveLocalCredentials(form);
        // 密钥变化后需要重新加载脚本
        amapView = null;
        window.__netscopeAmapReloaded = true;
      }
      try {
        window.localStorage.removeItem('netscope.amap.loaded');
      } catch (e) {
        /* ignore */
      }
      toast('已保存高德地图配置', 'ok');
      closeSettings();
      if (form.enabled && form.key) {
        switchBaseMap('amap', { silent: false });
      } else {
        switchBaseMap('builtin');
      }
    } catch (error) {
      toast('保存失败：' + escapeHtml(error.message), 'error');
    }
  }

  /* --------------------- 局域网扫描与本地拓扑 ------------------------ */

  /**
   * 扫描局域网设备，并把结果画成星型拓扑图
   * 数据来自 /api/lanscan：ARP 邻居表 + 网段存活探测 + 主机名反解 +
   * MAC 厂商识别 + SSDP/mDNS 设备发现
   */
  async function runLanScan() {
    if (state.busy) {
      toast('已有任务正在执行，请稍候', 'warn');
      return;
    }
    var deep = el.optDeepScan ? el.optDeepScan.checked : true;
    setBusy(true, deep ? '正在扫描局域网（主动探测整个网段）…' : '正在读取邻居表…');
    setProgress(8, '读取网卡与网关…');
    switchTab('local');

    var ticker = setInterval(function () {
      var pct = Number(String(el.progressInner.style.width || '8%').replace('%', '')) || 8;
      setProgress(Math.min(92, pct + 4), '正在探测网段内的主机…');
    }, 1200);

    try {
      var result = await api.lanScan({
        deep: deep,
        includeSsdp: true,
        includeMdns: true,
        maxHosts: 512,
        timeoutMs: 800,
        // 传给后端，用于把"本机地址"标注出来（例如同一台机器有多个地址时）
        hostname: (state.local && state.local.hostname) || null,
      });
      clearInterval(ticker);
      setProgress(100, '完成');

      renderLocalPanel(buildLocalPanelInput(result));
      renderLanTopologyView(result);

      var summary = '局域网扫描完成：发现 ' + result.lan.devices.length + ' 台设备';
      if (result.lan.scanned && result.lan.scanned.hosts) summary += '（探测 ' + result.lan.scanned.hosts + ' 个地址）';
      if (result.egress && result.egress.ip) {
        summary += '<br/>公网出口：' + escapeHtml(result.egress.ip) +
          (result.egress.location && result.egress.location.city ? '（' + escapeHtml(result.egress.location.city) + '）' : '');
      }
      toast(summary, 'ok', 9000);
    } catch (error) {
      clearInterval(ticker);
      toast('局域网扫描失败：' + escapeHtml(error.message), 'error', 9000);
    } finally {
      clearInterval(ticker);
      setBusy(false);
    }
  }

  /** 把扫描结果画成星型拓扑（局域网设备没有经纬度，始终用内置引擎） */
  async function renderLanTopologyView(result) {
    var topology = result.topology || { nodes: [], links: [] };
    if (result.egress && result.egress.location) {
      topology.anchor = result.egress.location;
      topology.egressIp = result.egress.ip;
    }
    state.lan = Object.assign({}, result, { topology: topology });

    // 高德底图无法表达"私有地址"的拓扑：先等它完整切回内置引擎，
    // 再绘制星型拓扑，否则会画到已隐藏的叠加层上（表现为"看不到拓扑图"）。
    // 同时记住用户的底图选择，下次探测时自动恢复。
    if (amapView) {
      state.pendingBaseMap = 'amap';
      toast('局域网设备使用私有地址、没有地理坐标，已切回内置引擎以星型拓扑展示（下次探测会自动恢复高德底图）', 'warn', 9000);
      await switchBaseMap('builtin');
    }

    document.querySelectorAll('[data-view]').forEach(function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-view') === 'graph');
    });
    state.view = 'graph';
    el.mapHint.hidden = true;
    el.mapStats.hidden = false;
    renderer.setLanTopology(topology);
    renderLanStats();
    renderHopsTableFromLan(topology);
  }

  /** 局域网模式下的统计栏（左侧网段，右侧设备与出口信息） */
  function renderLanStats() {
    var lan = state.lan || {};
    var topology = lan.topology || {};
    var devices = (topology.nodes || []).filter(function (n) { return n.role === 'device'; });
    var identified = devices.filter(function (d) { return d.vendor || d.hostname; }).length;

    el.statTarget.textContent = lan.lan && lan.lan.subnet ? lan.lan.subnet : '本机网络';
    el.statTarget.title = '当前局域网网段' + (lan.lan && lan.lan.gateway ? '，网关 ' + lan.lan.gateway : '');
    el.statHops.textContent = String(devices.length);
    if (el.statLocated) el.statLocated.textContent = String(identified);
    if (el.statUnlocated) {
      var unknown = devices.length - identified;
      el.statUnlocated.textContent = String(unknown);
      el.statUnlocated.style.color = unknown > 0 ? 'var(--warn)' : '';
      el.statUnlocated.title = '未识别出厂商与主机名的设备数量';
    }
    el.statRtt.textContent = lan.egress && lan.egress.ip ? lan.egress.ip : '—';
    el.statCountries.textContent = lan.lan && lan.lan.gateway ? lan.lan.gateway : '—';
    el.statDistance.textContent = lan.lan && lan.lan.scanned && lan.lan.scanned.durationMs
      ? (lan.lan.scanned.durationMs / 1000).toFixed(1) + ' s'
      : '—';
  }

  /** 局域网模式下用设备表替换跳点表 */
  function renderHopsTableFromLan(topology) {
    var tbody = el.hopsTable.querySelector('tbody');
    var nodes = (topology.nodes || []).filter(function (n) { return n.role !== 'internet'; });
    el.hopsCount.textContent = String(nodes.length);
    if (!nodes.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">未发现设备</td></tr>';
      return;
    }
    var html = '';
    nodes.forEach(function (node, index) {
      var roleTag = node.role === 'gateway'
        ? '<span class="tag tag-ok">网关</span>'
        : node.role === 'self' ? '<span class="tag">本机</span>' : '';
      var vendorText = node.vendor
        ? node.vendor
        : (node.vendorLocal ? '本地管理地址（虚拟机/随机 MAC）' : '厂商未识别');
      html +=
        '<tr data-lan-index="' + index + '">' +
        '<td class="ttl-cell">' + (node.role === 'gateway' ? 'GW' : node.role === 'self' ? 'ME' : String(index)) + '</td>' +
        '<td class="mono">' + escapeHtml(node.ip || '—') +
        (node.mac ? '<div style="color:var(--text-mute);font-size:11px">' + escapeHtml(node.mac) + '</div>' : '') + '</td>' +
        '<td class="loc-cell">' + escapeHtml(node.typeLabel || '设备') + ' ' + roleTag + '</td>' +
        '<td colspan="2" style="color:var(--text-dim)">' + escapeHtml(node.hostname || '') +
        '<div style="color:var(--text-mute);font-size:11px">' + escapeHtml(vendorText) + '</div>' +
        '</td>' +
        '</tr>';
    });
    tbody.innerHTML = html;

    var rendered = renderer.nodes.filter(function (n) { return n.kind !== 'internet'; });
    tbody.querySelectorAll('tr[data-lan-index]').forEach(function (row) {
      row.addEventListener('click', function () {
        var node = rendered[Number(row.getAttribute('data-lan-index'))];
        if (!node) return;
        renderer.setSelected(node);
        showNodeCard(node);
      });
    });
  }

  /** 仅读取本机信息（不主动扫描网段） */
  async function runLocalDiscoveryOnly() {
    switchTab('local');
    setBusy(true, '正在读取本机网络信息…');
    setProgress(30, '读取网卡、网关、ARP 邻居表…');
    try {
      var info = await api.local({
        includePorts: el.optListenPorts.checked ? 1 : 0,
        includeNeighbors: 1,
        includePublicIP: 1,
      });
      state.local = info;
      renderLocalPanel(info);
      setProgress(100, '完成');
      toast('已获取本机网络信息：' + info.interfaces.length + ' 个地址、' + info.neighbors.length + ' 个邻居', 'ok');
    } catch (error) {
      toast('读取本机网络失败：' + escapeHtml(error.message), 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 局域网设备详情卡片 */
  /**
   * 把局域网扫描结果整理成「本机网络」面板需要的结构
   * （设备列表用扫描结果，接口/网关/DNS 等沿用原字段，缺失时给空数组）
   */
  function buildLocalPanelInput(result) {
    var lan = result.lan || {};
    var egress = result.egress || {};
    var neighbors = (lan.devices || []).map(function (device) {
      return {
        ip: device.ip,
        mac: device.mac,
        type: device.arpType || 'dynamic',
        vendor: device.vendor,
        hostname: device.hostname,
        typeLabel: device.typeLabel,
      };
    });
    return {
      hostname: result.hostname || (lan.self && lan.self.length ? lan.self[0].name : '') || '本机',
      platform: result.platform || '',
      arch: result.arch || '',
      subnet: lan.subnet || null,
      interfaces: lan.interfaces || [],
      gateways: lan.gateway ? [lan.gateway] : [],
      dnsServers: result.dnsServers || [],
      neighbors: neighbors,
      listeners: result.listeners || [],
      publicIP: { ip: egress.ip || null, provider: egress.provider || null },
      geo: egress.location ? { [egress.ip]: egress.location } : {},
      localLocation: egress.location
        ? { city: egress.location.city, country: egress.location.country, source: egress.provider }
        : null,
      scanInfo: {
        hosts: lan.scanned ? lan.scanned.hosts : 0,
        alive: lan.scanned ? lan.scanned.alive : 0,
        durationMs: lan.scanned ? lan.scanned.durationMs : 0,
        ssdp: (lan.ssdp || []).length,
        mdns: (lan.mdns || []).length,
      },
    };
  }

  function showLanNodeCard(node) {
    var html = '';
    html += '<h3>' + escapeHtml(node.label || node.hostname || node.ip || '设备') + '</h3>';
    html += '<div class="subtitle">' + escapeHtml(node.typeLabel || '局域网设备') + '</div>';
    html += '<dl class="kv">';
    if (node.ip) html += '<dt>局域网地址</dt><dd class="mono">' + escapeHtml(node.ip) + '</dd>';
    if (node.mac) html += '<dt>MAC</dt><dd class="mono">' + escapeHtml(node.mac) + '</dd>';
    if (node.vendor) html += '<dt>厂商</dt><dd>' + escapeHtml(node.vendor) + '</dd>';
    if (node.iface) html += '<dt>接口</dt><dd>' + escapeHtml(node.iface) + '</dd>';
    if (node.ssdp) {
      html += '<dt>SSDP</dt><dd class="mono">' + escapeHtml(node.ssdp.server || node.ssdp.st || '已响应') + '</dd>';
      if (node.ssdp.location) html += '<dt>描述地址</dt><dd class="mono" style="font-size:11.5px">' + escapeHtml(node.ssdp.location) + '</dd>';
    }
    if (node.mdns && node.mdns.names && node.mdns.names.length) {
      html += '<dt>mDNS</dt><dd class="mono" style="font-size:11.5px">' + node.mdns.names.slice(0, 3).map(escapeHtml).join('<br/>') + '</dd>';
    }
    if (node.arpType) html += '<dt>ARP</dt><dd>' + escapeHtml(node.arpType === 'dynamic' ? '动态' : '静态') + '</dd>';
    html += '</dl>';
    html += '<div style="color:var(--text-mute);font-size:12px;line-height:1.6">' +
      '局域网设备使用私有地址，在世界地图上没有真实经纬度，因此用星型拓扑表达它与网关的连接关系。</div>';
    el.nodeCardBody.innerHTML = html;
    el.nodeCard.hidden = false;
  }

  function bindEvents() {
    el.targetForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = el.targetInput.value.trim();
      if (!value) {
        toast('请输入 IP 地址或网址', 'warn');
        return;
      }
      runDiagnose(value, false);
    });

    el.quickTargets.addEventListener('click', function (event) {
      var chip = event.target.closest('.chip');
      if (!chip) return;
      el.targetInput.value = chip.getAttribute('data-target');
      runDiagnose(chip.getAttribute('data-target'), false);
    });

    el.btnDiagnose.addEventListener('click', function () {
      var value = el.targetInput.value.trim();
      if (!value) {
        toast('请输入 IP 地址或网址', 'warn');
        return;
      }
      runDiagnose(value, true);
    });

    el.btnSelfTest.addEventListener('click', async function () {
      toast('正在自检本机探测能力…');
      try {
        var result = await api.selfTest();
        var html = '<strong>环境自检结果</strong><div style="margin-top:6px">';
        result.checks.forEach(function (check) {
          html +=
            '<div style="display:flex;gap:8px;margin:3px 0"><span style="color:' + (check.ok ? '#34d399' : '#f87171') + '">' +
            (check.ok ? '✔' : '✘') + '</span><span>' + escapeHtml(check.name) + '：' + escapeHtml(check.detail) + '</span></div>';
        });
        html += '</div>';
        toast(html, result.ok ? 'ok' : 'warn', 12000);
      } catch (error) {
        toast('自检失败：' + escapeHtml(error.message), 'error');
      }
    });

    el.btnExport.addEventListener('click', function () {
      if (!state.hops.length) {
        toast('暂无数据可导出，请先执行一次探测', 'warn');
        return;
      }
      showExportMenu();
    });

    el.btnLocal.addEventListener('click', runLocalDiscoveryOnly);
    if (el.btnLanScan) el.btnLanScan.addEventListener('click', runLanScan);

    // 图例面板：默认展开（用户反馈看不懂颜色含义），可收起
    if (el.btnLegend) {
      el.btnLegend.addEventListener('click', function () {
        if (el.legendPanel) el.legendPanel.hidden = !el.legendPanel.hidden;
      });
    }
    if (el.legendClose) {
      el.legendClose.addEventListener('click', function () {
        if (el.legendPanel) el.legendPanel.hidden = true;
      });
    }

    // 底图切换
    if (el.optBaseMap) {
      el.optBaseMap.addEventListener('change', function () {
        switchBaseMap(el.optBaseMap.value);
      });
    }

    // 高德设置面板
    if (el.btnSettings) el.btnSettings.addEventListener('click', openSettings);
    if (el.settingsClose) el.settingsClose.addEventListener('click', closeSettings);
    if (el.settingsModal) {
      el.settingsModal.addEventListener('click', function (event) {
        if (event.target === el.settingsModal) closeSettings();
      });
    }
    if (el.amapSave) el.amapSave.addEventListener('click', saveAmapSettings);
    if (el.amapTest) el.amapTest.addEventListener('click', runAmapTest);
    if (el.amapClear) {
      el.amapClear.addEventListener('click', function () {
        if (el.amapKey) el.amapKey.value = '';
        if (el.amapSecurity) el.amapSecurity.value = '';
        if (el.amapTestResult) el.amapTestResult.innerHTML = '';
        toast('已清空输入框内容，点「保存并应用」后生效', 'warn');
      });
    }
    el.btnEgress.addEventListener('click', runEgress);
    el.btnScan.addEventListener('click', runPortScan);

    // 窄屏下面板的展开 / 收起入口
    var btnSidebar = $('btn-sidebar');
    var btnPanel = $('btn-panel');
    var backdrop = $('sidebar-backdrop');
    var tabClose = $('tab-close');
    if (btnSidebar) btnSidebar.addEventListener('click', function () { toggleSidebar(); });
    if (btnPanel) {
      btnPanel.addEventListener('click', function () {
        toggleInspector();
        if ($('inspector') && $('inspector').classList.contains('is-open')) {
          setTimeout(function () { renderer.resize(); renderer.draw(); }, 60);
        }
      });
    }
    if (backdrop) backdrop.addEventListener('click', function () { toggleSidebar(false); });
    if (tabClose) tabClose.addEventListener('click', function () { toggleInspector(false); });

    el.optScanMode.addEventListener('change', function () {
      var mode = el.optScanMode.value;
      el.fieldScanPorts.hidden = mode !== 'custom';
      el.fieldScanRange.hidden = mode !== 'range';
    });

    el.optColor.addEventListener('change', function () {
      renderer.setOptions({ colorBy: el.optColor.value });
    });

    [
      [el.optShowLabels, 'showLabels'],
      [el.optShowLinks, 'showLinks'],
      [el.optShowGrid, 'showGrid'],
      [el.optAnimate, 'animate'],
      [el.optNight, 'night'],
    ].forEach(function (pair) {
      if (!pair[0]) return;
      pair[0].addEventListener('change', function () {
        var options = {};
        options[pair[1]] = pair[0].checked;
        renderer.setOptions(options);
      });
    });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchTab(tab.getAttribute('data-tab'));
      });
    });

    document.querySelectorAll('[data-view]').forEach(function (button) {
      button.addEventListener('click', function () {
        var view = button.getAttribute('data-view');
        document.querySelectorAll('[data-view]').forEach(function (other) {
          other.classList.toggle('is-active', other === button);
        });
        state.view = view;

        // 只有"当前展示的确实是局域网星型拓扑"时才保留星型模式。
        // 一旦用新目标探测过（state.hops 有数据），就必须解掉星型模式，
        // 否则渲染器会继续按星型布局画，"逻辑拓扑"看起来就是错的（甚至像没显示）。
        var showingLanTopology = Boolean(state.lan && state.lan.topology) && state.hops.length === 0;
        if (!showingLanTopology) renderer.lanMode = false;

        // 高德底图只提供地理视图。切到「逻辑拓扑」时**临时挂起**高德、
        // 改用内置引擎绘制，但保留用户选择的底图；切回世界地图时自动恢复高德。
        if (amapView) {
          if (view === 'graph') {
            // 顺序很重要：先切模式，再挂起（挂起会显示内置画布、重新量尺寸并重绘一次）。
            // 顺序反了会把刚画好的内容擦掉。
            renderer.setMode('graph');
            amapView.suspend();
            if (showingLanTopology) renderer.setLanTopology(state.lan.topology);
            // 统一入口按"当前视图"决定合并规则（此时高德已挂起，会走内置渲染器）
            drawCurrentTrace();
            // 逻辑拓扑也要有数据包流动动画（与内置地图保持一致）
            if (renderer.options.animate) renderer.startAnimation();
          } else {
            // 先让内置引擎把模式切回地图，再交还给高德
            renderer.setMode('map');
            amapView.resume();
            amapView.setTrace(state.hops, { local: state.local, target: state.target });
          }
          return;
        }
        if (showingLanTopology) {
          renderer.setLanTopology(state.lan.topology);
          return;
        }
        renderer.setMode(view);
        if (state.hops.length) drawCurrentTrace();
      });
    });

    $('btn-zoom-in').addEventListener('click', function () {
      if (amapView && amapView.getMap()) {
        amapView.getMap().zoomIn();
        return;
      }
      renderer.zoomAt(renderer.width / 2, renderer.height / 2, 1.25);
    });
    $('btn-zoom-out').addEventListener('click', function () {
      if (amapView && amapView.getMap()) {
        amapView.getMap().zoomOut();
        return;
      }
      renderer.zoomAt(renderer.width / 2, renderer.height / 2, 0.8);
    });
    $('btn-reset-view').addEventListener('click', function () {
      if (amapView) {
        // 高德视图：把当前覆盖物重新纳入视野
        if (state.lan && state.lan.topology) amapView.setLanTopology(state.lan.topology);
        else if (state.hops.length) amapView.setTrace(state.hops, { local: state.local, target: state.target });
        return;
      }
      if (state.lan && renderer.lanMode && state.lan.topology) {
        renderer.setLanTopology(state.lan.topology);
        return;
      }
      if (state.hops.length) renderer.fitToNodes();
      else renderer.fitToContainer();
    });

    bindCanvasInteraction();
    el.nodeCardClose.addEventListener('click', function () {
      el.nodeCard.hidden = true;
      renderer.setSelected(null);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (el.settingsModal && !el.settingsModal.hidden) {
          closeSettings();
          return;
        }
        if (state.stream) {
          state.stream.close();
          state.stream = null;
          setBusy(false);
          toast('已取消当前任务', 'warn');
        }
        el.nodeCard.hidden = true;
      }
    });
  }

  function bindCanvasInteraction() {
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    var moved = false;

    el.canvas.addEventListener('mousedown', function (event) {
      dragging = true;
      moved = false;
      lastX = event.clientX;
      lastY = event.clientY;
      el.canvas.classList.add('is-dragging');
    });

    window.addEventListener('mousemove', function (event) {
      if (!dragging) return;
      var dx = event.clientX - lastX;
      var dy = event.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      lastX = event.clientX;
      lastY = event.clientY;
      renderer.panBy(dx, dy);
    });

    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      el.canvas.classList.remove('is-dragging');
      if (!moved) {
        var node = renderer.hovered;
        if (node) {
          renderer.setSelected(node);
          showNodeCard(node);
        }
      }
    });

    el.canvas.addEventListener('mousemove', function (event) {
      if (dragging) return;
      var rect = el.canvas.getBoundingClientRect();
      var node = renderer.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      renderer.setHovered(node);
      el.canvas.style.cursor = node ? 'pointer' : 'grab';
    });

    el.canvas.addEventListener('mouseleave', function () {
      renderer.setHovered(null);
    });

    el.canvas.addEventListener(
      'wheel',
      function (event) {
        event.preventDefault();
        var rect = el.canvas.getBoundingClientRect();
        var factor = event.deltaY < 0 ? 1.12 : 0.89;
        renderer.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
      },
      { passive: false },
    );
  }

  /* ------------------------------ 探测流程 ------------------------------ */

  function collectParams() {
    var params = {
      maxHops: Number(el.optMaxHops.value),
      queries: Number(el.optQueries.value),
      timeoutMs: Number(el.optTimeout.value),
      resolveNames: el.optResolveNames.checked,
      engine: el.optEngine.value,
    };
    // URL 参数覆盖（便于自动化测试与分享固定视图）
    try {
      var search = new URLSearchParams(window.location.search);
      if (search.get('maxHops')) params.maxHops = Number(search.get('maxHops'));
      if (search.get('queries')) params.queries = Number(search.get('queries'));
      if (search.get('timeoutMs')) params.timeoutMs = Number(search.get('timeoutMs'));
      if (search.get('resolveNames') !== null) params.resolveNames = search.get('resolveNames') !== '0';
      if (search.get('engine')) params.engine = search.get('engine');
    } catch (e) {
      /* 忽略 */
    }
    return params;
  }

  /** 解析后自动执行（URL 参数 ?autorun=1） */
  function maybeAutoRun() {
    try {
      var search = new URLSearchParams(window.location.search);
      if (search.get('autorun') !== '1') return;
      var target = search.get('target');
      if (!target) return;
      el.targetInput.value = target;
      setTimeout(function () {
        runDiagnose(target, search.get('deep') === '1');
      }, 400);
    } catch (e) {
      /* 忽略 */
    }
  }

  function resetForNewRun(input) {
    if (state.stream) {
      state.stream.close();
      state.stream = null;
    }
    state.input = input;
    // 目标先以对象形式占位：后续 done 事件会补上 primaryIP 等字段，
    // 若留成字符串，赋值属性时会抛 TypeError
    state.target = { host: input };
    state.hops = [];
    state.geo = {};
    state.summary = null;
    state.trace = null;
    state.probe = null;
    state.dns = null;
    state.security = null;
    state.portScan = null;
    state.engine = null;
    state.fallbackNotes = [];
    // 退出局域网星型拓扑模式（否则"扫描局域网 → 再探测新目标"会一直画星型拓扑），
    // 但**尊重用户在探测前选择的视图**（世界地图 / 逻辑拓扑）——
    // 早期实现这里强行把视图复位为世界地图，导致"逻辑拓扑视图下探测外网"
    // 结果被画成按坐标合并的世界地图拓扑。
    renderer.lanMode = false;
    state.lan = null;
    if (amapView) amapView.setTrace([], {});
    else renderer.setTrace([], {});
    renderer.setSelected(null);
    // 若上次因局域网扫描临时切回了内置地图，这里恢复用户原本选择的底图
    if (state.pendingBaseMap === 'amap' && state.baseMap === 'builtin') {
      var restore = state.pendingBaseMap;
      state.pendingBaseMap = null;
      var savedHops = state.hops.slice();
      var savedLocal = state.local;
      var savedTarget = state.target;
      setTimeout(function () {
        switchBaseMap(restore).then(function () {
          if (amapView && savedHops.length) {
            amapView.setTrace(savedHops, { local: savedLocal, target: savedTarget });
          }
        });
      }, 0);
    }
    el.nodeCard.hidden = true;
    el.mapHint.hidden = true;
    el.mapStats.hidden = false;
    renderHopsTable();
    setProgress(5, '正在连接服务…');
  }

  /** 追踪（快速模式）：只做解析 + 路由追踪 + 地理定位 */
  function runTrace(input) {
    if (state.busy) {
      toast('已有任务正在执行，请稍候或按 Esc 取消', 'warn');
      return;
    }
    resetForNewRun(input);
    setBusy(true, '正在解析目标…');
    switchTab('hops');
    el.statTarget.textContent = input;

    var params = collectParams();
    var received = 0;
    var total = 0;

    state.stream = api.traceStream(input, params, {
      timeoutMs: 15 * 60 * 1000,
      onEvent: function (name, payload) {
        if (name === 'start') {
          setProgress(10, payload.message || '开始追踪…');
        } else if (name === 'progress') {
          if (payload.stage === 'hops' && Array.isArray(payload.hops)) {
            payload.hops.forEach(function (hop) {
              state.hops.push(hop);
              if (hop.ip && hop.geo) state.geo[hop.ip] = hop.geo;
            });
            received = payload.to || state.hops.length;
            total = payload.total || received;
            setProgress(20 + (received / Math.max(1, total)) * 65, '已获取 ' + received + '/' + total + ' 跳');
            // 边收边画：走统一入口，保证与完成时、切视图时的合并规则一致
            // （fit=false：增量刷新不重算视野，避免画面每来一批跳点就跳一下）
            drawCurrentTrace({ fit: false });
            renderHopsTable();
          } else if (payload.message) {
            setProgress(15, payload.message);
          }
        } else if (name === 'done') {
          setBusy(false);
          setProgress(100, '完成');
          var result = payload.result || {};
          state.hops = (result.trace && result.trace.hops) || state.hops;
          state.trace = result.trace || null;
          state.geo = result.geo || state.geo;
          state.local = result.local || state.local;
          state.engine = payload.engine || (result.trace && result.trace.engine) || null;
          state.fallbackNotes = payload.fallbackNotes || (result.trace && result.trace.fallbackNotes) || [];
          state.summary = payload.summary || (result.trace && result.trace.summary) || null;
          // state.target 必须是对象：runTrace 时它只被设为目标字符串，
          // 这里统一归一化，避免对字符串赋属性（会抛 TypeError）
          var resolvedTarget = result.target && typeof result.target === 'object' ? result.target : null;
          if (resolvedTarget) {
            state.target = resolvedTarget;
          } else if (typeof state.target === 'string' || state.target === null || state.target === undefined) {
            state.target = { host: typeof state.target === 'string' ? state.target : input };
          }
          if (state.target && result.targetIP && !state.target.primaryIP) {
            state.target.primaryIP = result.targetIP;
          }
          finalizeTrace();
          if (state.fallbackNotes && state.fallbackNotes.length) {
            toast('追踪引擎提示：' + escapeHtml(state.fallbackNotes.join('；')), 'warn', 9000);
          }
        }
      },
      onError: function (error) {
        setBusy(false);
        toast('探测失败：' + escapeHtml(error.message), 'error');
      },
      onClose: function () {
        setBusy(false);
        state.stream = null;
      },
    });
  }

  /** 深度诊断：连通性 + 路由 + 地理定位 +（可选）端口扫描与安全证书 */
  function runDiagnose(input, deep) {
    if (state.busy) {
      toast('已有任务正在执行，请稍候或按 Esc 取消', 'warn');
      return;
    }
    resetForNewRun(input);
    setBusy(true, '正在解析目标…');
    el.statTarget.textContent = input;

    var params = collectParams();
    params.includePortScan = false;
    var hopsReceived = 0;

    state.stream = api.diagnoseStream(input, params, {
      timeoutMs: 20 * 60 * 1000,
      onEvent: function (name, payload) {
        if (name === 'progress') {
          if (payload.stage === 'resolve') {
            setProgress(8, payload.message);
          } else if (payload.stage === 'probe') {
            setProgress(18, payload.message);
          } else if (payload.stage === 'trace') {
            setProgress(30, payload.message);
          } else if (payload.stage === 'geo') {
            setProgress(62, payload.message);
          } else if (payload.stage === 'ports') {
            if (payload.message) setProgress(75, payload.message);
            else if (payload.total) setProgress(75 + (payload.scanned / payload.total) * 15, '端口扫描 ' + payload.scanned + '/' + payload.total);
          } else if (payload.stage === 'hops' && Array.isArray(payload.hops)) {
            payload.hops.forEach(function (hop) {
              state.hops.push(hop);
            });
            hopsReceived = payload.to || state.hops.length;
            setProgress(62 + (hopsReceived / Math.max(1, payload.total)) * 20, '已获取 ' + hopsReceived + '/' + payload.total + ' 跳');
            renderHopsTable();
          } else if (payload.stage === 'done') {
            setProgress(98, payload.message || '即将完成');
          }
        } else if (name === 'done') {
          setBusy(false);
          setProgress(100, '完成');
          var result = payload.result || {};
          // 归一化 target 为对象，避免后续对字符串赋属性
          if (result.target && typeof result.target === 'object') {
            state.target = result.target;
          } else if (typeof state.target === 'string' || !state.target) {
            state.target = { host: typeof state.target === 'string' ? state.target : input };
          }
          state.probe = result.probe || null;
          state.trace = result.trace || null;
          state.summary = (result.trace && result.trace.summary) || null;
          state.engine = (result.trace && result.trace.engine) || null;
          state.fallbackNotes = (result.trace && result.trace.fallbackNotes) || [];
          state.hops = (result.trace && result.trace.hops) || state.hops;
          state.geo = result.geo || {};
          state.local = result.local || state.local;
          state.portScan = result.portScan || null;
          finalizeTrace();
          renderConnPanel();
          renderDnsPanelFromTarget();
          if (deep && state.target && state.target.primaryIP) {
            runSecurityCheck(input);
          }
        }
      },
      onError: function (error) {
        setBusy(false);
        toast('诊断失败：' + escapeHtml(error.message), 'error');
      },
      onClose: function () {
        setBusy(false);
        state.stream = null;
      },
    });
  }

  /**
   * 统一的重绘入口：把当前追踪数据按"当前视图"绘制。
   *
   * 存在的意义：追踪数据的重绘散落在多处（增量推送、完成、切视图、切底图…），
   * 早期实现每处都自己拼参数，于是出现了"增量重绘漏传 merge，
   * 逻辑拓扑每次收到跳点又被按地理坐标合并成一条线"的问题。
   * 现在全部走这一个函数，保证各处行为一致。
   *
   * @param {object} [options] { fit: boolean } fit 为 false 时不重算视野/布局（增量刷新用）
   */
  function drawCurrentTrace(options) {
    var opts = options || {};
    var graph = state.view === 'graph' && !renderer.lanMode;
    // 高德处于挂起状态（逻辑拓扑视图）时不能再把数据交给它：
    // 高德分支会按地理坐标合并，从而把"按跳展开"的逻辑拓扑覆盖成几个点。
    var amapActive = amapView && typeof amapView.isSuspended === 'function' && !amapView.isSuspended();

    if (amapActive) {
      amapView.setTrace(state.hops, { local: state.local, target: state.target });
      return;
    }

    // 逻辑拓扑按"跳"展开，不按地理坐标合并：
    // 否则"同一城市 6 跳"会被合并成 1 个点，逻辑拓扑看起来就像只有一条线
    renderer.setTrace(state.hops, {
      local: state.local,
      target: state.target,
      merge: !graph,
    });

    if (opts.fit === false) return;
    if (graph) renderer.layoutLogical();
    else renderer.fitToNodes();
    renderer.draw();
  }

  /** 把当前追踪数据绘制到"当前生效的底图"上（高德或内置引擎） */
  function renderTraceToActiveView() {
    // 追踪数据必须画在世界地图/逻辑拓扑上：若此前停在其它查看模式，
    // 这里要显式切到目标模式，否则用户会以为"地图没显示"
    if (!amapView) renderer.setMode(state.view === 'graph' ? 'graph' : 'map');
    drawCurrentTrace();
  }

  function finalizeTrace() {
    if (!state.hops.length) {
      toast('未获取到任何跳点。目标可能屏蔽了探测，或本机网络限制了 ICMP。', 'warn', 9000);
      return;
    }
    renderTraceToActiveView();
    renderHopsTable();
    D.drawLatencyChart(el.latencyChart, state.hops);
    updateStats();
    el.mapHint.hidden = true;
    el.mapStats.hidden = false;
  }

  function updateStats() {
    var stats = renderer.stats || {};
    // 目标地址可能非常长，统计栏只显示"主机名"或"IP"其一，并通过 title 提供完整信息
    var targetHost = (state.target && state.target.host) || state.input || '—';
    var targetIP = (state.target && state.target.primaryIP) || '';
    el.statTarget.textContent = targetIP || targetHost;
    el.statTarget.title = targetIP ? targetHost + '（解析为 ' + targetIP + '）' : targetHost;
    el.statHops.textContent = stats.hopCount || state.hops.length || '—';
    if (el.statLocated) el.statLocated.textContent = stats.locatedCount !== undefined ? String(stats.locatedCount) : '—';
    if (el.statUnlocated) {
      var missing = stats.unlocatedCount || 0;
      el.statUnlocated.textContent = String(missing);
      el.statUnlocated.style.color = missing > 0 ? 'var(--warn)' : '';
      el.statUnlocated.title = missing > 0
        ? '有 ' + missing + ' 跳无法确定地理位置，地图连线已跳过这些节点（详见「路由跳点」页的标注）'
        : '所有跳点均已定位';
    }
    el.statRtt.textContent = stats.avgRtt !== null && stats.avgRtt !== undefined ? stats.avgRtt + ' ms' : '—';
    el.statCountries.textContent = stats.countries && stats.countries.length ? stats.countries.length + ' 个' : '—';
    el.statDistance.textContent = estimateSpan() + ' km';
  }

  /** 粗略估算拓扑的地理跨度（首末节点大圆距离） */
  function estimateSpan() {
    var nodes = renderer.nodes.filter(function (n) {
      return typeof n.lat === 'number';
    });
    if (nodes.length < 2) return '—';
    var a = nodes[0];
    var b = nodes[nodes.length - 1];
    var toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad;
    var dLon = (b.lon - a.lon) * toRad;
    var h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return Math.round(km).toLocaleString('zh-CN');
  }

  /* ------------------------------ 表格渲染 ------------------------------ */

  function renderHopsTable() {
    var tbody = el.hopsTable.querySelector('tbody');
    el.hopsCount.textContent = String(state.hops.length);
    if (!state.hops.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">尚无数据，请先执行一次探测</td></tr>';
      return;
    }
    var html = '';
    state.hops.forEach(function (hop, index) {
      var geo = hop.geo || {};
      var hasGeo = typeof geo.lat === 'number' && isFinite(geo.lat) && typeof geo.lon === 'number' && isFinite(geo.lon);
      var location;
      if (hasGeo) {
        location = [geo.city, geo.country].filter(Boolean).join(' · ') || (hop.classification ? hop.classification.label : '未知');
      } else if (hop.isTimeout) {
        location = '<span style="color:var(--text-mute)">未响应，无地址可定位</span>';
      } else {
        location = '<span style="color:var(--warn)">未定位（不参与地图连线）</span>';
      }
      var addr = hop.ip ? escapeHtml(hop.ip) : '<span style="color:var(--text-mute)">*</span>';
      if (hop.hostname) addr += '<div style="color:var(--text-mute);font-size:11px">' + escapeHtml(hop.hostname) + '</div>';
      html +=
        '<tr class="' + (hop.isTimeout ? 'is-timeout' : '') + '" data-index="' + index + '">' +
        '<td class="ttl-cell">' + hop.ttl + '</td>' +
        '<td class="mono">' + addr + '</td>' +
        '<td class="loc-cell">' + location + '</td>' +
        '<td class="' + latencyClass(hop.latency && hop.latency.avg) + '">' + fmtMs(hop.latency && hop.latency.avg) + '</td>' +
        '<td>' + fmtPct(hop.latency && hop.latency.lossPct) + '</td>' +
        '</tr>';
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('tr[data-index]').forEach(function (row) {
      row.addEventListener('click', function () {
        var index = Number(row.getAttribute('data-index'));
        var hop = state.hops[index];
        tbody.querySelectorAll('tr').forEach(function (other) {
          other.classList.toggle('is-selected', other === row);
        });
        focusHop(hop);
      });
    });
  }

  /** 显示某个"未定位跳点"的说明（地图上没有它的位置，无法定位聚焦） */
  function showUnlocatedCard(entry) {
    var hop = entry.hop || {};
    var html = '';
    html += '<h3>第 ' + escapeHtml(entry.ttl) + ' 跳 · 未定位</h3>';
    html += '<div class="subtitle">' + escapeHtml(entry.ip || '无响应（*）') + '</div>';
    html += '<dl class="kv">';
    html += '<dt>原因</dt><dd>' + escapeHtml(entry.reason) + '</dd>';
    if (typeof hop.latency?.avg === 'number') {
      html += '<dt>延迟</dt><dd>' + fmtMs(hop.latency.avg) + '（最小 ' + fmtMs(hop.latency.min) + ' / 最大 ' + fmtMs(hop.latency.max) + '）</dd>';
      html += '<dt>丢包</dt><dd>' + fmtPct(hop.latency.lossPct) + '</dd>';
    }
    if (hop.classification) html += '<dt>地址性质</dt><dd>' + escapeHtml(hop.classification.label) + '</dd>';
    html += '</dl>';
    html += '<div style="color:var(--text-mute);font-size:12px;line-height:1.6;margin-top:6px">' +
      '该跳没有可用的地理位置，因此<strong>不会出现在世界地图上</strong>，' +
      '连接它前后两个已定位节点的连线也已被跳过（地图上表现为一段空白）。</div>';
    el.nodeCardBody.innerHTML = html;
    el.nodeCard.hidden = false;
    renderer.setSelected(null);
  }

  /** 定位并高亮某一跳对应的地图节点（未定位的跳点在地图上不存在，改为弹出说明卡片） */
  function focusHop(hop) {
    // 局域网模式下点击设备表走另一条路径
    if (renderer.lanMode) return;
    var node = renderer.nodes.find(function (candidate) {
      return (candidate.hops || []).some(function (h) {
        return h === hop || (h.ip && hop.ip && h.ip === hop.ip && h.ttl === hop.ttl);
      });
    });
    if (!node) {
      var entry = (renderer.unlocated || []).find(function (u) {
        return u.hop === hop || (u.ip && hop.ip && u.ip === hop.ip && u.ttl === hop.ttl);
      });
      showUnlocatedCard(entry || { ttl: hop.ttl, ip: hop.ip, reason: '该跳未参与地图连线（缺少地理位置）', hop: hop });
      return;
    }
    if (amapView) {
      // 高德视图：把地图中心移到该节点
      var map = amapView.getMap();
      if (map && typeof node.lon === 'number' && typeof node.lat === 'number') {
        map.setZoomAndCenter(Math.max(map.getZoom(), 6), [node.lon, node.lat]);
      }
      showNodeCard(node);
      return;
    }
    if (state.view === 'map' && typeof node.x === 'number') {
      renderer.view.scale = Math.max(renderer.view.scale, 1.4);
      var target = renderer.toScreen(node.x, node.y);
      renderer.panBy(renderer.width / 2 - target.x, renderer.height / 2 - target.y);
    }
    renderer.setSelected(node);
    showNodeCard(node);
  }

  function showNodeCard(node) {
    var hops = node.hops || [];
    var html = '';
    html += '<h3>' + escapeHtml(node.label || '节点') + '</h3>';
    html += '<div class="subtitle">' + escapeHtml(node.subtitle || '') + '</div>';

    html += '<dl class="kv">';
    if (typeof node.lat === 'number') {
      html += '<dt>坐标</dt><dd class="mono">' + node.lat.toFixed(4) + ', ' + node.lon.toFixed(4) + '</dd>';
    }
    if (node.city || node.country) {
      html += '<dt>位置</dt><dd>' + escapeHtml([node.city, node.country].filter(Boolean).join(' · ')) + '</dd>';
    }
    if (node.isp) html += '<dt>运营商</dt><dd>' + escapeHtml(node.isp) + '</dd>';
    if (node.asn) html += '<dt>ASN</dt><dd class="mono">' + escapeHtml(node.asn) + '</dd>';
    if (node.provider) html += '<dt>定位来源</dt><dd>' + escapeHtml(node.provider) + (node.precision ? '（' + escapeHtml(node.precision) + '）' : '') + '</dd>';
    if (node.geoStatus === 'private') html += '<dt>说明</dt><dd>内网地址，已按本机所在位置估算</dd>';
    html += '</dl>';

    if (hops.length) {
      html += '<div class="section-title">该位置的跳点</div>';
      hops.forEach(function (hop) {
        html += '<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--line-soft)">';
        html += '<div class="mono" style="color:var(--accent-3)">第 ' + hop.ttl + ' 跳 · ' + escapeHtml(hop.ip || '*') + '</div>';
        if (hop.hostname) html += '<div style="color:var(--text-mute);font-size:11.5px">' + escapeHtml(hop.hostname) + '</div>';
        html +=
          '<div style="font-size:12px;color:var(--text-dim);margin-top:3px">延迟 ' +
          fmtMs(hop.latency && hop.latency.avg) +
          '（最小 ' + fmtMs(hop.latency && hop.latency.min) + ' / 最大 ' + fmtMs(hop.latency && hop.latency.max) + '）· 丢包 ' +
          fmtPct(hop.latency && hop.latency.lossPct) +
          ' · 抖动 ' + fmtMs(hop.latency && hop.latency.jitter) + '</div>';
        if (hop.classification) {
          html += '<div style="margin-top:4px"><span class="tag">' + escapeHtml(hop.classification.label) + '</span></div>';
        }
        html += '</div>';
      });
    }

    el.nodeCardBody.innerHTML = html;
    el.nodeCard.hidden = false;
  }

  /* ------------------------------ 各面板渲染 ---------------------------- */

  function renderConnPanel() {
    var probe = state.probe;
    if (!probe) {
      el.connContent.innerHTML = '<p class="empty">尚无数据。点击「深度诊断」可获得完整连通性报告。</p>';
      return;
    }
    var html = '';
    var ping = probe.ping || {};
    var target = state.target || {};

    html += '<div class="section-title">基本信息</div><dl class="kv">';
    html += '<dt>输入</dt><dd class="mono">' + escapeHtml(state.input || '') + '</dd>';
    if (target.host) html += '<dt>主机名</dt><dd class="mono">' + escapeHtml(target.host) + '</dd>';
    if (target.primaryIP) html += '<dt>解析地址</dt><dd class="mono">' + escapeHtml(target.primaryIP) + '</dd>';
    if (target.classification) html += '<dt>地址性质</dt><dd>' + escapeHtml(target.classification.label) + '</dd>';
    if (probe.reverseDns) html += '<dt>反向解析</dt><dd class="mono">' + escapeHtml(probe.reverseDns) + '</dd>';
    if (probe.dns && probe.dns.cname) html += '<dt>CNAME</dt><dd class="mono">' + escapeHtml(probe.dns.cname) + '</dd>';
    if (probe.dns && probe.dns.durationMs !== undefined) html += '<dt>DNS 耗时</dt><dd>' + probe.dns.durationMs + ' ms</dd>';
    html += '</dl>';

    html += '<div class="section-title">ICMP 连通性</div>';
    if (ping && ping.sent) {
      html += '<dl class="kv">';
      html += '<dt>存活</dt><dd>' + (ping.alive ? '<span class="tag tag-ok">可达</span>' : '<span class="tag tag-bad">无响应</span>') + '</dd>';
      html += '<dt>丢包率</dt><dd>' + fmtPct(ping.lossPct) + '（' + (ping.received || 0) + '/' + (ping.sent || 0) + '）</dd>';
      html += '<dt>延迟</dt><dd>' + fmtMs(ping.avg) + '（最小 ' + fmtMs(ping.min) + ' / 最大 ' + fmtMs(ping.max) + '）</dd>';
      html += '<dt>抖动</dt><dd>' + fmtMs(ping.jitter) + '</dd>';
      html += '</dl>';
      if (ping.samples && ping.samples.length) {
        var maxSample = Math.max.apply(null, ping.samples) || 1;
        html += '<div style="margin:6px 0 12px">';
        ping.samples.forEach(function (sample, index) {
          html +=
            '<div class="bar-row"><span>第 ' + (index + 1) + ' 次</span><span class="bar"><i style="width:' +
            Math.round((sample / maxSample) * 100) + '%"></i></span><span class="mono">' + sample + ' ms</span></div>';
        });
        html += '</div>';
      }
    } else {
      html += '<p class="empty">未获取到 ICMP 结果</p>';
    }

    html += '<div class="section-title">TCP 端口连通</div>';
    if (probe.tcp && probe.tcp.length) {
      probe.tcp.forEach(function (item) {
        var tag = item.open ? '<span class="tag tag-ok">开放</span>' : item.state === 'closed' ? '<span class="tag">关闭（拒绝）</span>' : '<span class="tag tag-warn">' + escapeHtml(item.state) + '</span>';
        html +=
          '<div class="bar-row" style="grid-template-columns:64px 1fr auto"><span class="mono">' + item.port + '</span><span>' + tag +
          '</span><span class="mono">' + (item.open ? item.latencyMs + ' ms' : '—') + '</span></div>';
      });
    } else {
      html += '<p class="empty">无端口探测数据</p>';
    }

    html += '<div class="section-title">HTTP(S) 响应</div>';
    if (probe.http && probe.http.length) {
      probe.http.forEach(function (item) {
        html += '<dl class="kv">';
        html += '<dt>' + (item.tls ? 'HTTPS' : 'HTTP') + ' ' + item.port + '</dt><dd>' +
          (item.ok ? '<span class="tag tag-ok">HTTP ' + item.statusCode + '</span>' : '<span class="tag tag-bad">' + escapeHtml(item.error || '失败') + '</span>') + '</dd>';
        if (item.ok) {
          html += '<dt>首字节</dt><dd>' + (item.ttfbMs !== undefined ? item.ttfbMs + ' ms' : '—') + '</dd>';
          if (item.headers && item.headers.server) html += '<dt>Server</dt><dd class="mono">' + escapeHtml(item.headers.server) + '</dd>';
          if (item.headers && item.headers['content-type']) html += '<dt>类型</dt><dd class="mono">' + escapeHtml(item.headers['content-type']) + '</dd>';
        }
        html += '</dl>';
      });
    } else {
      html += '<p class="empty">无 HTTP 探测数据</p>';
    }

    el.connContent.innerHTML = html;
  }

  function renderPortsPanel() {
    var scan = state.portScan;
    if (!scan) {
      el.portsContent.innerHTML = '<p class="empty">尚未扫描。可在左侧「端口扫描」中执行。</p>';
      el.portsCount.textContent = '0';
      return;
    }
    el.portsCount.textContent = String(scan.open.length);
    var html = '<dl class="kv">';
    html += '<dt>扫描目标</dt><dd class="mono">' + escapeHtml(scan.host) + '</dd>';
    html += '<dt>探测端口</dt><dd>' + scan.total + ' 个 · 耗时 ' + scan.durationMs + ' ms</dd>';
    html += '<dt>开放 / 关闭 / 过滤</dt><dd>' + scan.open.length + ' / ' + scan.closed + ' / ' + scan.filtered + '</dd>';
    html += '</dl>';

    if (scan.open.length) {
      html += '<div class="section-title">开放端口</div>';
      scan.open.forEach(function (item) {
        html += '<div class="bar-row" style="grid-template-columns:60px 1fr auto"><span class="mono" style="color:var(--ok)">' + item.port + '</span><span>' +
          escapeHtml(item.service || '未知服务') + '</span><span class="mono">' + item.latencyMs + ' ms</span></div>';
      });
    } else {
      html += '<p class="empty">未发现开放端口</p>';
    }

    var filtered = scan.results.filter(function (item) {
      return item.state === 'timeout' || item.state === 'error';
    });
    if (filtered.length) {
      html += '<div class="section-title">无响应（可能被防火墙过滤）</div><div>';
      filtered.slice(0, 60).forEach(function (item) {
        html += '<span class="tag tag-warn">' + item.port + (item.service ? ' ' + escapeHtml(item.service) : '') + '</span>';
      });
      html += '</div>';
    }
    el.portsContent.innerHTML = html;
  }

  async function runPortScan() {
    var input = el.targetInput.value.trim() || state.input;
    if (!input) {
      toast('请先输入目标', 'warn');
      return;
    }
    var mode = el.optScanMode.value;
    var body = { target: input, mode: mode };
    if (mode === 'custom') {
      var ports = (el.optScanPorts.value || '')
        .split(/[,，\s]+/)
        .map(function (v) { return parseInt(v, 10); })
        .filter(function (v) { return Number.isInteger(v) && v > 0 && v <= 65535; });
      if (!ports.length) {
        toast('请输入至少一个有效端口，例如 80,443,8080', 'warn');
        return;
      }
      body.ports = ports;
    } else if (mode === 'range') {
      body.from = Number(el.optScanFrom.value);
      body.to = Number(el.optScanTo.value);
    }

    switchTab('ports');
    setBusy(true, '正在扫描端口…');
    setProgress(20, '端口扫描中…');
    try {
      var result = await api.portScan(input, body);
      state.portScan = result.scan;
      renderPortsPanel();
      setProgress(100, '完成');
      toast('端口扫描完成：开放 ' + result.scan.open.length + ' 个端口', 'ok');
    } catch (error) {
      toast('端口扫描失败：' + escapeHtml(error.message), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runSecurityCheck(input) {
    try {
      var result = await api.security(input);
      state.security = result;
      renderSecurityPanel();
    } catch (error) {
      el.securityContent.innerHTML = '<p class="empty">安全检查失败：' + escapeHtml(error.message) + '</p>';
    }
  }

  function renderSecurityPanel() {
    var sec = state.security;
    if (!sec) {
      el.securityContent.innerHTML = '<p class="empty">尚未检查。探测 HTTPS 目标时自动执行。</p>';
      return;
    }
    var cert = sec.certificate || {};
    var html = '';
    html += '<div class="section-title">证书概览</div>';
    if (cert.ok) {
      var riskTag = cert.expired ? 'tag-bad' : !cert.authorized ? 'tag-warn' : 'tag-ok';
      html += '<dl class="kv">';
      html += '<dt>状态</dt><dd><span class="tag ' + riskTag + '">' +
        (cert.expired ? '已过期' : cert.authorized ? '有效且受信任' : '链校验未通过') + '</span></dd>';
      html += '<dt>颁发给</dt><dd>' + escapeHtml(cert.subject && (cert.subject.CN || cert.subject.O) || '—') + '</dd>';
      html += '<dt>颁发者</dt><dd>' + escapeHtml(cert.issuer && (cert.issuer.O || cert.issuer.CN) || '—') + '</dd>';
      html += '<dt>有效期</dt><dd>' + escapeHtml(cert.validFrom || '') + ' → ' + escapeHtml(cert.validTo || '') + '</dd>';
      html += '<dt>剩余天数</dt><dd class="' + (cert.daysRemaining < 30 ? 'lat-bad' : 'lat-good') + '">' + (cert.daysRemaining ?? '—') + ' 天</dd>';
      html += '<dt>协议 / 套件</dt><dd class="mono">' + escapeHtml(cert.protocol || '—') + ' / ' + escapeHtml(cert.cipher && cert.cipher.name || '—') + '</dd>';
      html += '</dl>';
      if (cert.chain && cert.chain.length > 1) {
        html += '<div class="section-title">证书链</div><ol class="list-plain">';
        cert.chain.forEach(function (item) {
          html += '<li>' + escapeHtml(item.subject && (item.subject.CN || item.subject.O) || '未知') + '<div style="color:var(--text-mute);font-size:11px">' +
            escapeHtml(item.issuer && item.issuer.O || '') + '</div></li>';
        });
        html += '</ol>';
      }
      if (cert.subjectAltName && cert.subjectAltName.length) {
        html += '<div class="section-title">SAN（前 12 条）</div><div>';
        cert.subjectAltName.slice(0, 12).forEach(function (name) {
          html += '<span class="tag">' + escapeHtml(name) + '</span>';
        });
        html += '</div>';
      }
    } else {
      html += '<p class="empty">未能获取证书：' + escapeHtml(cert.error || '未知原因') + '</p>';
    }

    if (sec.observations && sec.observations.length) {
      html += '<div class="section-title">检查结论</div><ul class="list-plain">';
      sec.observations.forEach(function (item) {
        html += '<li>' + escapeHtml(item) + '</li>';
      });
      html += '</ul>';
    }
    el.securityContent.innerHTML = html;
  }

  async function runLocalDiscovery() {
    switchTab('local');
    setBusy(true, '正在读取本机网络信息…');
    setProgress(30, '读取网卡、网关、ARP 邻居表…');
    try {
      var info = await api.local({
        includePorts: el.optListenPorts.checked ? 1 : 0,
        includeNeighbors: 1,
        includePublicIP: 1,
      });
      state.local = info;
      renderLocalPanel(info);
      renderLocalTopology(info);
      setProgress(100, '完成');
      toast('已获取本机网络拓扑：' + info.interfaces.length + ' 个地址、' + info.neighbors.length + ' 个邻居', 'ok');
    } catch (error) {
      toast('读取本机网络失败：' + escapeHtml(error.message), 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderLocalPanel(info) {
    var html = '';
    html += '<div class="section-title">主机信息</div><dl class="kv">';
    html += '<dt>主机名</dt><dd class="mono">' + escapeHtml(info.hostname) + '</dd>';
    html += '<dt>系统</dt><dd>' + escapeHtml(info.platform) + ' / ' + escapeHtml(info.arch) + '</dd>';
    html += '<dt>网段</dt><dd class="mono">' + escapeHtml(info.subnet || '—') + '</dd>';
    if (info.publicIP && info.publicIP.ip) {
      html += '<dt>公网出口</dt><dd class="mono">' + escapeHtml(info.publicIP.ip) + '</dd>';
      var pubGeo = info.geo && info.geo[info.publicIP.ip];
      if (pubGeo) {
        html += '<dt>出口位置</dt><dd>' + escapeHtml([pubGeo.city, pubGeo.country].filter(Boolean).join(' · ') || '—') + '</dd>';
        if (pubGeo.isp) html += '<dt>出口运营商</dt><dd>' + escapeHtml(pubGeo.isp) + '</dd>';
      }
    } else if (info.publicIP && info.publicIP.note) {
      html += '<dt>公网出口</dt><dd style="color:var(--text-mute)">' + escapeHtml(info.publicIP.note) + '</dd>';
    }
    if (info.localLocation) {
      html += '<dt>本机定位</dt><dd>' + escapeHtml([info.localLocation.city, info.localLocation.country].filter(Boolean).join(' · ')) +
        '<div style="color:var(--text-mute);font-size:11px">来源：' + escapeHtml(info.localLocation.source) + '</div></dd>';
    }
    html += '</dl>';

    html += '<div class="section-title">网络接口（' + info.interfaces.length + '）</div>';
    info.interfaces.forEach(function (iface) {
      html += '<div style="margin-bottom:7px"><span class="mono" style="color:var(--accent)">' + escapeHtml(iface.address) + '</span>' +
        '<span style="color:var(--text-mute);font-size:11.5px"> · ' + escapeHtml(iface.name) + ' · ' + escapeHtml(iface.family) + '</span>' +
        (iface.mac ? '<div style="color:var(--text-mute);font-size:11px" class="mono">' + escapeHtml(iface.mac) + '</div>' : '') +
        '</div>';
    });

    if (info.gateways && info.gateways.length) {
      html += '<div class="section-title">默认网关</div><div>';
      info.gateways.forEach(function (gw) {
        html += '<span class="tag tag-ok mono">' + escapeHtml(gw) + '</span>';
      });
      html += '</div>';
    }

    if (info.dnsServers && info.dnsServers.length) {
      html += '<div class="section-title">DNS 服务器</div><div>';
      info.dnsServers.forEach(function (server) {
        html += '<span class="tag mono">' + escapeHtml(server) + '</span>';
      });
      html += '</div>';
    }

    if (info.neighbors && info.neighbors.length) {
      html += '<div class="section-title">邻居设备（ARP，' + info.neighbors.length + '）</div>';
      info.neighbors.forEach(function (item) {
        html += '<div class="bar-row" style="grid-template-columns:1fr auto"><span class="mono">' + escapeHtml(item.ip) + '</span><span class="mono" style="color:var(--text-mute)">' + escapeHtml(item.mac) + '</span></div>';
      });
    }

    if (info.listeners && info.listeners.length) {
      html += '<div class="section-title">本机监听端口（' + info.listeners.length + '）</div>';
      info.listeners.slice(0, 80).forEach(function (item) {
        html += '<div class="bar-row" style="grid-template-columns:52px 1fr auto"><span class="mono">' + item.port + '</span><span class="mono" style="color:var(--text-dim)">' +
          escapeHtml(item.address) + '</span><span style="color:var(--text-mute);font-size:11px">' + escapeHtml(item.proto) + ' PID ' + (item.pid === null || item.pid === undefined ? '-' : item.pid) + '</span></div>';
      });
    }

    el.localContent.innerHTML = html;
  }

  /** 把“本机网络”也画成拓扑图：本机 → 网关 → DNS/公网出口 */
  function renderLocalTopology(info) {
    var localGeo = info.localLocation || {};
    var hops = [];
    var ttl = 1;

    (info.gateways || []).forEach(function (gw) {
      hops.push({
        ttl: ttl++,
        ip: gw,
        hostname: '默认网关',
        latency: { avg: 1, min: 1, max: 1, jitter: 0, lossPct: 0, attempts: 1, responded: 1 },
        geo: {
          lat: localGeo.lat,
          lon: localGeo.lon,
          city: localGeo.city,
          country: localGeo.country,
          status: 'private',
          provider: 'builtin-local',
          precision: 'city',
        },
        classification: { kind: 'private', label: '局域网网关' },
      });
    });

    (info.dnsServers || []).slice(0, 3).forEach(function (server) {
      hops.push({
        ttl: ttl++,
        ip: server,
        hostname: 'DNS 服务器',
        latency: { avg: null, lossPct: 0, jitter: 0, attempts: 1, responded: 0 },
        geo: (info.geo && info.geo[server]) || null,
      });
    });

    if (info.publicIP && info.publicIP.ip) {
      var pubGeo = (info.geo && info.geo[info.publicIP.ip]) || null;
      hops.push({
        ttl: ttl++,
        ip: info.publicIP.ip,
        hostname: '公网出口',
        latency: { avg: null, lossPct: 0, jitter: 0, attempts: 1, responded: 0 },
        geo: pubGeo,
        classification: { kind: 'public', label: '公网出口地址' },
      });
    }

    if (!hops.length) {
      toast('未发现可绘制的网关/DNS 信息（可能受权限限制）', 'warn');
      return;
    }

    state.hops = hops;
    state.local = {
      location: {
        lat: localGeo.lat,
        lon: localGeo.lon,
        city: localGeo.city,
        country: localGeo.country,
        countryCode: localGeo.countryCode,
        source: localGeo.source,
      },
      hostname: info.hostname,
      interfaces: info.interfaces,
    };
    renderer.setTrace(hops, { local: state.local, target: { host: '本机网络', primaryIP: info.publicIP && info.publicIP.ip } });
    renderer.fitToNodes();
    renderHopsTable();
    D.drawLatencyChart(el.latencyChart, hops);
    updateStats();
    el.mapHint.hidden = true;
    el.mapStats.hidden = false;
  }

  /** 「出口信息」按钮：在左侧面板简短展示出口结果 */
  function showLocalBrief(result) {
    var geo = result.geo || {};
    var local = result.local || {};
    var html = '<div class="section-title">公网出口</div><dl class="kv">';
    html += '<dt>出口 IP</dt><dd class="mono">' + escapeHtml(result.publicIP.ip) + '</dd>';
    html += '<dt>查询来源</dt><dd>' + escapeHtml(result.publicIP.provider || '—') + '</dd>';
    if (geo.city || geo.country) html += '<dt>归属地</dt><dd>' + escapeHtml([geo.city, geo.country].filter(Boolean).join(' · ')) + '</dd>';
    if (geo.isp) html += '<dt>运营商</dt><dd>' + escapeHtml(geo.isp) + '</dd>';
    if (geo.asn) html += '<dt>ASN</dt><dd class="mono">' + escapeHtml(geo.asn) + '</dd>';
    if (local.city) html += '<dt>本机时区城市</dt><dd>' + escapeHtml(local.city) + '</dd>';
    html += '</dl>';
    el.localContent.innerHTML = html;
  }

  async function runEgress() {
    setBusy(true, '正在获取公网出口信息…');
    try {
      var result = await api.egress();
      if (!result.publicIP || !result.publicIP.ip) {
        toast('未能获取公网出口 IP：' + escapeHtml((result.publicIP && result.publicIP.note) || '未知原因'), 'warn');
        return;
      }
      var geo = result.geo || {};
      var html = '<strong>公网出口 IP：' + escapeHtml(result.publicIP.ip) + '</strong>';
      html += '<div style="margin-top:5px;color:var(--text-dim)">来源：' + escapeHtml(result.publicIP.provider || '—') + '</div>';
      if (geo.city || geo.country) {
        html += '<div style="color:var(--text-dim)">位置：' + escapeHtml([geo.city, geo.country].filter(Boolean).join(' · ')) + '</div>';
      }
      if (geo.isp) html += '<div style="color:var(--text-dim)">运营商：' + escapeHtml(geo.isp) + '</div>';
      toast(html, 'ok', 12000);
      switchTab('local');
      showLocalBrief(result);
    } catch (error) {
      toast('获取出口信息失败：' + escapeHtml(error.message), 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 目标解析完成后自动填充 DNS 面板 */
  async function renderDnsPanelFromTarget() {
    var host = state.target && state.target.host;
    if (!host) return;
    try {
      var report = await api.dns(host);
      state.dns = report;
      renderDnsPanel(report);
    } catch (error) {
      el.dnsContent.innerHTML = '<p class="empty">DNS 查询失败：' + escapeHtml(error.message) + '</p>';
    }
  }

  function renderDnsPanel(report) {
    if (!report) return;
    var html = '';
    var summary = report.summary || {};
    html += '<div class="section-title">解析摘要</div><dl class="kv">';
    html += '<dt>域名</dt><dd class="mono">' + escapeHtml(report.domain) + '</dd>';
    if (summary.cname) html += '<dt>CNAME</dt><dd class="mono">' + escapeHtml(summary.cname) + '</dd>';
    if (summary.cnameChain && summary.cnameChain.length) {
      html += '<dt>解析链</dt><dd class="mono" style="font-size:11.5px">' + summary.cnameChain.map(escapeHtml).join('<br/>→ ') + '</dd>';
    }
    html += '<dt>耗时</dt><dd>' + (report.durationMs ?? '—') + ' ms</dd>';
    html += '</dl>';

    html += '<div class="section-title">A / AAAA 记录</div>';
    if (summary.addresses && summary.addresses.length) {
      summary.addresses.forEach(function (ip) {
        var geo = (report.geo && report.geo[ip]) || null;
        html += '<div class="bar-row" style="grid-template-columns:1fr auto"><span class="mono">' + escapeHtml(ip) + '</span><span style="color:var(--text-mute);font-size:11.5px">' +
          escapeHtml(geo ? [geo.city, geo.country].filter(Boolean).join(' · ') || '—' : '—') + '</span></div>';
      });
    } else {
      html += '<p class="empty">未查询到 A 记录（可能被当前网络屏蔽了直连 DNS 查询）</p>';
    }

    (report.records || []).forEach(function (record) {
      if (record.type === 'A' || record.type === 'AAAA') return;
      html += '<div class="section-title">' + record.type + '</div>';
      if (record.ok && record.values.length) {
        record.values.slice(0, 12).forEach(function (value) {
          var text = typeof value === 'object' ? JSON.stringify(value) : value;
          html += '<div class="mono" style="font-size:11.5px;margin-bottom:3px;word-break:break-all">' + escapeHtml(text) + '</div>';
        });
      } else {
        html += '<p class="empty" style="padding:6px">' + escapeHtml(record.errorMessage || record.error || '无记录') + '</p>';
      }
    });

    if (report.local && report.local.servers && report.local.servers.length) {
      html += '<div class="section-title">本机 DNS 服务器</div><div>';
      report.local.servers.forEach(function (server) {
        html += '<span class="tag mono">' + escapeHtml(server) + '</span>';
      });
      html += '</div>';
    }

    html += '<div style="margin-top:12px"><button class="btn btn-ghost btn-sm" id="btn-dns-compare">多 DNS 服务器对比</button> ' +
      '<button class="btn btn-ghost btn-sm" id="btn-dns-delegation">追踪委派链路</button></div>';
    html += '<div id="dns-extra" style="margin-top:10px"></div>';
    el.dnsContent.innerHTML = html;

    var compareBtn = $('btn-dns-compare');
    if (compareBtn) {
      compareBtn.addEventListener('click', async function () {
        var extra = $('dns-extra');
        extra.innerHTML = '<p class="empty">查询中…</p>';
        try {
          var result = await api.dnsCompare(report.domain);
          var out = '<div class="section-title">不同解析器结果对比</div>';
          result.resolvers.forEach(function (item) {
            var locs = (item.addresses || []).map(function (ip) {
              var geo = (result.geo && result.geo[ip]) || null;
              return ip + (geo && geo.city ? '（' + escapeHtml([geo.city, geo.country].filter(Boolean).join(' · ')) + '）' : '');
            });
            out += '<div style="margin-bottom:7px"><span class="mono" style="color:var(--accent)">' + escapeHtml(item.server) + '</span>' +
              '<span style="color:var(--text-mute);font-size:11.5px"> · ' + item.durationMs + ' ms</span>' +
              '<div style="font-size:11.5px;color:var(--text-dim)">' + (item.ok ? locs.join('<br/>') : escapeHtml(item.error || '失败')) + '</div></div>';
          });
          extra.innerHTML = out;
        } catch (error) {
          extra.innerHTML = '<p class="empty">对比失败：' + escapeHtml(error.message) + '</p>';
        }
      });
    }

    var delegationBtn = $('btn-dns-delegation');
    if (delegationBtn) {
      delegationBtn.addEventListener('click', function () {
        var extra = $('dns-extra');
        extra.innerHTML = '<div class="section-title">委派链路（根 → 顶级域 → 权威）</div><div id="delegation-list"><p class="empty">查询中…</p></div>';
        var list = $('delegation-list');
        api.dnsDelegationStream(report.domain, {
          timeoutMs: 120000,
          onEvent: function (name, payload) {
            if (name === 'step') {
              var step = payload.step;
              var div = document.createElement('div');
              div.style.cssText = 'margin-bottom:6px;font-size:11.5px';
              div.innerHTML = '<span class="mono" style="color:var(--accent-3)">' + escapeHtml(step.queriedZone) + '</span> → ' +
                escapeHtml(payload.record.server) + ' <span style="color:var(--text-mute)">' + payload.record.durationMs + ' ms</span>' +
                '<div style="color:var(--text-dim)">' + (payload.record.delegation ? '' : '') +
                (payload.record.ns ? 'NS: ' + payload.record.ns.map(escapeHtml).join(', ') : escapeHtml(payload.record.nsError || '')) + '</div>';
              if (list.querySelector('.empty')) list.innerHTML = '';
              list.appendChild(div);
            } else if (name === 'done') {
              var note = document.createElement('div');
              note.style.cssText = 'margin-top:6px;color:var(--text-mute);font-size:11.5px';
              note.textContent = payload.result.complete ? '已到达权威服务器' : (payload.result.note || '链路不完整');
              list.appendChild(note);
            }
          },
          onError: function (error) {
            if (list) list.innerHTML = '<p class="empty">追踪失败：' + escapeHtml(error.message) + '</p>';
          },
        });
      });
    }
  }

  /* ------------------------------ 导出菜单 ------------------------------ */

  function showExportMenu() {
    var existing = $('export-menu');
    if (existing) {
      existing.remove();
      return;
    }
    var menu = document.createElement('div');
    menu.id = 'export-menu';
    menu.className = 'node-card';
    menu.style.right = '18px';
    menu.style.bottom = '18px';
    menu.style.width = '260px';
    menu.innerHTML =
      '<h3 style="margin-top:0">导出当前拓扑</h3>' +
      '<div style="display:flex;flex-direction:column;gap:7px;margin-top:10px">' +
      '<button class="btn btn-ghost" data-export="json">完整数据（JSON）</button>' +
      '<button class="btn btn-ghost" data-export="csv">逐跳表格（CSV）</button>' +
      '<button class="btn btn-ghost" data-export="geojson">路线（GeoJSON）</button>' +
      '<button class="btn btn-ghost" data-export="png">地图截图（PNG）</button>' +
      '<button class="btn btn-ghost" data-export="png-white">地图截图（PNG，白底）</button>' +
      '</div>';
    document.body.appendChild(menu);

    menu.addEventListener('click', function (event) {
      var button = event.target.closest('[data-export]');
      if (!button) return;
      var kind = button.getAttribute('data-export');
      if (kind === 'json') Exporter.toJSON(state);
      else if (kind === 'csv') Exporter.toCSV(state);
      else if (kind === 'geojson') Exporter.toGeoJSON(state);
      else if (kind === 'png') Exporter.toPNG(el.canvas, state, { whiteBackground: false });
      else if (kind === 'png-white') Exporter.toPNG(el.canvas, state, { whiteBackground: true });
      menu.remove();
    });

    setTimeout(function () {
      var close = function (event) {
        if (!menu.contains(event.target)) {
          menu.remove();
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }

  /* ------------------------------ 启动 -------------------------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 便于在浏览器控制台调试
  window.NetScopeApp = {
    state: state,
    renderer: function () {
      return renderer;
    },
    trace: runTrace,
    diagnose: runDiagnose,
    refreshStats: updateStats,
    renderHopsTable: renderHopsTable,
  };
})();
