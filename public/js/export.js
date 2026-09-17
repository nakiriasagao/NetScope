/* NetScope 导出工具
 * 支持 JSON（完整数据）、CSV（逐跳表格）、GeoJSON（可在 GIS 软件中打开）
 * 以及把世界地图拓扑存为 PNG 图片。
 */
(function () {
  'use strict';

  function download(content, filename, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  function timestamp() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function safeName(text) {
    return String(text || 'trace').replace(/[^\w.\-]+/g, '_').slice(0, 60);
  }

  function toJSON(state) {
    var payload = {
      tool: 'NetScope',
      exportedAt: new Date().toISOString(),
      target: state.target || null,
      summary: state.summary || null,
      trace: state.trace || null,
      hops: state.hops || [],
      geo: state.geo || {},
      probe: state.probe || null,
      dns: state.dns || null,
      security: state.security || null,
      portScan: state.portScan || null,
      local: state.local || null,
      engine: state.engine || null,
      fallbackNotes: state.fallbackNotes || [],
    };
    download(JSON.stringify(payload, null, 2), 'netscope-' + safeName(state.input) + '-' + timestamp() + '.json', 'application/json;charset=utf-8');
  }

  function toCSV(state) {
    var rows = [['跳数', 'IP', '主机名', '城市', '国家/地区', '运营商', 'ASN', '最小延迟(ms)', '平均延迟(ms)', '最大延迟(ms)', '抖动(ms)', '丢包率(%)', '地址性质', '经纬度', '定位来源']];
    (state.hops || []).forEach(function (hop) {
      var geo = hop.geo || {};
      rows.push([
        hop.ttl,
        hop.ip || '',
        hop.hostname || '',
        geo.city || '',
        geo.country || '',
        geo.isp || '',
        geo.asn || '',
        hop.latency?.min ?? '',
        hop.latency?.avg ?? '',
        hop.latency?.max ?? '',
        hop.latency?.jitter ?? '',
        hop.latency?.lossPct ?? '',
        hop.classification ? hop.classification.label : '',
        typeof geo.lat === 'number' ? geo.lat.toFixed(4) + ',' + geo.lon.toFixed(4) : '',
        geo.provider || '',
      ]);
    });
    var csv = rows
      .map(function (row) {
        return row
          .map(function (cell) {
            var text = String(cell === null || cell === undefined ? '' : cell);
            return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
          })
          .join(',');
      })
      .join('\r\n');
    // 加 BOM，保证 Excel 正确识别 UTF-8
    download('\ufeff' + csv, 'netscope-hops-' + safeName(state.input) + '-' + timestamp() + '.csv', 'text/csv;charset=utf-8');
  }

  function toGeoJSON(state) {
    var features = [];
    var coordinates = [];
    var start = state.local && state.local.location;
    if (start && typeof start.lat === 'number') {
      coordinates.push([start.lon, start.lat]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [start.lon, start.lat] },
        properties: { role: 'start', name: '本机', city: start.city, country: start.country },
      });
    }
    (state.hops || []).forEach(function (hop) {
      var geo = hop.geo || {};
      if (typeof geo.lat !== 'number') return;
      coordinates.push([geo.lon, geo.lat]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [geo.lon, geo.lat] },
        properties: {
          role: 'hop',
          ttl: hop.ttl,
          ip: hop.ip,
          hostname: hop.hostname,
          city: geo.city,
          country: geo.country,
          isp: geo.isp,
          asn: geo.asn,
          avgLatencyMs: hop.latency?.avg ?? null,
          lossPct: hop.latency?.lossPct ?? null,
          provider: geo.provider,
        },
      });
    });
    if (coordinates.length > 1) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coordinates },
        properties: { role: 'route', target: state.target ? state.target.host : null, hopCount: (state.hops || []).length },
      });
    }
    var collection = {
      type: 'FeatureCollection',
      name: 'NetScope route ' + (state.input || ''),
      generatedAt: new Date().toISOString(),
      features: features,
    };
    download(JSON.stringify(collection, null, 2), 'netscope-route-' + safeName(state.input) + '-' + timestamp() + '.geojson', 'application/geo+json');
  }

  /** 把 Canvas 保存为 PNG（可选叠加白色背景，便于插入文档） */
  function toPNG(canvas, state, options) {
    var opts = options || {};
    var out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    var ctx = out.getContext('2d');
    if (opts.whiteBackground) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.drawImage(canvas, 0, 0);

    // 图注
    ctx.font = '600 ' + Math.round(16 * (window.devicePixelRatio || 1)) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = opts.whiteBackground ? '#0f172a' : '#e6eefc';
    ctx.fillText('NetScope 网络拓扑图 · ' + (state.input || ''), 20 * (window.devicePixelRatio || 1), 30 * (window.devicePixelRatio || 1));
    ctx.font = Math.round(12 * (window.devicePixelRatio || 1)) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = opts.whiteBackground ? '#475569' : '#92a6c4';
    var summary = state.summary || {};
    var stats = '跳数 ' + ((state.hops || []).length || 0) + ' · 平均延迟 ' + (summary.avgRtt ?? '—') + ' ms · 生成于 ' + new Date().toLocaleString('zh-CN');
    ctx.fillText(stats, 20 * (window.devicePixelRatio || 1), 52 * (window.devicePixelRatio || 1));

    out.toBlob(function (blob) {
      if (!blob) return;
      download(blob, 'netscope-map-' + safeName(state.input) + '-' + timestamp() + '.png', 'image/png');
    }, 'image/png');
  }

  window.NetScopeExport = {
    toJSON: toJSON,
    toCSV: toCSV,
    toGeoJSON: toGeoJSON,
    toPNG: toPNG,
    download: download,
  };
})();
