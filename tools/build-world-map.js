'use strict';

/**
 * 构建世界地图数据
 *
 * 从 CDN 获取 Natural Earth 1:110m 的 TopoJSON 世界国界数据，
 * 在构建期完成“拓扑解码 + 等距圆柱投影”，输出前端可直接绘制的精简栅格数据：
 *
 *   public/data/world-110m.json
 *   {
 *     projection: 'equirectangular',
 *     width, height, lonMin, lonMax, latMin, latMax,
 *     countries: [{ name, rings: [[x,y,x,y,...], ...], bbox:[minX,minY,maxX,maxY] }]
 *   }
 *
 * 这样浏览器端无需引入任何地图库（d3-geo / topojson）即可绘制世界地图，
 * 也避免了运行时对外部 CDN 的依赖。
 *
 * 用法：node tools/build-world-map.js [--out public/data/world-110m.json]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

/* ------------------------------------------------------------------ */
/* 画布尺寸                                                            */
/* ------------------------------------------------------------------ */

const WIDTH = 1440;
const LON_MIN = -180;
const LON_MAX = 180;
const LAT_MIN = -60; // 地图下边界取 -60°，与多数世界地图一致（避免南极被拉伸）
const LAT_MAX = 85;

/**
 * 画布高度由"等比例"推导，保证经纬方向每度像素数一致（4 px/度）。
 *
 * 为什么必须这样算：
 *   等距圆柱投影只有在 x/y 方向比例尺相同时才是"等距"的；
 *   若高度随意取值（例如按 2:1 取 720），纬度方向会得到 4.97 px/度，
 *   地图就会被纵向拉伸约 24%，看起来"被拉长且压扁"。
 *
 *   经度跨度 360°、宽度 1440px → 4 px/度；
 *   纬度跨度 145°（-60~85）→ 高度 = 145 × 4 = 580px，与宽度同一比例尺。
 */
const HEIGHT = Math.round((WIDTH / (LON_MAX - LON_MIN)) * (LAT_MAX - LAT_MIN)); // 580
const PX_PER_DEGREE = WIDTH / (LON_MAX - LON_MIN);


const SOURCES = [
  'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json',
  'https://unpkg.com/world-atlas@2.0.2/countries-110m.json',
  'https://registry.npmmirror.com/world-atlas/2.0.2/files/countries-110m.json',
];

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000, headers: { 'User-Agent': 'NetScope-build/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

function project(lon, lat) {
  const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * WIDTH;
  const clampedLat = Math.max(LAT_MIN, Math.min(LAT_MAX, lat));
  const y = ((LAT_MAX - clampedLat) / (LAT_MAX - LAT_MIN)) * HEIGHT;
  // 保留一位小数：在 4 px/度的比例下相当于 0.025°（约 2.8 km）精度，
  // 远高于 1:110m 数据本身的分辨率，同时能显著压缩文件体积
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

/* ------------------------------------------------------------------ */
/* 日界线（±180°）切分                                                 */
/* ------------------------------------------------------------------ */

/**
 * 计算相邻两点的经度差，取最短路径（结果落在 [-180, 180]）。
 * 这是经度展开的关键：直接相减会出现 358° 这种"绕地球一圈"的假跨度。
 */
function shortestLonDelta(from, to) {
  let d = ((to - from) % 360 + 540) % 360 - 180;
  return d;
}

/**
 * 把一条经纬度折线按 ±180° 切分并裁剪到地图范围内。
 *
 * 为什么必须做：
 *   等距圆柱投影下，跨越日界线的多边形（俄罗斯、斐济、南极洲）内部同时存在
 *   x≈0 与 x≈1440 的点，直接闭合填充会画出一条横贯整幅地图的带子（"横条纹"）。
 *
 * 算法（三步，缺一不可）：
 *   1) **展开**：源数据已把经度规范化到 [-180, 180]，跨越日界线的边表现为
 *      178.6 → -180.0 这种"小跳变"（最短路径只有 1.4°）。因此必须逐点累加最短经度差，
 *      把折线展开成连续经度，再整体平移到地图范围内；
 *   2) **按竖直直线 ±180° 拆分连通分量**：跨界的环会被切成"贴着右边界"和"贴着左边界"
 *      两部分，分别处理才能各自闭合正确（否则闭合边会横贯全图）；
 *   3) **裁剪**（Sutherland–Hodgman）：把每部分裁剪到 [-180, 180]。
 *      注意裁剪输入必须是**闭合环**，否则算法会把首尾当作相邻边，产生横贯全图的假边。
 *
 * @param {Array<[number, number]>} lonLatPoints 经纬度点序列（首尾不必闭合）
 * @returns {Array<Array<[number, number]>>} 裁剪后的多边形（可能 0~2 个）
 */
function clipToMapBounds(lonLatPoints) {
  if (lonLatPoints.length < 3) return [];

  // 1) 展开经度：累加最短经度差，得到连续、无折返的经度序列
  const unwrapped = [[lonLatPoints[0][0], lonLatPoints[0][1]]];
  for (let i = 1; i < lonLatPoints.length; i += 1) {
    const prev = unwrapped[unwrapped.length - 1];
    const delta = shortestLonDelta(prev[0], lonLatPoints[i][0]);
    unwrapped.push([prev[0] + delta, lonLatPoints[i][1]]);
  }

  const lons = unwrapped.map((p) => p[0]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const span = maxLon - minLon;

  // 跨度极大说明数据本身异常（占满整个圆周），直接放弃
  if (span > 350) return [];

  const shift = -360 * Math.round((minLon + maxLon) / 2 / 360);
  const shifted = unwrapped.map(([lon, lat]) => [lon + shift, lat]);

  const results = [];
  for (const piece of splitAtLonLine(shifted, -180)) {
    if (piece.length < 3) continue;
    // 注意：clipPolygonToLonRange 返回的是"多个多边形"的数组，必须展开合并，
    // 否则会把数组当成一个多边形，导致后续几何计算全部错乱
    for (const polygon of clipPolygonToLonRange(piece, -180, 180)) {
      if (polygon.length >= 3) results.push(polygon);
    }
  }
  return results;
}

/**
 * 用一条竖直直线把（已展开的）环形折线拆成两侧的连通部分
 * @param {Array<[number, number]>} points 已展开、已闭合的经纬度环
 * @param {number} lineLon 分割线经度
 */
function splitAtLonLine(points, lineLon) {
  const ring = closeRing(points);
  const inside = (p) => p[0] <= lineLon; // 左侧（经度较小的一侧）
  const current = [];
  const sides = [];

  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    const aIn = inside(a);
    const bIn = inside(b);
    if (aIn === bIn) {
      current.push(a);
      continue;
    }
    const t = (lineLon - a[0]) / (b[0] - a[0]);
    const cross = [lineLon, a[1] + t * (b[1] - a[1])];
    current.push(a);
    current.push(cross);
    sides.push(current.splice(0, current.length));
    current.push(cross);
  }
  current.push(ring[ring.length - 1]);
  sides.push(current);

  const left = [];
  const right = [];
  for (const side of sides) {
    if (side.length < 2) continue;
    (inside(side[0]) ? left : right).push(side);
  }
  const best = [];
  for (const group of [left, right]) {
    if (!group.length) continue;
    const top = group.reduce((acc, seg) => (seg.length > acc.length ? seg : acc), group[0]);
    if (top.length >= 3) best.push(top);
  }
  return best;
}

/** 补上闭合点（把最后一点接到起点），若已闭合则原样返回 */
function closeRing(points) {
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) return points.slice();
  const delta = shortestLonDelta(last[0], first[0]);
  return points.concat([[last[0] + delta, first[1]]]);
}

/**
 * 把一个多边形裁剪到 [lonMin, lonMax] 竖直条带，返回若干多边形。
 *
 * 实现说明（为什么不用 Sutherland–Hodgman）：
 *   当多边形横跨整个条带时，Sutherland–Hodgman 会把"跨越的一侧"压缩成一条
 *   横贯全图的退化细缝——正是我们要消除的"横条纹"。
 *
 * 这里采用"按交点切段"的直白做法：
 *   1) 顺序扫描闭合环的每条边，记录它与左右边界的所有交点及其在环上的位置；
 *   2) 以交点把环切成若干段，逐段保留落在边界内的部分；
 *   3) 每段首尾各补上对应的交点，形成闭合多边形。
 */
function clipPolygonToLonRange(points, lonMin, lonMax) {
  const ring = closeRing(points);
  const inRange = (lon) => lon >= lonMin && lon <= lonMax;

  // 1) 收集所有边界交点（含所在边的起点下标）
  const crossings = [];
  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    const aIn = inRange(a[0]);
    const bIn = inRange(b[0]);
    if (aIn === bIn) continue; // 同侧，无边交点
    const edge = aIn ? (a[0] < b[0] ? lonMax : lonMin) : (b[0] < a[0] ? lonMax : lonMin);
    const t = (edge - a[0]) / (b[0] - a[0]);
    crossings.push({ segment: i, point: [edge, a[1] + t * (b[1] - a[1])] });
  }

  // 整环都在范围内：直接返回
  if (!crossings.length) return inRange(ring[0][0]) ? [ring] : [];

  // 2) 以交点把环切成段，保留其中的内部点
  const polygons = [];
  for (let c = 0; c < crossings.length; c += 1) {
    const from = crossings[c];
    const to = crossings[(c + 1) % crossings.length];
    const piece = [from.point];
    // 从 from 所在边的下一点开始，一直走到 to 所在边的起点
    let i = from.segment + 1;
    while (i < ring.length - 1 && i <= to.segment) {
      if (inRange(ring[i][0])) piece.push(ring[i]);
      i += 1;
    }
    piece.push(to.point);
    // 去重后仍需构成多边形
    const clean = [];
    for (const p of piece) {
      const last = clean[clean.length - 1];
      if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) clean.push(p);
    }
    if (clean.length >= 3) polygons.push(clean);
  }
  return polygons;
}

/** TopoJSON 弧解码（含量化变换：TopoJSON 用增量编码存储坐标） */
function decodeArcs(topology) {
  const { scale = [1, 1], translate = [0, 0] } = topology.transform || {};
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
}

/**
 * 旧实现保留：直接按 TopoJSON 弧索引拼环（不含日界线切分）
 */
function ringFromArcIndexes(arcs, indexes, decoded) {
  const points = [];
  for (const index of indexes) {
    const reverse = index < 0;
    const arc = decoded[reverse ? ~index : index];
    if (!arc) continue;
    const seq = reverse ? [...arc].reverse() : arc;
    for (let i = 0; i < seq.length; i += 1) {
      if (points.length && i === 0) continue; // 去掉相邻弧连接处的重复点
      points.push(seq[i]);
    }
  }
  return points;
}

/** 去掉连续重复点 */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-9 || Math.abs(last[1] - p[1]) > 1e-9) out.push(p);
  }
  return out;
}

/** 判断投影后的环是否退化（面积为零或接近零的线状环，绘制时只会留下一条假线） */
function isDegenerateRing(flat, width, height) {
  const n = flat.length / 2;
  if (n < 4) return true;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let area2 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = flat[i * 2];
    const y = flat[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const j = (i + 1) % n;
    area2 += x * flat[j * 2 + 1] - flat[j * 2] * y;
  }
  const area = Math.abs(area2) / 2;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // 线状环：包围盒很扁（高度不足 0.5 像素或宽度不足 0.5 像素）或面积小于 0.5 平方像素
  if (spanY < 0.5 || spanX < 0.5) return true;
  if (area < 0.5) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* 行政区划（admin-1）边界线                                            */
/* ------------------------------------------------------------------ */

/**
 * Natural Earth 1:110m / 1:50m 的「一级行政区边界线」。
 * 数据是 GeoJSON LineString / MultiLineString，投影方式与国界完全一致，
 * 前端只需要按普通折线描边即可，因此单独放一个 provinces 数组。
 */
const ADMIN1_SOURCES = {
  '110m': [
    'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_1_states_provinces_lines.geojson',
    'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_1_states_provinces_lines.geojson',
  ],
  '50m': [
    'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_1_states_provinces_lines.geojson',
    'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson',
  ],
};

/**
 * 把 GeoJSON 的 admin-1 边界线转成投影后的折线数组
 *
 * 每条线同时输出包围盒（bbox），前端据此做视口裁剪 ——
 * 否则每次平移缩放都要遍历上万个顶点，会明显掉帧。
 *
 * @param {object} geojson FeatureCollection
 * @returns {{ provinces: object[], dropped: number, scaled: number }}
 */
function buildAdmin1(geojson) {
  const provinces = [];
  let dropped = 0;
  let scaled = 0;

  const addLine = (coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    // 复用与国界相同的日界线切分，避免出现横贯全图的假线段
    const segments = clipToMapBounds(coords.map(([lon, lat]) => [lon, lat]));
    for (const segment of segments) {
      if (segment.length < 2) continue;
      const flat = [];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [lon, lat] of segment) {
        const [x, y] = project(lon, lat);
        flat.push(x, y);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      // 太短的线段（不足 1.5 像素）看不出效果，直接丢弃以压缩体积
      if (maxX - minX < 1.5 && maxY - minY < 1.5) {
        dropped += 1;
        continue;
      }
      if (segment.length !== coords.length) scaled += 1;
      provinces.push({
        p: flat,
        b: [Math.round(minX * 10) / 10, Math.round(minY * 10) / 10, Math.round(maxX * 10) / 10, Math.round(maxY * 10) / 10],
      });
    }
  };

  for (const feature of geojson.features || []) {
    const geom = feature.geometry;
    if (!geom) continue;
    if (geom.type === 'LineString') addLine(geom.coordinates);
    else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) addLine(line);
    }
  }
  return { provinces, dropped, scaled };
}

function build(topology, admin1Geo) {
  const decoded = decodeArcs(topology);
  const geometries = topology.objects.countries.geometries;

  const countries = [];
  let droppedRings = 0;
  let splitRingCount = 0;

  for (const geom of geometries) {
    const polygons =
      geom.type === 'Polygon' ? [geom.arcs] : geom.type === 'MultiPolygon' ? geom.arcs : [];
    const rings = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const polygon of polygons) {
      for (const ringIndexes of polygon) {
        const lonLat = dedupe(ringFromArcIndexes(topology.arcs, ringIndexes, decoded));
        if (lonLat.length < 4) continue;

        // 关键步骤：把跨日界线的环展开并裁剪到地图范围内，
        // 否则会在北半球画出一条横贯全图的"横条纹"
        const clipped = clipToMapBounds(lonLat);
        if (!clipped.length) {
          droppedRings += 1;
          continue;
        }
        if (clipped.length > 1 || clipped[0].length !== lonLat.length) splitRingCount += 1;

        for (const segment of clipped) {
          const flat = [];
          for (const [lon, lat] of segment) {
            const [x, y] = project(lon, lat);
            flat.push(x, y);
          }
          if (isDegenerateRing(flat, WIDTH, HEIGHT)) {
            droppedRings += 1;
            continue;
          }
          for (let i = 0; i < flat.length; i += 2) {
            const x = flat[i];
            const y = flat[i + 1];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
          rings.push(flat);
        }
      }
    }
    if (!rings.length) continue;
    const name = (geom.properties && (geom.properties.name || geom.properties.NAME)) || `#${geom.id}`;
    countries.push({
      id: geom.id,
      name,
      bbox: [Math.round(minX * 10) / 10, Math.round(minY * 10) / 10, Math.round(maxX * 10) / 10, Math.round(maxY * 10) / 10],
      rings,
    });
  }

  const admin1 = admin1Geo ? buildAdmin1(admin1Geo) : { provinces: [], dropped: 0, scaled: 0 };

  return {
    projection: 'equirectangular',
    width: WIDTH,
    height: HEIGHT,
    lonMin: LON_MIN,
    lonMax: LON_MAX,
    latMin: LAT_MIN,
    latMax: LAT_MAX,
    // 供前端校验/调试使用：经纬方向一致的比例尺
    pxPerDegree: PX_PER_DEGREE,
    aspectRatio: Math.round((WIDTH / HEIGHT) * 10000) / 10000,
    source: 'Natural Earth 1:110m（world-atlas TopoJSON）' + (admin1Geo ? ' + admin-1 州省边界线' : ''),
    generatedAt: new Date().toISOString(),
    stats: {
      countries: countries.length,
      rings: countries.reduce((acc, c) => acc + c.rings.length, 0),
      splitRings: splitRingCount,
      droppedRings,
      provinces: admin1.provinces.length,
      droppedProvinces: admin1.dropped,
      splitProvinces: admin1.scaled,
    },
    countries,
    /** 一级行政区（省/州/地区）边界线，元素为 [x,y,x,y,…] */
    provinces: admin1.provinces,
  };
}

async function main() {
  const argOut = process.argv.indexOf('--out');
  const outFile = path.resolve(argOut > -1 ? process.argv[argOut + 1] : path.join(__dirname, '..', 'public', 'data', 'world-110m.json'));

  let text = null;
  let usedSource = null;
  const errors = [];
  for (const url of SOURCES) {
    try {
      process.stdout.write(`→ 下载 ${url} … `);
      text = await fetchText(url);
      usedSource = url;
      console.log(`成功（${(text.length / 1024).toFixed(0)} KB）`);
      break;
    } catch (error) {
      console.log(`失败：${error.message}`);
      errors.push(`${url}: ${error.message}`);
    }
  }

  if (!text) {
    console.error('\n[错误] 所有地图数据源均不可用：');
    for (const e of errors) console.error('  - ' + e);
    console.error('\n请检查网络后重试，或在能联网的机器上执行本脚本并把生成的文件复制过来。');
    process.exit(1);
  }

  const topology = JSON.parse(text);

  // 行政区划（省/州/地区）边界线：默认使用 110m，可用 --admin1=50m 提高精度
  const admin1Arg = process.argv.find((a) => a.startsWith('--admin1='));
  const admin1Scale = admin1Arg ? admin1Arg.slice('--admin1='.length).trim() : '50m';
  const skipAdmin1 = process.argv.includes('--no-admin1');
  let admin1Geo = null;
  if (!skipAdmin1) {
    const urls = ADMIN1_SOURCES[admin1Scale] || ADMIN1_SOURCES['50m'];
    for (const url of urls) {
      try {
        process.stdout.write(`→ 下载行政区划边界 ${admin1Scale} … `);
        const json = await fetchText(url);
        admin1Geo = JSON.parse(json);
        console.log(`成功（${(json.length / 1024).toFixed(0)} KB）`);
        break;
      } catch (error) {
        console.log(`失败：${error.message}`);
        errors.push(`${url}: ${error.message}`);
      }
    }
    if (!admin1Geo) console.log('！ 行政区划边界获取失败，本次仅生成国界（地图仍可正常使用）');
  }

  const output = build(topology, admin1Geo);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output), 'utf8');

  const size = fs.statSync(outFile).size;
  console.log(`\n✓ 已生成 ${outFile}`);
  console.log(`  国家/地区数量：${output.countries.length}`);
  console.log(`  行政区划边界线：${output.stats.provinces} 条（丢弃过短 ${output.stats.droppedProvinces} 条）`);
  console.log(`  画布尺寸：${output.width}×${output.height}（等距圆柱投影，经度 ${LON_MIN}~${LON_MAX}，纬度 ${LAT_MIN}~${LAT_MAX}）`);
  console.log(`  文件体积：${(size / 1024).toFixed(1)} KB`);
  console.log(`  数据来源：${usedSource}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[错误]', error.message);
    process.exit(1);
  });
}

module.exports = {
  build,
  buildAdmin1,
  project,
  decodeArcs,
  ringFromArcIndexes,
  clipToMapBounds,
  clipPolygonToLonRange,
  closeRing,
  isDegenerateRing,
  splitAtLonLine,
  shortestLonDelta,
};
