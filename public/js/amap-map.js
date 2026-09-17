/*
 * NetScope 高德地图（AMap）接入层
 *
 * 设计目标：把"底图提供商"做成可替换的一层，让绘图引擎不关心底图是内置世界地图还是高德。
 *
 *   - 底图：高德 JS API 2.0（需要 Key；安全密钥由服务端代理保管）
 *   - 覆盖物：路由节点、连线弧、局域网设备，全部用高德原生覆盖物绘制
 *   - 标签：用定位在高德容器之上的 SVG 图层绘制（与内置地图共用同一套标签逻辑）
 *
 * 未配置 Key / 脚本加载失败 / Key 无效时，自动回退到内置世界地图，
 * 并在界面上给出明确提示，绝不出现空白地图。
 */
(function () {
  'use strict';

  var SCRIPT_ID = 'netscope-amap-script';
  var loaderPromise = null;

  function cfgApi() {
    return window.NetScopeAPI;
  }

  /* ------------------------------------------------------------------ */
  /* 配置读写（前端本地保存，同时回传服务端落盘）                          */
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

  /** 当前生效凭据：本地填写的优先，其次服务端已保存的 */
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

  /* ------------------------------------------------------------------ */
  /* 脚本加载                                                            */
  /* ------------------------------------------------------------------ */

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

    loaderPromise = loadScript(url, opts.timeoutMs || 15000)
      .then(function (AMap) {
        return AMap;
      })
      .catch(function (error) {
        loaderPromise = null;
        throw error;
      });
    return loaderPromise;
  }

  /* ------------------------------------------------------------------ */
  /* 地图封装                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 创建一个高德地图实例，接口与内置 Renderer 保持"可替换"的最小集合：
   *   setTrace(hops, context) / setLanTopology(topo) / draw() / resize() /
   *   on('change', cb) / destroy()
   *
   * @param {HTMLElement} container 地图容器
   * @param {SVGElement} overlay 标签层
   * @param {{ onReady?: Function, onError?: Function, onLabelRequest?: Function }} callbacks
   */
  function createAmapView(container, overlay, callbacks) {
    var cb = callbacks || {};
    var AMap = null;
    var map = null;
    var overlays = [];
    var state = { nodes: [], arcs: [], lan: null, view: null };
    var destroyed = false;

    function clearOverlays() {
      if (!map) return;
      if (overlays.length) map.remove(overlays);
      overlays = [];
    }

    function colorFor(node) {
      var colors = window.NetScopeConfig.colors;
      // 与内置引擎保持同一套规则：颜色表达角色，时延/丢包只标记异常
      if (node.role === 'self' || node.kind === 'start') return colors.start;
      if (node.isTarget || node.role === 'internet') return colors.target;
      if (node.role === 'gateway') return '#fbbf24';
      var loss = typeof node.lossPct === 'number' ? node.lossPct : 0;
      if (loss >= 50) return colors.routeSlow;
      if (loss >= 20) return colors.routeMid;
      if (typeof node.latency === 'number' && node.latency > 180) return colors.routeSlow;
      return colors.route;
    }

    /** 连线上要显示的跳数信息（与内置引擎的 arcLabel 保持一致） */
    function hopLabelFor(from, to) {
      var parts = [];
      var ttl = to && to.ttl;
      if (typeof ttl === 'number') parts.push('第 ' + ttl + ' 跳');
      var latency = to && typeof to.latency === 'number' ? to.latency : null;
      if (latency !== null) parts.push(latency + ' ms');
      else if (to && typeof to.lossPct === 'number' && to.lossPct >= 100) parts.push('超时');
      return parts.join(' · ');
    }

    /** 清空标签层并重绘 */
    function drawLabels() {
      if (!overlay || !map) return;
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      var labels = state.labels || [];
      var ns = 'http://www.w3.org/2000/svg';
      var placed = [];
      labels.forEach(function (item) {
        if (!item.position) return;
        var point;
        try {
          point = map.lngLatToContainer(item.position);
        } catch (e) {
          return;
        }
        if (!point) return;
        var x = point.x;
        var y = point.y;
        var width = Math.min(260, String(item.text || '').length * 7 + 18);
        var height = 20;
        var left = x + 11;
        var top = y - height - 6;
        if (left + width > container.clientWidth - 6) left = Math.max(6, x - width - 11);
        if (top < 6) top = y + 10;
        for (var attempt = 0; attempt < 5; attempt += 1) {
          var overlaps = placed.some(function (r) {
            return !(left + width < r.x || left > r.x + r.w || top + height < r.y || top > r.y + r.h);
          });
          if (!overlaps) break;
          top += height + 3;
        }
        placed.push({ x: left, y: top, w: width, h: height });

        var group = document.createElementNS(ns, 'g');
        var rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', left);
        rect.setAttribute('y', top);
        rect.setAttribute('width', width);
        rect.setAttribute('height', height);
        rect.setAttribute('rx', 6);
        rect.setAttribute('fill', 'rgba(9, 17, 30, 0.86)');
        rect.setAttribute('stroke', 'rgba(56, 189, 248, 0.35)');
        group.appendChild(rect);

        var text = document.createElementNS(ns, 'text');
        text.setAttribute('x', left + 8);
        text.setAttribute('y', top + 14);
        text.setAttribute('fill', item.color || '#cfe4ff');
        text.setAttribute('font-size', '11.5');
        text.setAttribute('font-family', '"Segoe UI", "Microsoft YaHei", sans-serif');
        text.textContent = item.text;
        group.appendChild(text);
        overlay.appendChild(group);
      });
    }

    function scheduleLabelRedraw() {
      if (!overlay) return;
      if (overlay._raf) cancelAnimationFrame(overlay._raf);
      overlay._raf = requestAnimationFrame(drawLabels);
    }

    return {
      kind: 'amap',

      init: function (options) {
        var opts = options || {};
        return loadAmap({ plugins: opts.plugins || [] }).then(function (ns) {
          if (destroyed) throw new Error('视图已销毁');
          AMap = ns;
          map = new AMap.Map(container, {
            zoom: opts.zoom || 3,
            center: opts.center || [110, 32],
            viewMode: '2D',
            resizeEnable: true,
            mapStyle: opts.mapStyle || 'amap://styles/darkblue',
            showLabel: true,
            features: ['bg', 'road', 'building', 'point'],
          });
          map.on('moveend', scheduleLabelRedraw);
          map.on('zoomend', scheduleLabelRedraw);
          map.on('zoomchange', scheduleLabelRedraw);
          map.on('mapmove', scheduleLabelRedraw);
          if (cb.onReady) cb.onReady(map);
          return map;
        });
      },

      getMap: function () {
        return map;
      },

      /** 绘制路由拓扑：节点用圆形标记，连线用贝塞尔曲线 */
      setTrace: function (hops, context) {
        if (!map || !AMap) return;
        clearOverlays();
        var ctx = context || {};
        var local = (ctx.local && ctx.local.location) || null;
        var nodes = [];
        var labels = [];

        function addNode(node) {
          if (typeof node.lat !== 'number' || typeof node.lon !== 'number') return null;
          nodes.push(node);
          return node;
        }

        // 起点
        if (local && typeof local.lat === 'number') {
          addNode({
            kind: 'start',
            label: '本机',
            position: [local.lon, local.lat],
            color: colorFor({ kind: 'start' }),
            text: '本机' + (local.city ? ' · ' + local.city : ''),
            latency: 0,
          });
        }

        // 跳点：按坐标聚合
        var byKey = {};
        (hops || []).forEach(function (hop) {
          var geo = hop.geo || {};
          if (typeof geo.lat !== 'number' || typeof geo.lon !== 'number') return;
          var key = geo.lat.toFixed(3) + ',' + geo.lon.toFixed(3);
          if (!byKey[key]) {
            byKey[key] = {
              kind: 'hop',
              lat: geo.lat,
              lon: geo.lon,
              position: [geo.lon, geo.lat],
              label: geo.city || hop.hostname || hop.ip,
              subtitle: [geo.city, geo.country].filter(Boolean).join(' · '),
              hops: [],
            };
          }
          byKey[key].hops.push(hop);
        });

        var hopNodes = Object.keys(byKey).map(function (k) {
          var node = byKey[k];
          var latencies = node.hops.map(function (h) { return h.latency && h.latency.avg; }).filter(function (v) { return typeof v === 'number'; });
          var losses = node.hops.map(function (h) { return h.latency && h.latency.lossPct; }).filter(function (v) { return typeof v === 'number'; });
          node.latency = latencies.length ? latencies[latencies.length - 1] : null;
          node.lossPct = losses.length ? Math.max.apply(null, losses) : 0;
          // 节点上取该位置最后一跳的 ttl，用于连线标签显示"第 N 跳"
          var ttls = node.hops.map(function (h) { return h.ttl; }).filter(function (v) { return typeof v === 'number'; });
          node.ttl = ttls.length ? ttls[ttls.length - 1] : null;
          node.color = colorFor(node);
          node.text = (node.label || '') + (typeof node.latency === 'number' ? '  ' + node.latency + ' ms' : '');
          return node;
        });

        // 起点若与首跳重合则合并
        if (nodes.length && hopNodes.length) {
          var start = nodes[0];
          var first = hopNodes[0];
          if (Math.abs(start.position[0] - first.position[0]) < 0.02 && Math.abs(start.position[1] - first.position[1]) < 0.02) {
            start.text = '本机 / 接入点' + (typeof first.latency === 'number' ? '  ' + first.latency + ' ms' : '');
            start.latency = first.latency;
            start.lossPct = first.lossPct;
            start.ttl = first.ttl;
            hopNodes.shift();
          }
        }
        var all = nodes.concat(hopNodes);
        if (all.length) {
          all[all.length - 1].isTarget = true;
          all[all.length - 1].color = colorFor({ isTarget: true });
        }

        state.nodes = all;
        state.labels = all.map(function (n) {
          return { position: n.position, text: n.text, color: n.color };
        });

        // 标记
        var markers = all.map(function (node) {
          return new AMap.CircleMarker({
            center: node.position,
            radius: node.isTarget ? 8 : node.kind === 'start' ? 7 : 6,
            strokeColor: '#0b1220',
            strokeWeight: 2,
            fillColor: node.color,
            fillOpacity: 1,
            zIndex: 120,
          });
        });

        // 连线 + 连线上的跳数标签
        // 之前这里只画了 BezierCurve，没有标签，导致高德模式下看不到"第 N 跳 / 时延"
        var lines = [];
        var hopTexts = [];
        for (var i = 0; i < all.length - 1; i += 1) {
          var a = all[i];
          var b = all[i + 1];
          var line = new AMap.BezierCurve({
            path: [a.position, b.position],
            strokeColor: b.color,
            strokeWeight: 3,
            strokeOpacity: 0.85,
            lineJoin: 'round',
            zIndex: 100,
          });
          lines.push(line);

          var text = hopLabelFor(a, b);
          if (text) {
            var mid = [(a.position[0] + b.position[0]) / 2, (a.position[1] + b.position[1]) / 2];
            hopTexts.push(
              new AMap.Text({
                text: text,
                position: mid,
                anchor: 'center',
                offset: new AMap.Pixel(0, -6),
                zIndex: 110,
                style: {
                  'background-color': 'rgba(7, 12, 22, 0.82)',
                  'border': '1px solid ' + b.color,
                  'border-radius': '4px',
                  'color': b.color,
                  'font-size': '11px',
                  'font-family': '"Cascadia Mono", Consolas, monospace',
                  'padding': '1px 5px',
                  'white-space': 'nowrap',
                },
              }),
            );
          }
        }

        overlays = markers.concat(lines).concat(hopTexts);
        if (overlays.length) {
          map.add(overlays);
          // 把节点与连线全部纳入视野；若只有零星节点，限制最大缩放级别，
          // 避免放大到只剩街道级别、看不到地理上下文
          try {
            map.setFitView(overlays, false, [90, 90, 90, 90], 11);
          } catch (e) {
            /* ignore */
          }
        }
        scheduleLabelRedraw();
      },

      /** 绘制局域网星型拓扑 */
      setLanTopology: function (topology) {
        if (!map || !AMap) return;
        clearOverlays();
        var lan = topology || { nodes: [], links: [] };
        var gateway = lan.nodes.find(function (n) { return n.role === 'gateway'; });
        var selfNode = lan.nodes.find(function (n) { return n.role === 'self'; });
        var devices = lan.nodes.filter(function (n) { return n.role === 'device'; });

        var center = null;
        if (typeof lan.center === 'object' && lan.center) center = lan.center;
        // 局域网设备没有真实经纬度，这里用"本机公网出口位置"作为承载点，
        // 把设备以扇形展开在周围，仅用于在大地图上呈现本地网络结构。
        if (lan.anchor && typeof lan.anchor.lat === 'number') {
          center = { lat: lan.anchor.lat, lon: lan.anchor.lon };
        }
        if (!center && selfNode && selfNode.lat) center = { lat: selfNode.lat, lon: selfNode.lon };
        var anchor = center || { lat: 31.2, lon: 121.5 };

        var nodes = [];
        var labels = [];
        var radiusDeg = 0.6;
        function ringPosition(index, total, radius) {
          var angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
          return [anchor.lon + Math.cos(angle) * radius * 0.9, anchor.lat + Math.sin(angle) * radius];
        }

        // 网关在中心
        var gwPos = [anchor.lon, anchor.lat];
        nodes.push({ position: gwPos, role: 'gateway', color: '#fbbf24', radius: 9, text: (gateway && (gateway.hostname || gateway.ip)) || '网关' });
        // 设备环绕
        devices.forEach(function (device, index) {
          var pos = ringPosition(index, devices.length, radiusDeg);
          nodes.push({
            position: pos,
            role: 'device',
            color: '#38bdf8',
            radius: 6,
            text: (device.ip || '') + (device.hostname ? ' · ' + device.hostname : ''),
          });
        });
        // 本机与互联网分列上下
        nodes.push({ position: [anchor.lon, anchor.lat + radiusDeg * 0.85], role: 'self', color: '#34d399', radius: 8, text: '本机' + (selfNode && selfNode.ip ? ' · ' + selfNode.ip : '') });
        nodes.push({ position: [anchor.lon, anchor.lat - radiusDeg * 0.85], role: 'internet', color: '#f472b6', radius: 9, text: '互联网' + (lan.egressIp ? ' · ' + lan.egressIp : '') });

        var markers = nodes.map(function (node) {
          return new AMap.CircleMarker({
            center: node.position,
            radius: node.radius,
            strokeColor: '#0b1220',
            strokeWeight: 2,
            fillColor: node.color,
            fillOpacity: 1,
            zIndex: 120,
          });
        });
        var centerPos = nodes[0].position;
        var lines = nodes.slice(1).map(function (node) {
          return new AMap.Polyline({
            path: [centerPos, node.position],
            strokeColor: node.color,
            strokeWeight: 2,
            strokeOpacity: 0.75,
            strokeStyle: 'dashed',
            zIndex: 100,
          });
        });

        state.labels = nodes.map(function (n) {
          return { position: n.position, text: n.text, color: n.color };
        });

        overlays = markers.concat(lines);
        if (overlays.length) {
          map.add(overlays);
          try {
            map.setFitView(overlays, false, [120, 120, 120, 120]);
          } catch (e) {
            /* ignore */
          }
        }
        scheduleLabelRedraw();
      },

      draw: function () {
        scheduleLabelRedraw();
      },

      resize: function () {
        if (map) {
          try {
            map.resize();
          } catch (e) {
            /* ignore */
          }
          scheduleLabelRedraw();
        }
      },

      destroy: function () {
        destroyed = true;
        clearOverlays();
        if (overlay) {
          while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
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
    };
  }

  window.NetScopeAmap = {
    loadAmap: loadAmap,
    createAmapView: createAmapView,
    credentials: credentials,
    loadLocalCredentials: loadLocalCredentials,
    saveLocalCredentials: saveLocalCredentials,
    authHeaders: authHeaders,
    isConfigured: function () {
      return Boolean(credentials().key);
    },
  };
})();
