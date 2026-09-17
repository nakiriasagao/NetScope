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
    var rect = this.canvas.parentElement.getBoundingClientRect();
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

  /** 节点在屏幕上的位置（世界地图用投影坐标，逻辑拓扑用布局坐标） */
  Renderer.prototype.nodeScreen = function (node) {
    if (this.mode === 'graph') return { x: node.lx, y: node.ly };
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
  Renderer.prototype.setTrace = function (hops, context) {
    var self = this;
    var ctx = context || {};
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
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i].geoKey === key) {
          existing = nodes[i];
          break;
        }
      }
      if (!existing) {
        var point = self.project(geo.lon, geo.lat);
        existing = {
          kind: 'hop',
          geoKey: key,
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
    nodes.forEach(function (node) {
      var first = node.hops[0] || {};
      node.label = node.city || first.hostname || first.ip || '节点';
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
    ctx.clearRect(0, 0, this.width, this.height);

    if (this.mode === 'map') {
      this.drawMapBackground(ctx);
      if (this.options.showGrid) this.drawGraticule(ctx);
      if (this.options.night) this.drawNight(ctx);
      this.drawCountries(ctx);
    } else {
      this.drawGraphBackground(ctx);
    }

    if (this.options.showLinks) this.drawArcs(ctx, time);
    this.drawNodes(ctx, time);
    if (this.overlay) this.drawOverlay();
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

  Renderer.prototype.nodeColor = function (node) {
    if (node.kind === 'start') return COLORS.start;
    if (node.isTarget) return COLORS.target;
    if (node.geoStatus === 'private') return COLORS.start;
    if (typeof node.latency === 'number') {
      if (node.latency <= cfg.latencyThresholds.good) return COLORS.start;
      if (node.latency <= cfg.latencyThresholds.mid) return COLORS.routeMid;
      return COLORS.routeSlow;
    }
    return COLORS.route;
  };

  Renderer.prototype.drawNodes = function (ctx, time) {
    var self = this;
    ctx.save();
    this.nodes.forEach(function (node) {
      var pos = self.nodeScreen(node);
      if (!isFinite(pos.x) || !isFinite(pos.y)) return;
      var isHover = self.hovered === node;
      var isSelected = self.selected === node;
      var radius = node.isStart ? 6 : node.isTarget ? 7 : 5.5;
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
   * 标签数量较多时（>4 个节点）只显示悬停/选中节点的标签，避免互相遮挡。
   */
  Renderer.prototype.drawOverlay = function () {
    var self = this;
    var svg = this.overlay;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!this.options.showLabels) return;

    var ns = 'http://www.w3.org/2000/svg';
    var placed = [];
    var showAll = this.nodes.length <= 4;

    this.nodes.forEach(function (node) {
      var pos = self.nodeScreen(node);
      if (!isFinite(pos.x) || !isFinite(pos.y)) return;
      if (pos.x < -80 || pos.y < -40 || pos.x > self.width + 80 || pos.y > self.height + 40) return;

      var isHover = self.hovered === node;
      var isSelected = self.selected === node;
      if (!showAll && !isHover && !isSelected) return;

      var text = node.label || '';
      if (typeof node.latency === 'number' && node.latency > 0) text += '  ' + node.latency + ' ms';
      else if (node.isStart) text += '  0 ms';

      var w = Math.min(260, text.length * 7 + 18);
      var h = 20;
      var x = pos.x + 11;
      var y = pos.y - h - 6;
      if (x + w > self.width - 6) x = Math.max(6, pos.x - w - 11);
      if (y < 6) y = pos.y + 10;
      // 简单避让：与已放置标签重叠时下移
      for (var attempt = 0; attempt < 5; attempt += 1) {
        var overlaps = placed.some(function (r) {
          return !(x + w < r.x || x > r.x + r.w || y + h < r.y || y > r.y + r.h);
        });
        if (!overlaps) break;
        y += h + 3;
      }
      placed.push({ x: x, y: y, w: w, h: h });

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
    this.draw();
  };

  Renderer.prototype.setSelected = function (node) {
    this.selected = node;
    this.draw();
  };

  /** 切换视图模式 */
  Renderer.prototype.setMode = function (mode) {
    this.mode = mode === 'graph' ? 'graph' : 'map';
    if (this.mode === 'graph') this.layoutLogical();
    else this.fitToContainer();
    this.draw();
  };

  Renderer.prototype.setOptions = function (options) {
    var self = this;
    Object.keys(options || {}).forEach(function (key) {
      self.options[key] = options[key];
    });
    if (this.options.animate && this.mode === 'map') this.startAnimation();
    else this.stopAnimation();
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
