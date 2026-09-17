/*
 * NetScope 绘图引擎
 *
 * 两种视图：
 *   1) 世界地图视图：把每一跳按经纬度投影到等距圆柱世界地图上，用弧线连接成完整路径，
 *      弧线颜色表达延迟/丢包，并沿弧线绘制流动的数据包动画。
 *   2) 逻辑拓扑视图：力导向 / 链式布局，突出"本机 → 路由器 → 骨干 → 目标"的层级关系。
 *
 * 世界地图数据（public/data/world-110m.json）在构建期已完成 TopoJSON 解码与等距圆柱投影，
 * 前端只需线性缩放即可绘制，运行时不再依赖任何地图库或外部 CDN。
 *
 * 坐标约定：
 *   - 世界坐标：以 world.width × world.height 为基准的画布坐标（左上角为原点）
 *   - 屏幕坐标：世界坐标经 view.scale / view.offset 变换后的 Canvas 像素坐标
 */
(function () {
  'use strict';

  var cfg = window.NetScopeConfig;
  var COLORS = cfg.colors;

  /** 数值钳制 */
  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  // ------------------------------------------------------------------
  // 画布渲染器
  // ------------------------------------------------------------------

  function Renderer(canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = window.devicePixelRatio || 1;

    this.world = null;
    this.view = { scale: 1, offsetX: 0, offsetY: 0 };
    this.mode = 'map';

    this.nodes = [];
    this.arcs = [];
    this.unlocated = [];
    this.stats = null;
    this.hovered = null;
    this.selected = null;
    this.options = {
      showLabels: true,
      showLinks: true,
      showGrid: false,
      animate: true,
      night: false,
      colorBy: 'latency',
    };
    this.animation = { running: false, startedAt: 0, frame: null };
  }

  Renderer.prototype.setWorld = function (world) {
    this.world = world;
    this.fitToContainer();
  };

  /** 按容器尺寸重设画布（含高分屏适配） */
  Renderer.prototype.resize = function () {
    // 防御：容器或画布可能已被移除/隐藏（例如切换底图过程中），此时直接跳过而不是抛错
    var parent = this.canvas && this.canvas.parentElement;
    if (!this.canvas || !parent || typeof parent.getBoundingClientRect !== 'function') return;
    // 关键：画布元素可能被替换过（例如切到高德底图时改为绘制到叠加层），
    // 此时必须重新获取 2D 上下文，否则绘制内容仍然落在旧画布上
    if (!this.ctx || this.ctx.canvas !== this.canvas) {
      this.ctx = this.canvas.getContext('2d');
    }
    var rect = parent.getBoundingClientRect();
    var w = Math.max(320, Math.floor(rect.width));
    var h = Math.max(240, Math.floor(rect.height));
    this.dpr = window.devicePixelRatio || 1;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.overlay) {
      this.overlay.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      this.overlay.setAttribute('width', w);
      this.overlay.setAttribute('height', h);
    }
    this.invalidateOverlay();
  };

  /** 让整幅世界地图刚好铺满画布 */
  Renderer.prototype.fitToContainer = function () {
    if (!this.world) return;
    var margin = 10;
    var sx = (this.width - margin * 2) / this.world.width;
    var sy = (this.height - margin * 2) / this.world.height;
    var scale = Math.min(sx, sy);
    this.view.scale = scale;
    this.view.offsetX = (this.width - this.world.width * scale) / 2;
    this.view.offsetY = (this.height - this.world.height * scale) / 2;
    this.draw();
  };

  /**
   * 聚焦到当前节点集合的包围盒
   *
   * 说明：
   *  - 只使用"有真实经纬度"的节点参与取景；无法定位的跳点不参与，
   *    否则会把视野整体拉偏到没有数据的地方。
   *  - 设有最小视野跨度，避免同城连续几跳把地图放大到失去地理背景。
   */
  Renderer.prototype.fitToNodes = function () {
    var points = this.nodes
      .filter(function (n) {
        return typeof n.x === 'number' && typeof n.y === 'number' && typeof n.lat === 'number';
      })
      .map(function (n) {
        return [n.x, n.y];
      });
    if (!points.length || !this.world) {
      this.fitToContainer();
      return;
    }

    var xs = points.map(function (p) { return p[0]; });
    var ys = points.map(function (p) { return p[1]; });
    var minX = Math.min.apply(null, xs);
    var maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys);
    var maxY = Math.max.apply(null, ys);

    // 最小视野跨度：至少覆盖 30° 经度、约 14° 纬度
    var minSpanX = this.world.width / 12;
    var minSpanY = this.world.height / 12;
    if (maxX - minX < minSpanX) {
      var centerX = (minX + maxX) / 2;
      minX = centerX - minSpanX / 2;
      maxX = centerX + minSpanX / 2;
    }
    if (maxY - minY < minSpanY) {
      var centerY = (minY + maxY) / 2;
      minY = centerY - minSpanY / 2;
      maxY = centerY + minSpanY / 2;
    }

    var pad = 80;
    var spanX = Math.max(maxX - minX, 60);
    var spanY = Math.max(maxY - minY, 60);
    var scale = Math.min((this.width - pad * 2) / spanX, (this.height - pad * 2) / spanY);
    scale = clamp(scale, Math.min(this.view.scale, 0.5), 2.6);
    var cx = (minX + maxX) / 2;
    var cy = (minY + maxY) / 2;
    this.view.scale = scale;
    this.view.offsetX = this.width / 2 - cx * scale;
    this.view.offsetY = this.height / 2 - cy * scale;
    this.clampView();
    this.draw();
  };

  /**
   * 限制视图平移，保证地图始终有足够部分可见
   *
   * 为什么必须有：若不加限制，持续拖动会把地图完全拖出视野，
   * 用户面对的是一片空白画布且无法自行恢复（只能刷新页面）。
   * 这里让地图边缘最多移动到距画布边缘 50% 处，始终保留至少一半可视区域。
   */
  Renderer.prototype.clampView = function () {
    if (!this.world) return;
    var mapW = this.world.width * this.view.scale;
    var mapH = this.world.height * this.view.scale;
    var marginX = Math.min(this.width * 0.5, mapW * 0.5);
    var marginY = Math.min(this.height * 0.5, mapH * 0.5);
    this.view.offsetX = clamp(this.view.offsetX, -mapW + marginX, this.width - marginX);
    this.view.offsetY = clamp(this.view.offsetY, -mapH + marginY, this.height - marginY);
  };

  /** 以某个屏幕点为锚点缩放（滚轮缩放） */
  Renderer.prototype.zoomAt = function (screenX, screenY, factor) {
    var next = clamp(this.view.scale * factor, 0.25, 12);
    var k = next / this.view.scale;
    this.view.offsetX = screenX - (screenX - this.view.offsetX) * k;
    this.view.offsetY = screenY - (screenY - this.view.offsetY) * k;
    this.view.scale = next;
    this.clampView();
    this.draw();
  };

  /** 平移视图（拖动地图） */
  Renderer.prototype.panBy = function (dx, dy) {
    this.view.offsetX += dx;
    this.view.offsetY += dy;
    this.clampView();
    this.draw();
  };

  // ------------------------------------------------------------------
  // 坐标换算
  // ------------------------------------------------------------------

  /** 经纬度 → 世界坐标 */
  Renderer.prototype.project = function (lon, lat) {
    if (!this.world) return { x: 0, y: 0 };
    var x = ((lon - this.world.lonMin) / (this.world.lonMax - this.world.lonMin)) * this.world.width;
    var clampedLat = clamp(lat, this.world.latMin, this.world.latMax);
    var y = ((this.world.latMax - clampedLat) / (this.world.latMax - this.world.latMin)) * this.world.height;
    return { x: x, y: y };
  };

  /** 世界坐标 → 屏幕坐标 */
  Renderer.prototype.toScreen = function (x, y) {
    return { x: x * this.view.scale + this.view.offsetX, y: y * this.view.scale + this.view.offsetY };
  };

  /** 屏幕坐标 → 世界坐标 */
  Renderer.prototype.toWorld = function (screenX, screenY) {
    return { x: (screenX - this.view.offsetX) / this.view.scale, y: (screenY - this.view.offsetY) / this.view.scale };
  };

  /**
   * 节点在屏幕上的位置
   *   - 逻辑拓扑：使用布局坐标
   *   - 叠加模式（plain，高德底图）：使用由外部投影钩子写入的 sx/sy
   *   - 世界地图：世界坐标经视图变换
   */
  Renderer.prototype.nodeScreen = function (node) {
    if (this.mode === 'graph') return { x: node.lx, y: node.ly };
    if (this.plain) return { x: node.sx, y: node.sy };
    return this.toScreen(node.x, node.y);
  };

  // ------------------------------------------------------------------
  // 数据装载
  // ------------------------------------------------------------------

  function isValidGeo(geo) {
    return Boolean(
      geo &&
        typeof geo.lat === 'number' &&
        typeof geo.lon === 'number' &&
        isFinite(geo.lat) &&
        isFinite(geo.lon) &&
        geo.lat >= -90 &&
        geo.lat <= 90 &&
        geo.lon >= -180 &&
        geo.lon <= 180,
    );
  }

  function maxTtl(node) {
    var values = (node.hops || [])
      .map(function (h) { return h.ttl; })
      .filter(function (v) { return typeof v === 'number'; });
    return values.length ? Math.max.apply(null, values) : null;
  }

  function minTtl(node) {
    var values = (node.hops || [])
      .map(function (h) { return h.ttl; })
      .filter(function (v) { return typeof v === 'number'; });
    return values.length ? Math.min.apply(null, values) : null;
  }

  function firstLocalIP(local) {
    if (!local || !Array.isArray(local.interfaces)) return null;
    var v4 = local.interfaces.filter(function (i) { return i.family === 'IPv4'; });
    return v4.length ? v4[0].address : null;
  }

  function uniq(list) {
    var seen = {};
    return list.filter(function (item) {
      if (seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  /**
   * 用后端返回的跳点数据构建渲染节点
   *
   * 核心规则（也是本工具的关键设计）：**只有能确定地理位置的节点才参与拓扑连线**。
   * 无法定位的跳点（探测超时、专网地址、离线且不在内置库范围内）会被单独记录下来，
   * 在地图上既不画点也不连线，只在统计栏与详情面板中提示"有 N 跳未能定位"，
   * 从根本上避免出现"跨越未定位节点"的假连线。
   *
   * @param {Array} hops 路由跳点（可含 geo 字段）
   * @param {{ local?: object, target?: object }} context
   */
  /**
   * 设置追踪数据并生成拓扑节点
   *
   * @param {Array} hops 逐跳数据
   * @param {object} context { local, target, merge }
   *   merge 默认 true：同一地理坐标的多个跳点合并为一个节点（世界地图视图，
   *     避免同城多跳重叠成一堆标记）。
   *   merge=false：**每一跳各成一个节点**（逻辑拓扑视图，
   *     否则"上海 6 跳"会被合并成 1 个点，看起来像拓扑没显示出来）。
   */
  Renderer.prototype.setTrace = function (hops, context) {
    var self = this;
    var ctx = context || {};
    var mergeSameLocation = ctx.merge !== false;
    var nodes = [];
    var unlocated = [];

    (hops || []).forEach(function (hop) {
      var geo = hop.geo || null;
      if (!isValidGeo(geo)) {
        unlocated.push({
          ttl: hop.ttl,
          ip: hop.ip || null,
          hostname: hop.hostname || null,
          isTimeout: Boolean(hop.isTimeout),
          reason: !hop.ip
            ? '该跳未响应探测，没有可定位的地址'
            : (geo && geo.status === 'unknown'
                ? (geo.note || '地理定位服务不可用')
                : (geo && geo.status === 'invalid' ? '地址非法，无法定位' : '缺少地理定位数据')),
          hop: hop,
        });
        return;
      }

      var key = geo.lat.toFixed(2) + ',' + geo.lon.toFixed(2);
      var existing = null;
      if (mergeSameLocation) {
        for (var i = 0; i < nodes.length; i += 1) {
          if (nodes[i].geoKey === key) {
            existing = nodes[i];
            break;
          }
        }
      }
      if (!existing) {
        var point = self.project(geo.lon, geo.lat);
        existing = {
          kind: 'hop',
          geoKey: mergeSameLocation ? key : key + '#' + hop.ttl,
          lat: geo.lat,
          lon: geo.lon,
          x: point.x,
          y: point.y,
          city: geo.city || null,
          country: geo.country || null,
          countryCode: geo.countryCode || null,
          isp: geo.isp || null,
          asn: geo.asn || null,
          provider: geo.provider || null,
          precision: geo.precision || null,
          geoStatus: geo.status || 'public',
          hops: [],
        };
        nodes.push(existing);
      }
      existing.hops.push(hop);
    });

    // 节点标签：优先城市，其次主机名，最后 IP
    // 不合并时（逻辑拓扑）同一城市会有多个节点，标签加上序号以便区分
    var labelCounter = {};
    nodes.forEach(function (node) {
      var first = node.hops[0] || {};
      var baseLabel = node.city || first.hostname || first.ip || '节点';
      if (!mergeSameLocation) {
        labelCounter[baseLabel] = (labelCounter[baseLabel] || 0) + 1;
        if (labelCounter[baseLabel] > 1) baseLabel = baseLabel + ' #' + labelCounter[baseLabel];
      }
      node.label = baseLabel;
      node.subtitle = [node.city, node.country].filter(Boolean).join(' · ') || (first.ip || '');
    });

    // 起点：本机（或本机所在城市）
    var localGeo = (ctx.local && ctx.local.location) || null;
    if (isValidGeo(localGeo)) {
      var startKey = localGeo.lat.toFixed(2) + ',' + localGeo.lon.toFixed(2);
      var sameLocation = null;
      for (var j = 0; j < nodes.length; j += 1) {
        if (nodes[j].geoKey === startKey) {
          sameLocation = nodes[j];
          break;
        }
      }
      var startSubtitle = (ctx.local.hostname || '') + (localGeo.city ? ' · ' + localGeo.city : '');
      if (sameLocation) {
        // 第一跳与本机落在同一位置（内网地址按公网出口落点时会这样）→ 合并为一个节点，
        // 避免重叠标记与零长度连线
        sameLocation.kind = 'start';
        sameLocation.isStart = true;
        sameLocation.label = '本机 / 接入点';
        sameLocation.ip = firstLocalIP(ctx.local);
        sameLocation.subtitle = startSubtitle;
        nodes.splice(nodes.indexOf(sameLocation), 1);
        nodes.unshift(sameLocation);
      } else {
        var startPoint = this.project(localGeo.lon, localGeo.lat);
        nodes.unshift({
          kind: 'start',
          isStart: true,
          geoKey: startKey,
          label: '本机',
          subtitle: startSubtitle,
          ip: firstLocalIP(ctx.local),
          lat: localGeo.lat,
          lon: localGeo.lon,
          x: startPoint.x,
          y: startPoint.y,
          city: localGeo.city || null,
          country: localGeo.country || null,
          provider: localGeo.source || null,
          geoStatus: 'private',
          hops: [],
        });
      }
    }

    // 目标标记：落在最后一个"有定位"的节点上
    if (nodes.length) {
      var last = nodes[nodes.length - 1];
      last.isTarget = true;
      if (last.kind !== 'start') last.kind = 'target';
      if (ctx.target && ctx.target.host) {
        last.subtitle = (last.subtitle ? last.subtitle + ' · ' : '') + '目标 ' + (ctx.target.primaryIP || ctx.target.host);
      }
    }

    // 逐节点汇总延迟与丢包
    nodes.forEach(function (node, index) {
      node.index = index;
      var hopsList = node.hops || [];
      var latencies = hopsList
        .map(function (h) { return h.latency && h.latency.avg; })
        .filter(function (v) { return typeof v === 'number'; });
      node.latency = latencies.length ? latencies[latencies.length - 1] : (node.isStart ? 0 : null);
      node.minLatency = latencies.length ? Math.min.apply(null, latencies) : null;
      var losses = hopsList
        .map(function (h) { return h.latency && h.latency.lossPct; })
        .filter(function (v) { return typeof v === 'number'; });
      node.lossPct = losses.length ? Math.max.apply(null, losses) : 0;
      node.ttl = hopsList.length ? hopsList[0].ttl : null;
    });

    this.nodes = nodes;
    this.unlocated = unlocated;
    this.invalidateOverlay();

    // 连线：只连接"有序的、能定位的"节点，未定位跳点自然被跳过
    this.arcs = [];
    for (var k = 0; k < nodes.length - 1; k += 1) {
      this.arcs.push({ from: nodes[k], to: nodes[k + 1], index: k, skipped: 0 });
    }
    // 标注每条连线之间被跳过（未定位）的跳点数量
    this.arcs.forEach(function (arc) {
      var fromTtl = maxTtl(arc.from);
      var toTtl = minTtl(arc.to);
      if (fromTtl === null || toTtl === null) return;
      arc.skipped = unlocated.filter(function (u) {
        return typeof u.ttl === 'number' && u.ttl > fromTtl && u.ttl < toTtl;
      }).length;
    });

    // 统计指标
    var allLatencies = [];
    var totalLoss = 0;
    var respondedHops = 0;
    (hops || []).forEach(function (hop) {
      if (hop.latency && typeof hop.latency.avg === 'number') {
        allLatencies.push(hop.latency.avg);
        respondedHops += 1;
      }
      totalLoss += (hop.latency && hop.latency.lossPct) || 0;
    });

    this.stats = {
      hopCount: (hops || []).length,
      respondedHops: respondedHops,
      avgRtt: allLatencies.length
        ? Math.round((allLatencies.reduce(function (a, b) { return a + b; }, 0) / allLatencies.length) * 10) / 10
        : null,
      maxRtt: allLatencies.length ? Math.max.apply(null, allLatencies) : null,
      lossPct: (hops || []).length ? Math.round((totalLoss / hops.length) * 10) / 10 : 0,
      countries: uniq(nodes.map(function (n) { return n.country; }).filter(Boolean)),
      locatedCount: nodes.length,
      unlocatedCount: unlocated.length,
    };

    if (this.mode === 'graph') this.layoutLogical();
    else this.startAnimation();
    this.invalidateOverlay();
    this.draw();
  };

  // ------------------------------------------------------------------
  // 局域网星型拓扑
  // ------------------------------------------------------------------

  /**
   * 绘制"当前网络"的星型拓扑：以网关为中心，设备环绕四周，本机与互联网分列上下。
   *
   * 为什么用星型而不是地理投影：
   *   局域网设备使用私有地址（192.168.x.x 等），在真实地理上没有对应位置，
   *   把它们画到世界地图上等于伪造坐标。星型拓扑表达的是"连接关系"，
   *   这才是本地网络真正需要看清的结构。
   *
   * @param {{ nodes: Array, links: Array, subnet?: string, byType?: object }} topology
   */
  Renderer.prototype.setLanTopology = function (topology) {
    var self = this;
    var topo = topology || { nodes: [], links: [] };
    var gateway = null;
    var selfNode = null;
    var internet = null;
    var devices = [];

    (topo.nodes || []).forEach(function (node) {
      if (node.role === 'gateway') gateway = node;
      else if (node.role === 'self') selfNode = node;
      else if (node.role === 'internet') internet = node;
      else devices.push(node);
    });

    var cx = this.width / 2;
    var cy = this.height / 2;
    // 半径必须留出边距：节点贴着画布边缘时标签会被裁掉。
    // 这里保证横向至少留 78px、纵向至少留 64px。
    var radius = Math.max(70, Math.min(this.width / 2 - 78, (this.height / 2 - 64) / 0.8, Math.min(this.width, this.height) * 0.36));
    var nodes = [];
    var arcs = [];

    function makeNode(raw, x, y, kind) {
      var node = {
        kind: kind,
        label: raw.label || raw.hostname || raw.ip || '设备',
        subtitle: [raw.ip, raw.vendor].filter(Boolean).join(' · '),
        ip: raw.ip || null,
        mac: raw.mac || null,
        vendor: raw.vendor || null,
        hostname: raw.hostname || null,
        deviceType: raw.type || null,
        typeLabel: raw.typeLabel || null,
        ssdp: raw.ssdp || null,
        mdns: raw.mdns || null,
        lx: x,
        ly: y,
        x: x,
        y: y,
        latency: null,
        hops: [],
      };
      node.geoStatus = kind === 'device' ? 'public' : 'private';
      return node;
    }

    var gatewayNode = gateway
      ? makeNode(gateway, cx, cy, 'gateway')
      : makeNode({ label: '网关（未识别）', hostname: '网关' }, cx, cy, 'gateway');
    gatewayNode.isGateway = true;
    nodes.push(gatewayNode);

    if (selfNode) {
      var selfRendered = makeNode(selfNode, cx, Math.max(40, cy - radius * 0.85), 'start');
      selfRendered.isStart = true;
      nodes.push(selfRendered);
      arcs.push({ from: selfRendered, to: gatewayNode, index: 0, skipped: 0, kind: 'uplink' });
    }

    if (internet) {
      var internetNode = makeNode(internet, cx, Math.min(this.height - 40, cy + radius * 0.85), 'internet');
      internetNode.isTarget = true;
      nodes.push(internetNode);
      arcs.push({ from: gatewayNode, to: internetNode, index: 1, skipped: 0, kind: 'wan' });
    }

    devices.forEach(function (device, index) {
      var total = Math.max(1, devices.length);
      var angle = ((index + 0.5) / total) * Math.PI * 2 - Math.PI / 2;
      // 两个同心环，避免设备太多时标签互相重叠
      var ring = index % 2 === 0 ? radius : radius * 0.72;
      var x = clamp(cx + Math.cos(angle) * ring, 70, self.width - 70);
      var y = clamp(cy + Math.sin(angle) * ring * 0.8, 58, self.height - 58);
      var node = makeNode(device, x, y, 'device');
      node.deviceIndex = index;
      nodes.push(node);
      arcs.push({ from: gatewayNode, to: node, index: index + 2, skipped: 0, kind: 'lan' });
    });

    nodes.forEach(function (node, index) {
      node.index = index;
    });

    this.nodes = nodes;
    this.arcs = arcs;
    this.unlocated = [];
    this.lanMode = true;
    this.mode = 'graph';
    this.invalidateOverlay();
    this.stats = {
      hopCount: devices.length,
      locatedCount: devices.length,
      unlocatedCount: 0,
      avgRtt: null,
      maxRtt: null,
      lossPct: 0,
      countries: [],
      lan: { subnet: topo.subnet || null, deviceCount: devices.length, byType: topo.byType || {} },
    };
    // 星型拓扑同样保留流动光点动画，与探测逻辑拓扑保持一致
    if (this.options.animate) this.startAnimation();
    else this.stopAnimation();
    this.invalidateOverlay();
    this.draw();
  };

  // ------------------------------------------------------------------
  // 逻辑拓扑布局（力导向）
  // ------------------------------------------------------------------

  Renderer.prototype.layoutLogical = function () {
    var nodes = this.nodes;
    if (!nodes.length) return;
    var cx = this.width / 2;
    var cy = this.height / 2;
    var count = nodes.length;

    // 链式初始布局横向铺满可用宽度，并加入微小确定性扰动：
    // 避免"所有跳点同城"时初始位置完全重合导致力导向退化到中心一点。
    var spread = Math.max(Math.min(this.width * 0.78, count * 132), 240);
    nodes.forEach(function (node, index) {
      var t = count > 1 ? index / (count - 1) : 0.5;
      node.lx = cx + (t - 0.5) * spread;
      node.ly = cy + (index % 2 === 0 ? -46 : 46) + (index % 3) * 7;
      node.vx = 0;
      node.vy = 0;
    });

    var idealLen = clamp(spread / Math.max(1, count - 1), 90, 190);

    for (var step = 0; step < 320; step += 1) {
      var i;
      var j;
      // 节点间斥力
      for (i = 0; i < count; i += 1) {
        for (j = i + 1; j < count; j += 1) {
          var a = nodes[i];
          var b = nodes[j];
          var dx = b.lx - a.lx;
          var dy = b.ly - a.ly;
          var dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          var force = (idealLen * idealLen * 0.9) / (dist * dist);
          var fx = (dx / dist) * force;
          var fy = (dy / dist) * force;
          a.vx -= fx;
          a.vy -= fy;
          b.vx += fx;
          b.vy += fy;
        }
      }
      // 相邻节点保持理想距离（链式引力）
      for (var k = 0; k < count - 1; k += 1) {
        var n1 = nodes[k];
        var n2 = nodes[k + 1];
        var ddx = n2.lx - n1.lx;
        var ddy = n2.ly - n1.ly;
        var d = Math.max(1, Math.sqrt(ddx * ddx + ddy * ddy));
        var pull = (d - idealLen) * 0.06;
        var px = (ddx / d) * pull;
        var py = (ddy / d) * pull;
        n1.vx += px;
        n1.vy += py;
        n2.vx -= px;
        n2.vy -= py;
      }
      // 应用位移 + 向画布中心回拉 + 边界约束
      for (var m = 0; m < count; m += 1) {
        var node = nodes[m];
        node.vx += (cx - node.lx) * 0.008;
        node.vy += (cy - node.ly) * 0.008;
        node.lx += clamp(node.vx, -24, 24);
        node.ly += clamp(node.vy, -24, 24);
        node.lx = clamp(node.lx, 60, this.width - 60);
        node.ly = clamp(node.ly, 60, this.height - 60);
        node.vx *= 0.62;
        node.vy *= 0.62;
      }
    }
  };

  // ------------------------------------------------------------------
  // 渲染主流程
  // ------------------------------------------------------------------

  Renderer.prototype.startAnimation = function () {
    var self = this;
    if (!this.options.animate || this.animation.running) return;
    this.animation.running = true;
    this.animation.startedAt = performance.now();
    var loop = function (now) {
      if (!self.animation.running) return;
      self.draw(now);
      self.animation.frame = requestAnimationFrame(loop);
    };
    this.animation.frame = requestAnimationFrame(loop);
  };

  Renderer.prototype.stopAnimation = function () {
    this.animation.running = false;
    if (this.animation.frame) cancelAnimationFrame(this.animation.frame);
    this.animation.frame = null;
  };

  Renderer.prototype.draw = function (now) {
    var ctx = this.ctx;
    var time = typeof now === 'number' ? now : performance.now();

    // 叠加模式（高德底图）：底图由高德绘制，这里只画拓扑。
    // 每次绘制前先按当前地图视图重算节点屏幕坐标，保证平移缩放时拓扑跟随。
    if (this.plain) {
      if (typeof this.reproject === 'function') this.reproject(this);
      ctx.clearRect(0, 0, this.width, this.height);
      if (this.options.showLinks) this.drawArcs(ctx, time);
      this.drawNodes(ctx, time);
      // 标签层不必每帧重建（见 drawOverlay 的说明）
      if (this.overlay && this.shouldRebuildOverlay(time)) this.drawOverlay();
      return;
    }

    ctx.clearRect(0, 0, this.width, this.height);

    if (this.mode === 'map') {
      this.drawMapBackground(ctx);
      if (this.options.showGrid) this.drawGraticule(ctx);
      if (this.options.night) this.drawNight(ctx);
      this.drawCountries(ctx);
      // 可选：国家内的一级行政区（省/州/地区）边界。
      // 需要地图数据里带 provinces（构建时加 --admin1=50m 生成）。
      // 默认关闭 —— 默认样式就是"按国家划分"。
      if (this.options.showAdmin1 && this.world.provinces && this.world.provinces.length) {
        this.drawAdmin1(ctx);
      }
    } else {
      this.drawGraphBackground(ctx);
    }

    if (this.options.showLinks) this.drawArcs(ctx, time);
    this.drawNodes(ctx, time);
    if (this.overlay && this.shouldRebuildOverlay(time)) this.drawOverlay();
  };

  /**
   * 是否需要重建 SVG 标签层
   *
   * 为什么需要这个判断：标签层是真实 DOM（每个节点一个 g/rect/text），
   * 早期实现每帧都"清空 + 重建"，在 60fps 下相当于每秒上千次 DOM 操作，
   * 逻辑拓扑视图会明显卡顿。
   *
   * 现在改为：
   *   1. 悬停/选中变化、数据更新、尺寸变化时立即重建（保证交互不迟钝）；
   *   2. 平移动画（数据包流动）期间按 100ms 节流，
   *      既能让标签跟随地图平移，又不会每帧重建 DOM。
   */
  Renderer.prototype.shouldRebuildOverlay = function (time) {
    if (this.overlayDirty) {
      this.overlayDirty = false;
      this.overlayLastBuild = time;
      return true;
    }
    if (this.overlayLastBuild === undefined || this.overlayLastBuild === 0) {
      this.overlayLastBuild = time;
      return true;
    }
    var interval = this.mode === 'graph' ? 100 : 100;
    if (time - this.overlayLastBuild >= interval) {
      this.overlayLastBuild = time;
      return true;
    }
    return false;
  };

  /** 标记标签层需要重建（悬停、选中、数据更新时调用） */
  Renderer.prototype.invalidateOverlay = function () {
    this.overlayDirty = true;
  };

  Renderer.prototype.drawMapBackground = function (ctx) {
    var gradient = ctx.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, '#08111f');
    gradient.addColorStop(1, '#050a14');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
  };

  Renderer.prototype.drawGraphBackground = function (ctx) {
    ctx.fillStyle = '#070d18';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.06)';
    ctx.lineWidth = 1;
    var step = 42;
    for (var x = 0; x < this.width; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }
    for (var y = 0; y < this.height; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }
  };

  /** 经纬网格（每 30° 经度 / 20° 纬度） */
  Renderer.prototype.drawGraticule = function (ctx) {
    if (!this.world) return;
    ctx.save();
    ctx.strokeStyle = COLORS.graticule;
    ctx.lineWidth = 1;
    for (var lon = -180; lon <= 180; lon += 30) {
      var x = this.toScreen(this.project(lon, 0).x, 0).x;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.height);
      ctx.stroke();
    }
    for (var lat = this.world.latMin; lat <= this.world.latMax; lat += 20) {
      var y = this.toScreen(0, this.project(0, lat).y).y;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
    }
    ctx.restore();
  };

  /**
   * 昼夜分界（近似算法）
   * 用太阳赤纬 + 时角算出晨昏线纬度，逐列填充夜半球。
   */
  Renderer.prototype.drawNight = function (ctx) {
    if (!this.world) return;
    var now = new Date();
    var start = Date.UTC(now.getUTCFullYear(), 0, 0);
    var dayOfYear = Math.floor(
      (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start) / 86400000,
    );
    var declination = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));
    var utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
    var subSolarLon = (12 - utcHours) * 15;
    var declRad = (declination * Math.PI) / 180;

    ctx.save();
    ctx.fillStyle = 'rgba(2, 6, 16, 0.5)';
    var columnWidth = 5;
    for (var x = 0; x < this.width; x += columnWidth) {
      var worldX = this.toWorld(x, 0).x;
      var lon = this.world.lonMin + (worldX / this.world.width) * (this.world.lonMax - this.world.lonMin);
      var hourAngle = ((lon - subSolarLon) * Math.PI) / 180;
      var tanLat = -Math.cos(hourAngle) / Math.tan(declRad === 0 ? 1e-6 : declRad);
      var boundary = (Math.atan(tanLat) * 180) / Math.PI;
      if (!isFinite(boundary)) boundary = declination >= 0 ? -90 : 90;
      var boundaryY = this.toScreen(0, this.project(0, boundary).y).y;
      // 太阳直射北半球时，北侧为昼、南侧为夜，反之为相反
      if (declination >= 0) {
        ctx.fillRect(x, boundaryY, columnWidth, Math.max(0, this.height - boundaryY));
      } else {
        ctx.fillRect(x, 0, columnWidth, Math.max(0, boundaryY));
      }
    }
    ctx.restore();
  };

  /** 绘制国家/地区轮廓（带视口裁剪，保证大轨迹下的帧率） */
  Renderer.prototype.drawCountries = function (ctx) {
    if (!this.world) return;
    var scale = this.view.scale;
    ctx.save();
    ctx.translate(this.view.offsetX, this.view.offsetY);
    ctx.scale(scale, scale);
    ctx.lineJoin = 'round';
    ctx.fillStyle = COLORS.land;
    ctx.strokeStyle = COLORS.landStroke;
    ctx.lineWidth = Math.max(0.4, 0.7 / scale);

    var viewBox = {
      x0: -this.view.offsetX / scale,
      y0: -this.view.offsetY / scale,
      x1: (this.width - this.view.offsetX) / scale,
      y1: (this.height - this.view.offsetY) / scale,
    };

    var countries = this.world.countries;
    for (var i = 0; i < countries.length; i += 1) {
      var country = countries[i];
      var bbox = country.bbox;
      if (bbox[2] < viewBox.x0 || bbox[0] > viewBox.x1 || bbox[3] < viewBox.y0 || bbox[1] > viewBox.y1) continue;

      ctx.beginPath();
      for (var r = 0; r < country.rings.length; r += 1) {
        var ring = country.rings[r];
        ctx.moveTo(ring[0], ring[1]);
        for (var p = 2; p < ring.length; p += 2) {
          ctx.lineTo(ring[p], ring[p + 1]);
        }
        ctx.closePath();
      }
      ctx.fill();
      if (scale > 0.35) ctx.stroke();
    }
    ctx.restore();
  };

  /**
   * 一级行政区（省 / 州 / 地区）边界线
   *
   * 在国界之内再画出地区划分，让地图有"内部结构"而不是纯色块。
   *
   * 两个要点：
   *   1. 按缩放层级淡入 —— 全球视图下只显示国界（否则线条糊成一片、
   *      反而分不清国家），放大到一定倍数后再渐显地区划分；
   *   2. 每条线在构建期就带上了包围盒，这里做视口裁剪，
   *      避免每次平移缩放都遍历上万个顶点。
   */
  Renderer.prototype.drawAdmin1 = function (ctx) {
    if (!this.world) return;
    var provinces = this.world.provinces;
    if (!provinces || !provinces.length) return;

    var scale = this.view.scale;
    // 缩放淡入：<1.4 完全不显示，1.4→2.4 之间线性过渡
    var fade = (scale - 1.4) / 1.0;
    if (fade <= 0) return;
    if (fade > 1) fade = 1;

    var viewBox = {
      x0: -this.view.offsetX / scale,
      y0: -this.view.offsetY / scale,
      x1: (this.width - this.view.offsetX) / scale,
      y1: (this.height - this.view.offsetY) / scale,
    };

    ctx.save();
    ctx.translate(this.view.offsetX, this.view.offsetY);
    ctx.scale(scale, scale);
    ctx.lineJoin = 'round';
    ctx.globalAlpha = fade;
    ctx.strokeStyle = COLORS.admin1;
    // 缩放越大线条越细（按屏幕像素恒定），避免放大后变成粗色带
    ctx.lineWidth = Math.max(0.25, 0.45 / scale);
    ctx.beginPath();

    for (var i = 0; i < provinces.length; i += 1) {
      var item = provinces[i];
      // 兼容两种数据结构：{p,b}（新）与纯数组（旧）
      var line = Array.isArray(item) ? item : item.p;
      if (!line || line.length < 4) continue;
      if (!Array.isArray(item)) {
        var b = item.b;
        if (b[2] < viewBox.x0 || b[0] > viewBox.x1 || b[3] < viewBox.y0 || b[1] > viewBox.y1) continue;
      }
      ctx.moveTo(line[0], line[1]);
      for (var p = 2; p < line.length; p += 2) {
        ctx.lineTo(line[p], line[p + 1]);
      }
    }
    ctx.stroke();
    ctx.restore();
  };

  // ------------------------------------------------------------------
  // 连线
  // ------------------------------------------------------------------

  /**
   * 弧线路径
   *
   * 弯曲方向规则（保证永远不会"反着绕地球"）：
   *  - 水平跨度占优（|dx| >= |dy|）：向上拱起，形成经典的链路弧线
   *  - 垂直跨度占优：固定向右拱起
   * 弯曲量随距离增大但设有上限，近距离时自动减小，
   * 避免两个相近节点之间出现夸张的大弧线。
   */
  Renderer.prototype.arcPath = function (from, to) {
    var a = this.nodeScreen(from);
    var b = this.nodeScreen(to);
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var maxBend = Math.min(this.height * 0.22, 150);
    var bend = clamp(dist * 0.22, 6, maxBend);
    if (dist < 90) bend = Math.min(bend, dist * 0.28);

    var control;
    if (Math.abs(dx) >= Math.abs(dy)) {
      control = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - bend };
    } else {
      control = { x: (a.x + b.x) / 2 + bend, y: (a.y + b.y) / 2 };
    }
    return { a: a, b: b, cx: control.x, cy: control.y, dist: dist };
  };

  function bezierAt(a, control, b, t) {
    var mt = 1 - t;
    return {
      x: mt * mt * a.x + 2 * mt * t * control.x + t * t * b.x,
      y: mt * mt * a.y + 2 * mt * t * control.y + t * t * b.y,
    };
  }

  /**
   * 取节点（或它之前最近的节点）的有效延迟
   * 用于避免"某一跳超时"导致后续所有连线都失去颜色。
   */
  Renderer.prototype.nodeLatency = function (node) {
    if (!node) return null;
    var hops = node.hops || [];
    for (var i = hops.length - 1; i >= 0; i -= 1) {
      if (hops[i].latency && typeof hops[i].latency.avg === 'number') return hops[i].latency.avg;
    }
    if (typeof node.latency === 'number') return node.latency;
    var index = this.nodes.indexOf(node);
    for (var j = index - 1; j >= 0; j -= 1) {
      var prevHops = this.nodes[j].hops || [];
      for (var k = prevHops.length - 1; k >= 0; k -= 1) {
        if (prevHops[k].latency && typeof prevHops[k].latency.avg === 'number') return prevHops[k].latency.avg;
      }
    }
    return null;
  };

  /** 取节点累计丢包率（若连线之间跳过了未探测到的节点，按偏高处理） */
  Renderer.prototype.nodeLoss = function (node, arc) {
    var hops = (node && node.hops) || [];
    var losses = hops
      .map(function (h) { return h.latency && h.latency.lossPct; })
      .filter(function (v) { return typeof v === 'number'; });
    var loss = losses.length ? Math.max.apply(null, losses) : 0;
    if (arc && arc.skipped) loss = Math.max(loss, 50);
    return loss;
  };

  Renderer.prototype.arcColor = function (arc) {
    var mode = this.options.colorBy;
    if (mode === 'plain') return COLORS.route;
    if (mode === 'hop') {
      var t = clamp((arc.index || 0) / Math.max(1, this.arcs.length - 1), 0, 1);
      return 'hsl(' + Math.round(196 + t * 80) + ', 88%, ' + Math.round(66 - t * 14) + '%)';
    }
    if (mode === 'loss') {
      var loss = this.nodeLoss(arc.to, arc);
      if (loss >= 60) return COLORS.routeSlow;
      if (loss >= 20) return COLORS.routeMid;
      return COLORS.route;
    }
    var latency = this.nodeLatency(arc.to);
    if (latency === null) return COLORS.route;
    if (latency <= cfg.latencyThresholds.good) return COLORS.start;
    if (latency <= cfg.latencyThresholds.mid) return COLORS.routeMid;
    return COLORS.routeSlow;
  };

  Renderer.prototype.arcLabel = function (arc) {
    var hops = arc.to.hops || [];
    var latency = this.nodeLatency(arc.to);
    var ttl = hops.length ? hops[hops.length - 1].ttl : null;
    var parts = [];
    if (ttl !== null) parts.push('第 ' + ttl + ' 跳');
    if (latency !== null) parts.push(latency + ' ms');
    if (arc.skipped) parts.push('跳过 ' + arc.skipped + ' 跳');
    return parts.join(' · ');
  };

  Renderer.prototype.drawArcs = function (ctx, time) {
    var self = this;
    var elapsed = (time - this.animation.startedAt) / 1000;
    ctx.save();
    ctx.lineCap = 'round';

    this.arcs.forEach(function (arc, index) {
      var path = self.arcPath(arc.from, arc.to);
      if (path.dist < 1) return;
      var color = self.arcColor(arc);
      var active = self.selected && (self.selected === arc.from || self.selected === arc.to);
      var hovered = self.hovered && (self.hovered === arc.from || self.hovered === arc.to);

      // 外发光
      ctx.beginPath();
      ctx.moveTo(path.a.x, path.a.y);
      ctx.quadraticCurveTo(path.cx, path.cy, path.b.x, path.b.y);
      ctx.strokeStyle = color;
      ctx.globalAlpha = active ? 0.28 : hovered ? 0.2 : 0.12;
      ctx.lineWidth = active ? 9 : 7;
      ctx.stroke();

      // 主线
      ctx.globalAlpha = active ? 1 : 0.8;
      ctx.lineWidth = active ? 2.6 : 1.7;
      ctx.strokeStyle = color;
      ctx.stroke();

      // 数据包流动画：延迟越高流动越慢，直观表达"慢在哪一段"
      if (self.options.animate) {
        var latency = self.nodeLatency(arc.to);
        var duration = clamp(1.1 + (latency === null ? 0.7 : latency / 140), 1.1, 3.6);
        var packets = 2;
        for (var p = 0; p < packets; p += 1) {
          var t = ((elapsed / duration) + p / packets + index * 0.13) % 1;
          var point = bezierAt(path.a, { x: path.cx, y: path.cy }, path.b, t);
          var fade = Math.sin(Math.PI * t);
          ctx.globalAlpha = 0.35 + 0.65 * fade;
          ctx.beginPath();
          ctx.arc(point.x, point.y, active ? 3.4 : 2.4, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 0.16;
          ctx.beginPath();
          ctx.arc(point.x, point.y, active ? 9 : 6.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 跳数标注
      if (self.options.showLabels && path.dist > 46) {
        var mid = bezierAt(path.a, { x: path.cx, y: path.cy }, path.b, 0.5);
        var label = self.arcLabel(arc);
        if (label) {
          ctx.globalAlpha = active || hovered ? 0.95 : 0.68;
          ctx.font = '600 10.5px "Cascadia Mono", Consolas, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          var w = ctx.measureText(label).width;
          ctx.fillStyle = 'rgba(7, 12, 22, 0.78)';
          ctx.fillRect(mid.x - w / 2 - 4, mid.y - 8, w + 8, 15);
          ctx.fillStyle = color;
          ctx.fillText(label, mid.x, mid.y);
        }
      }
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  };

  // ------------------------------------------------------------------
  // 节点与标签
  // ------------------------------------------------------------------

  /** 局域网设备类型 → 填充色 */
  var DEVICE_COLORS = {
    gateway: '#fbbf24',
    self: '#34d399',
    internet: '#f472b6',
    router: '#fbbf24',
    computer: '#38bdf8',
    phone: '#a78bfa',
    printer: '#f59e0b',
    nas: '#22d3ee',
    camera: '#fb7185',
    tv: '#818cf8',
    iot: '#4ade80',
    server: '#60a5fa',
    virtual: '#64748b',
    unknown: '#64748b',
  };

  /**
   * 节点着色规则
   *
   * 设计原则：**颜色表达"角色"，时延/丢包只用于标记"异常"**。
   *
   * 之前的问题：低时延的中间节点会被染成起点绿（与时延阈值直接返回绿色有关），
   * 中时延节点又被染成黄色，与图例（中间节点=蓝色）不一致，用户无法判断谁是起点。
   * 更糟的是：丢包 100% 的跳因为时延数值很小，被时延规则抢先判成绿色，
   * 把"不通"误显示为"健康"。
   *
   * 现在的规则：
   *   起点 / 本机            → 绿色（呼吸光晕）
   *   目标                   → 粉色（带同心环）
   *   中间节点（默认）        → 本色蓝
   *   中间节点但有明显问题    → 黄色（时延偏高或丢包 ≥ 20%）
   *   中间节点严重异常        → 红色（丢包 ≥ 50%、超时跳、时延 > 180ms）
   *   完全无响应（* * *）     → 灰色
   */
  Renderer.prototype.nodeColor = function (node) {
    // 局域网星型拓扑：按设备类型着色（网关/本机/互联网/各类设备）
    if (this.lanMode || node.kind === 'gateway' || node.kind === 'internet' || node.kind === 'device') {
      if (node.kind === 'gateway') return DEVICE_COLORS.gateway;
      if (node.kind === 'internet') return DEVICE_COLORS.internet;
      if (node.kind === 'start' || node.isStart) return DEVICE_COLORS.self;
      return DEVICE_COLORS[node.deviceType] || DEVICE_COLORS.unknown;
    }

    // 角色优先
    if (node.isStart || node.kind === 'start') return COLORS.start;
    if (node.isTarget) return COLORS.target;

    // 完全无响应：灰色
    var isTimeout = node.isTimeout === true
      || (node.hops && node.hops.length > 0 && node.hops.every(function (h) { return h.isTimeout || typeof h.latency?.avg !== 'number'; }) && node.latency === null);
    if (isTimeout) return COLORS.timeout;

    // 异常信号：丢包优先于时延
    var loss = typeof node.lossPct === 'number' ? node.lossPct : 0;
    if (loss >= 50) return COLORS.routeSlow;
    if (loss >= 20) return COLORS.routeMid;

    var latency = node.latency;
    if (typeof latency === 'number') {
      if (latency > cfg.latencyThresholds.mid) return COLORS.routeSlow; // > 180ms
    }

    // 正常中间节点：本色蓝
    return COLORS.route;
  };

  /**
   * 节点标签里的附加信息：第 N 跳 · 时延
   * 起点（本机）显示"起点"，其它节点显示它在本条路径中的跳序号。
   */
  Renderer.prototype.nodeHopInfo = function (node) {
    if (this.lanMode) return null;
    var parts = [];
    if (node.isStart) {
      parts.push('起点');
    } else {
      var ttls = (node.hops || [])
        .map(function (h) { return h.ttl; })
        .filter(function (v) { return typeof v === 'number'; });
      if (ttls.length) {
        var first = Math.min.apply(null, ttls);
        var last = Math.max.apply(null, ttls);
        parts.push(first === last ? '第 ' + first + ' 跳' : '第 ' + first + '-' + last + ' 跳');
      }
    }
    if (typeof node.latency === 'number') parts.push(node.latency + ' ms');
    else if (node.isTimeout) parts.push('超时');
    return parts.length ? parts.join(' · ') : null;
  };

  Renderer.prototype.drawNodes = function (ctx, time) {
    var self = this;
    ctx.save();
    this.nodes.forEach(function (node) {
      var pos = self.nodeScreen(node);
      if (!isFinite(pos.x) || !isFinite(pos.y)) return;
      var isHover = self.hovered === node;
      var isSelected = self.selected === node;
      var radius = node.kind === 'gateway' ? 9 : node.kind === 'internet' ? 8.5 : node.isTarget ? 7 : node.isStart ? 7 : 5.5;
      if (isHover || isSelected) radius += 2.2;
      var color = self.nodeColor(node);

      // 呼吸光环
      var pulse = 0.5 + 0.5 * Math.sin(time / 520 + node.index);
      ctx.globalAlpha = 0.16 + 0.14 * pulse;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius + 7 + pulse * 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // 不可见的命中判定区域（提升悬停体验）
      ctx.globalAlpha = 0.001;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, Math.max(11, radius + 6), 0, Math.PI * 2);
      ctx.fill();

      // 节点主体
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = isSelected ? 2.4 : 1.4;
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(6, 12, 22, 0.9)';
      ctx.stroke();

      // 目标节点额外的同心环
      if (node.isTarget) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });
    ctx.restore();
  };

  /**
   * SVG 标签层：比 Canvas 文本更清晰，且可被浏览器原生选中
   *
   * 局域网拓扑（星型）节点较少，标签必须全部可见；
   * 路由拓扑节点较多时，只显示悬停/选中节点的标签，避免互相遮挡。
   */
  Renderer.prototype.drawOverlay = function () {
    var self = this;
    var svg = this.overlay;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!this.options.showLabels) return;

    var ns = 'http://www.w3.org/2000/svg';
    var placed = [];
    // 标签显示策略：
    //   1. 节点较多时**均匀抽样**（每隔若干个取一个），保证画面上始终有可读标签，
    //      并且起点与目标一定显示；
    //   2. 悬停 / 选中的节点始终显示；
    //   3. 逐个避让，放不下就跳过该标签（宁可少显示，也不要叠成一团）。
    //
    // 注意：早期实现是"节点 > 8 就只显示悬停/选中的"，但函数开头已经清空了 SVG，
    // 于是没有任何悬停时整层会永久空白（逻辑拓扑按跳展开后节点变多就会触发）。
    var nodes = this.nodes;
    var count = nodes.length;
    var maxLabels = this.lanMode ? 24 : 14;
    var stride = count > maxLabels ? Math.ceil(count / maxLabels) : 1;
    var labeled = 0;

    nodes.forEach(function (node, index) {
      var pos = self.nodeScreen(node);
      if (!isFinite(pos.x) || !isFinite(pos.y)) return;
      if (pos.x < -80 || pos.y < -40 || pos.x > self.width + 80 || pos.y > self.height + 40) return;

      var isHover = self.hovered === node;
      var isSelected = self.selected === node;
      // 起点 / 目标 / 悬停 / 选中始终显示；其余按 stride 抽样
      var always = isHover || isSelected || node.isStart || node.isTarget;
      if (!always && stride > 1 && index % stride !== 0) return;

      var text = node.label || '';
      // 节点标签：带上"第 N 跳"和时延，方便一眼看出每个点在第几跳、延迟多少
      if (!self.lanMode) {
        var hopInfo = self.nodeHopInfo(node);
        if (hopInfo) text += '  ' + hopInfo;
      }

      var w = Math.min(260, text.length * 7 + 18);
      var h = 20;
      var x = pos.x + 11;
      var y = pos.y - h - 6;
      if (x + w > self.width - 6) x = Math.max(6, pos.x - w - 11);
      if (y < 6) y = pos.y + 10;
      // 避让：与已放置标签重叠时依次尝试下移 / 上移 / 右移，都放不下就跳过
      var fits = false;
      var offsets = [0, h + 3, -(h + 3), 2 * (h + 3), -2 * (h + 3)];
      for (var attempt = 0; attempt < offsets.length; attempt += 1) {
        var ty = y + offsets[attempt];
        if (ty < 6 || ty + h > self.height - 6) continue;
        var overlaps = placed.some(function (r) {
          return !(x + w < r.x || x > r.x + r.w || ty + h < r.y || ty > r.y + r.h);
        });
        if (!overlaps) {
          y = ty;
          fits = true;
          break;
        }
      }
      if (!fits && !always) return; // 放不下就不画，避免互相遮挡
      placed.push({ x: x, y: y, w: w, h: h });
      labeled += 1;

      var group = document.createElementNS(ns, 'g');
      var rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', w);
      rect.setAttribute('height', h);
      rect.setAttribute('rx', 6);
      rect.setAttribute('fill', isHover || isSelected ? 'rgba(16, 32, 56, 0.96)' : 'rgba(9, 17, 30, 0.82)');
      rect.setAttribute('stroke', isHover || isSelected ? '#38bdf8' : 'rgba(56, 189, 248, 0.25)');
      rect.setAttribute('stroke-width', '1');
      group.appendChild(rect);

      var label = document.createElementNS(ns, 'text');
      label.setAttribute('x', x + 8);
      label.setAttribute('y', y + 14);
      label.setAttribute('fill', node.isTarget ? '#f9a8d4' : node.isStart ? '#6ee7b7' : '#cfe4ff');
      label.setAttribute('font-size', '11.5');
      label.setAttribute('font-family', '"Segoe UI", "Microsoft YaHei", sans-serif');
      label.textContent = text;
      group.appendChild(label);
      svg.appendChild(group);
    });
  };
  /** 命中测试：返回鼠标位置下的节点 */
  Renderer.prototype.hitTest = function (screenX, screenY) {
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < this.nodes.length; i += 1) {
      var node = this.nodes[i];
      var pos = this.nodeScreen(node);
      if (!isFinite(pos.x) || !isFinite(pos.y)) continue;
      var dx = pos.x - screenX;
      var dy = pos.y - screenY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var threshold = node.isTarget || node.isStart ? 16 : 13;
      if (dist < threshold && dist < bestDist) {
        best = node;
        bestDist = dist;
      }
    }
    return best;
  };

  Renderer.prototype.setHovered = function (node) {
    if (this.hovered === node) return;
    this.hovered = node;
    this.invalidateOverlay();
    this.draw();
  };

  Renderer.prototype.setSelected = function (node) {
    this.selected = node;
    this.invalidateOverlay();
    this.draw();
  };

  /** 切换视图模式 */
  Renderer.prototype.setMode = function (mode) {
    this.mode = mode === 'graph' ? 'graph' : 'map';
    if (this.mode === 'graph') this.layoutLogical();
    else this.fitToContainer();
    this.invalidateOverlay();
    this.draw();
  };

  Renderer.prototype.setOptions = function (options) {
    var self = this;
    Object.keys(options || {}).forEach(function (key) {
      self.options[key] = options[key];
    });
    // 动画与视图模式无关：世界地图、逻辑拓扑、局域网星型拓扑都应保持一致，
    // 否则会出现"星型拓扑画面静止、逻辑拓扑在动"的不一致观感
    if (this.options.animate) this.startAnimation();
    else this.stopAnimation();
    this.invalidateOverlay();
    this.draw();
  };

  // ------------------------------------------------------------------
  // 逐跳延迟折线图
  // ------------------------------------------------------------------

  function drawLatencyChart(canvas, hops) {
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(200, Math.floor(rect.width));
    var h = 120;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var list = hops || [];
    var points = list.filter(function (hop) {
      return hop.latency && typeof hop.latency.avg === 'number';
    });
    if (!points.length) {
      ctx.fillStyle = '#64789a';
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无延迟数据', w / 2, h / 2);
      return;
    }

    var padLeft = 34;
    var padRight = 10;
    var padTop = 12;
    var padBottom = 20;
    var maxLatency = Math.max.apply(null, points.map(function (p) { return p.latency.avg; }));
    var scaleMax = Math.max(10, Math.ceil((maxLatency * 1.15) / 10) * 10);
    var stepX = (w - padLeft - padRight) / Math.max(1, list.length - 1);

    // 网格与刻度
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
    ctx.fillStyle = '#64789a';
    ctx.font = '10px "Cascadia Mono", Consolas, monospace';
    ctx.textAlign = 'right';
    for (var g = 0; g <= 2; g += 1) {
      var value = (scaleMax / 2) * g;
      var gy = h - padBottom - (value / scaleMax) * (h - padTop - padBottom);
      ctx.beginPath();
      ctx.moveTo(padLeft, gy);
      ctx.lineTo(w - padRight, gy);
      ctx.stroke();
      ctx.fillText(String(Math.round(value)), padLeft - 6, gy + 3);
    }

    var coords = points.map(function (point) {
      var idx = list.indexOf(point);
      return {
        x: padLeft + idx * stepX,
        y: h - padBottom - (point.latency.avg / scaleMax) * (h - padTop - padBottom),
        hop: point,
      };
    });

    // 面积
    ctx.beginPath();
    ctx.moveTo(coords[0].x, h - padBottom);
    coords.forEach(function (c) { ctx.lineTo(c.x, c.y); });
    ctx.lineTo(coords[coords.length - 1].x, h - padBottom);
    ctx.closePath();
    var fill = ctx.createLinearGradient(0, padTop, 0, h - padBottom);
    fill.addColorStop(0, 'rgba(56, 189, 248, 0.35)');
    fill.addColorStop(1, 'rgba(56, 189, 248, 0.02)');
    ctx.fillStyle = fill;
    ctx.fill();

    // 折线
    ctx.beginPath();
    coords.forEach(function (c, i) {
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    });
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // 数据点
    coords.forEach(function (c) {
      var latency = c.hop.latency.avg;
      var color = latency <= cfg.latencyThresholds.good ? '#34d399' : latency <= cfg.latencyThresholds.mid ? '#fbbf24' : '#f87171';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });

    // X 轴跳数
    ctx.fillStyle = '#64789a';
    ctx.textAlign = 'center';
    list.forEach(function (hop, idx) {
      if (list.length > 16 && idx % 2 !== 0) return;
      ctx.fillText(String(hop.ttl), padLeft + idx * stepX, h - 6);
    });
  }

  window.NetScopeDraw = {
    Renderer: Renderer,
    drawLatencyChart: drawLatencyChart,
    clamp: clamp,
  };
})();
