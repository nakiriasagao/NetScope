/*
 * NetScope · 高德底图 + 内置引擎拓扑叠加层
 *
 * 目的：让"高德底图"与"内置世界地图"的拓扑样式**完全一致**。
 *
 * 做法：高德只负责画底图（瓦片、路网、中文标注），
 *       节点、连线、标签、动画全部交给内置的 Renderer 绘制到一个透明 canvas 上，
 *       该 canvas 盖在高德容器之上。
 *
 * 这样两个模式共用同一套绘制代码（drawArcs / drawNodes / drawOverlay），
 * 节点半径、光晕、连线弧度、光点动画、标签样式天然一致，不存在"两套样式对不齐"的问题。
 *
 * 坐标换算：AMap 提供 lngLatToContainer()，把经纬度换成容器内像素坐标；
 *           它返回的坐标就是 canvas 的 CSS 像素坐标（容器与 canvas 同尺寸、同原点），
 *           因此直接写入 node.sx / node.sy 即可。
 */
(function () {
  'use strict';

  var SCRIPT_ID = 'netscope-amap-script';
  var loaderPromise = null;

  /* ------------------------------------------------------------------ */
  /* 凭据与脚本加载（与之前保持一致）                                      */
  /* ------------------------------------------------------------------ */

  var STORAGE_KEY = 'netscope.amap.credentials';

  function loadLocalCredentials() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { key: '', security: '', enabled: true };
      var parsed = JSON.parse(raw);
      return {
        key: String(parsed.key || ''),
        security: String(parsed.security || ''),
        enabled: parsed.enabled === undefined ? true : Boolean(parsed.enabled),
      };
    } catch (e) {
      return { key: '', security: '', enabled: true };
    }
  }

  function saveLocalCredentials(credentials) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
    } catch (e) {
      /* 隐私模式下可能失败，忽略即可（服务端仍会保存） */
    }
  }

  function credentials() {
    return loadLocalCredentials();
  }

  /** 把凭据附加到请求头，供服务端代理使用 */
  function authHeaders() {
    var cred = credentials();
    var headers = {};
    if (cred.key) headers['x-amap-key'] = cred.key;
    if (cred.security) headers['x-amap-security'] = cred.security;
    return headers;
  }

  function loadScript(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var existing = document.getElementById(SCRIPT_ID);
      if (existing) existing.parentNode.removeChild(existing);
      var script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = url;
      script.async = true;
      var timer = setTimeout(function () {
        reject(new Error('加载高德 JS API 超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
      }, timeoutMs || 15000);
      script.onload = function () {
        clearTimeout(timer);
        if (window.AMap) resolve(window.AMap);
        else reject(new Error('脚本已加载但未注册 window.AMap'));
      };
      script.onerror = function () {
        clearTimeout(timer);
        reject(new Error('高德 JS API 脚本加载失败（网络不可达或 Key 被拒绝）'));
      };
      document.head.appendChild(script);
    });
  }

  /**
   * 加载高德 JS API（带缓存，只加载一次）
   * @returns {Promise<any>} AMap 命名空间
   */
  function loadAmap(options) {
    var opts = options || {};
    if (window.AMap && window.AMap.Map) return Promise.resolve(window.AMap);
    if (loaderPromise) return loaderPromise;

    var cred = credentials();
    if (!cred.key) {
      return Promise.reject(new Error('尚未配置高德 Key，请点击右上角 ⚙ 设置'));
    }

    // 安全密钥必须在使用 JS API 之前设置到 window._AMapSecurityConfig
    if (cred.security) {
      window._AMapSecurityConfig = { securityJsCode: cred.security };
    }

    var url = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(cred.key);
    if (opts.plugins && opts.plugins.length) {
      url += '&plugin=' + opts.plugins.join(',');
    }

    loaderPromise = loadScript(url, opts.timeoutMs || 15000).catch(function (error) {
      loaderPromise = null;
      throw error;
    });
    return loaderPromise;
  }

  /* ------------------------------------------------------------------ */
  /* 视图：高德底图 + 内置引擎叠加层                                      */
  /* ------------------------------------------------------------------ */

  /**
   * @param {{ host: HTMLElement, overlayCanvas: HTMLCanvasElement, labelLayer: SVGElement, renderer: object, callbacks?: object }} config
   *   - host：高德地图容器（专用，避免 destroy 影响其它元素）
   *   - overlayCanvas：叠加的绘制层（由内置 Renderer 驱动）
   *   - labelLayer：SVG 标签层
   *   - renderer：内置 NetScopeDraw.Renderer 实例（复用其绘制逻辑）
   */
  function createOverlayView(config) {
    var host = config.host;
    var overlayCanvas = config.overlayCanvas;
    var labelLayer = config.labelLayer;
    var renderer = config.renderer;
    var cb = config.callbacks || {};

    // 进入高德模式前的渲染目标，销毁时用于复原
    var originalCanvas = renderer.canvas;
    var originalOverlay = renderer.overlay;
    var originalMode = renderer.mode;

    var AMap = null;
    var map = null;
    var destroyed = false;
    var suspended = false;
    var animFrame = null;
    var lastNodes = null;
    var lastContext = null;

    /** 把每个节点的经纬度换算成容器内像素坐标，写入 node.sx / node.sy */
    function reproject() {
      if (!map) return;
      var nodes = renderer.nodes || [];
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (typeof node.lat !== 'number' || typeof node.lon !== 'number') continue;
        var point = null;
        try {
          point = map.lngLatToContainer([node.lon, node.lat]);
        } catch (e) {
          point = null;
        }
        if (point && typeof point.x === 'number') {
          node.sx = point.x;
          node.sy = point.y;
        }
      }
    }

    function loop() {
      if (destroyed || suspended) return;
      renderer.draw();
      animFrame = requestAnimationFrame(loop);
    }

    /**
     * 挂起 / 恢复：用于「逻辑拓扑」视图——该视图由内置引擎绘制，
     * 但**不改变用户的底图选择**（恢复后仍回到高德地图）。
     *
     * 注意：挂起时除了把渲染目标交还内置画布，**还必须让内置画布真正可见**。
     * 高德模式下内置画布是 hidden + display:none（尺寸为 0），
     * 只切渲染目标而不取消隐藏，就会出现"数据画了但什么都看不到"。
     * 画布也因此需要重新量尺寸（隐藏元素量不到尺寸）。
     */
    function setSuspended(next) {
      if (destroyed) return;
      suspended = Boolean(next);

      if (suspended) {
        if (animFrame) cancelAnimationFrame(animFrame);
        animFrame = null;
        if (host) host.hidden = true;
        if (overlayCanvas) overlayCanvas.hidden = true;
        // 交还渲染目标并显示内置画布
        renderer.plain = false;
        renderer.reproject = null;
        renderer.canvas = originalCanvas;
        renderer.overlay = originalOverlay;
        if (originalCanvas) {
          originalCanvas.hidden = false;
          // 画布元素可能被替换过，resize 内部会重新获取上下文
          renderer.ctx = originalCanvas.getContext('2d');
        }
        if (originalOverlay) originalOverlay.hidden = false;
        if (labelLayer) {
          while (labelLayer.firstChild) labelLayer.removeChild(labelLayer.firstChild);
        }
        renderer.stopAnimation();
        // 之前隐藏时尺寸为 0，这里必须重新量取
        renderer.resize();
        return;
      }

      if (host) host.hidden = false;
      if (overlayCanvas) overlayCanvas.hidden = false;
      // 内置画布重新隐藏，交给叠加层绘制
      if (originalCanvas) originalCanvas.hidden = true;
      renderer.canvas = overlayCanvas;
      renderer.overlay = labelLayer;
      renderer.ctx = overlayCanvas.getContext('2d');
      renderer.plain = true;
      renderer.reproject = reproject;
      renderer.mode = 'map';
      renderer.resize();
      try {
        if (map) map.resize();
      } catch (e) {
        /* ignore */
      }
      reproject();
      renderer.draw();
      loop();
    }

    /** 把当前拓扑纳入视野（自己算包围盒，避免依赖高德覆盖物） */
    function fitToNodes() {
      if (!map) return;
      var list = (renderer.nodes || []).filter(function (n) {
        return typeof n.lat === 'number' && typeof n.lon === 'number';
      });
      if (!list.length) return;
      var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      list.forEach(function (n) {
        minLat = Math.min(minLat, n.lat);
        maxLat = Math.max(maxLat, n.lat);
        minLon = Math.min(minLon, n.lon);
        maxLon = Math.max(maxLon, n.lon);
      });
      try {
        if (list.length === 1 || (maxLat - minLat < 0.05 && maxLon - minLon < 0.05)) {
          // 只有一个点或点高度重合：给一个合适的城市级缩放
          map.setZoomAndCenter(11, [(minLon + maxLon) / 2, (minLat + maxLat) / 2]);
          return;
        }
        map.setBounds(new AMap.Bounds([minLon, minLat], [maxLon, maxLat]), false, [90, 90, 90, 90], 12);
      } catch (e) {
        /* 视野自适应失败不影响显示 */
      }
    }

    return {
      kind: 'amap-overlay',

      init: function (options) {
        var opts = options || {};
        return loadAmap({ plugins: opts.plugins || [] }).then(function (ns) {
          if (destroyed) throw new Error('视图已销毁');
          AMap = ns;
          map = new AMap.Map(host, {
            zoom: opts.zoom || 4,
            center: opts.center || [110, 32],
            viewMode: '2D',
            resizeEnable: true,
            mapStyle: opts.mapStyle || 'amap://styles/darkblue',
            showLabel: true,
            features: ['bg', 'road', 'building', 'point'],
          });
          // 叠加层接管拓扑绘制，关闭自己的动画循环（改由本视图统一驱动）
          renderer.plain = true;
          renderer.reproject = reproject;
          renderer.mode = 'map';
          renderer.lanMode = false;
          renderer.stopAnimation();
          overlayCanvas.hidden = false;
          // 尺寸与容器对齐（含高分屏）
          renderer.canvas = overlayCanvas;
          renderer.overlay = labelLayer;
          renderer.resize();

          map.on('mapmove', function () { renderer.draw(); });
          map.on('zoomchange', function () { renderer.draw(); });
          map.on('moveend', function () { renderer.draw(); });
          map.on('zoomend', function () { renderer.draw(); });

          if (cb.onReady) cb.onReady(map);
          // 启动统一动画循环（呼吸光晕 + 数据包流动）
          loop();
          return map;
        });
      },

      getMap: function () {
        return map;
      },

      /**
       * 设置追踪数据：复用内置引擎的 setTrace。
       * 注意合并规则必须与当前视图一致：
       *   高德只呈现地理视图（map），按坐标合并；
       *   但渲染器可能同时被逻辑拓扑视图使用（挂起高德时），
       *   若这里强行按坐标合并，会把已经按跳展开的数据覆盖成合并后的少量节点，
       *   于是"高德模式下的逻辑拓扑"只剩下几个点。
       */
      setTrace: function (hops, context) {
        if (!map) return;
        lastNodes = hops;
        lastContext = context;
        var graph = !suspended && renderer.mode === 'graph';
        renderer.setTrace(hops, {
          local: context && context.local,
          target: context && context.target,
          merge: !graph,
        });
        reproject();
        renderer.draw();
        fitToNodes();
      },

      /** 局域网星型拓扑：同样复用内置引擎 */
      setLanTopology: function (topology) {
        if (!map) return;
        renderer.setLanTopology(topology);
        reproject();
        renderer.draw();
      },

      /** 聚焦到某个节点（经纬度） */
      focusNode: function (node) {
        if (!map || !node || typeof node.lat !== 'number') return;
        try {
          map.setZoomAndCenter(Math.max(map.getZoom(), 6), [node.lon, node.lat]);
        } catch (e) {
          /* ignore */
        }
      },

      draw: function () {
        if (!destroyed && !suspended) renderer.draw();
      },

      /** 逻辑拓扑视图期间挂起高德（不改变用户选择的底图） */
      suspend: function () {
        setSuspended(true);
      },

      /** 恢复高德底图 */
      resume: function () {
        setSuspended(false);
      },

      isSuspended: function () {
        return suspended;
      },

      /** 内置画布（挂起时渲染到这里） */
      getInnerCanvas: function () {
        return originalCanvas;
      },

      resize: function () {
        if (!map) return;
        try {
          map.resize();
        } catch (e) {
          /* ignore */
        }
        renderer.resize();
        reproject();
        renderer.draw();
      },

      destroy: function () {
        destroyed = true;
        if (animFrame) cancelAnimationFrame(animFrame);
        animFrame = null;
        // 关键：把渲染目标复原回内置画布。
        // 否则 renderer 会继续往这个（已隐藏的）叠加层上画，
        // 表现为"切回内置世界地图后只有底图、看不到拓扑"，再次探测也看不到更新。
        if (originalCanvas) renderer.canvas = originalCanvas;
        if (originalOverlay) renderer.overlay = originalOverlay;
        renderer.plain = false;
        renderer.reproject = null;
        if (originalMode) renderer.mode = originalMode;
        renderer.stopAnimation();
        if (overlayCanvas) {
          overlayCanvas.hidden = true;
          try {
            var ctx = overlayCanvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
          } catch (e) {
            /* ignore */
          }
        }
        if (labelLayer) {
          while (labelLayer.firstChild) labelLayer.removeChild(labelLayer.firstChild);
        }
        if (map) {
          try {
            map.destroy();
          } catch (e) {
            /* ignore */
          }
          map = null;
        }
      },

      /** 重新把上一次的数据画一遍（切回时用不到，但保留接口对称） */
      redrawLast: function () {
        if (lastNodes && map) this.setTrace(lastNodes, lastContext);
      },
    };
  }

  window.NetScopeAmap = {
    loadAmap: loadAmap,
    createOverlayView: createOverlayView,
    credentials: credentials,
    loadLocalCredentials: loadLocalCredentials,
    saveLocalCredentials: saveLocalCredentials,
    authHeaders: authHeaders,
    isConfigured: function () {
      return Boolean(credentials().key);
    },
  };
})();
