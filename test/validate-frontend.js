'use strict';
// 前端静态校验：关键 DOM id、标签闭合、脚本引用顺序
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

const requiredIds = [
  'map-canvas', 'node-overlay', 'canvas-wrap', 'map-hint', 'map-stats',
  'stat-target', 'stat-hops', 'stat-located', 'stat-unlocated', 'stat-rtt', 'stat-countries', 'stat-distance',
  'hops-table', 'hops-count', 'latency-chart', 'conn-content', 'ports-content', 'local-content',
  'dns-content', 'security-content', 'node-card', 'node-card-body', 'node-card-close',
  'sidebar', 'inspector', 'sidebar-backdrop', 'btn-sidebar', 'btn-panel', 'tab-close',
  'target-form', 'target-input', 'btn-run', 'btn-diagnose', 'btn-export', 'btn-selftest',
  'server-status', 'quick-targets', 'toast-stack', 'progress-bar', 'progress-inner', 'progress-text',
  'btn-local', 'btn-egress', 'btn-scan', 'opt-listenports', 'opt-scanmode', 'field-scanports',
  'field-scanrange', 'opt-scanports', 'opt-scanfrom', 'opt-scanto', 'opt-maxhops', 'opt-queries',
  'opt-timeout', 'opt-resolvenames', 'opt-engine', 'opt-color', 'opt-show-labels', 'opt-show-links',
  'opt-show-grid', 'opt-show-admin1', 'opt-animate', 'opt-night', 'val-maxhops', 'val-queries', 'val-timeout',
  'btn-zoom-in', 'btn-zoom-out', 'btn-reset-view',
  // 高德地图与局域网扫描相关
  'opt-basemap', 'basemap-status', 'btn-lanscan', 'btn-settings', 'opt-deepscan',
  'settings-modal', 'settings-close', 'amap-key', 'amap-security', 'amap-enabled',
  'amap-save', 'amap-test', 'amap-clear', 'amap-test-result',
  // 叠加层与图例
  'amap-host', 'overlay-canvas', 'legend-panel', 'btn-legend', 'legend-close',
];

let failures = 0;
for (const id of requiredIds) {
  const ok = html.includes('id="' + id + '"');
  if (!ok) {
    failures += 1;
    console.log('✘ 缺少 DOM id: ' + id);
  }
}
console.log(`DOM id 检查：${requiredIds.length - failures}/${requiredIds.length} 存在`);

// 统计各类标签的开闭是否平衡（只做粗粒度检查，足以发现结构性破坏）
const pairs = [['div', /<div\b/g, /<\/div>/g], ['aside', /<aside\b/g, /<\/aside>/g], ['section', /<section\b/g, /<\/section>/g], ['span', /<span\b/g, /<\/span>/g], ['button', /<button\b/g, /<\/button>/g], ['dl', /<dl\b/g, /<\/dl>/g]];
for (const [name, open, close] of pairs) {
  const o = (html.match(open) || []).length;
  const c = (html.match(close) || []).length;
  const ok = o === c;
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✘'} <${name}> 开 ${o} / 闭 ${c}`);
}

// 脚本引用顺序必须满足依赖关系
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const expectedOrder = ['js/runtime-config.js', 'js/config.js', 'js/api.js', 'js/draw.js', 'js/amap-overlay.js', 'js/export.js', 'js/app.js'];
const orderOk = JSON.stringify(scripts) === JSON.stringify(expectedOrder);
if (!orderOk) failures += 1;
console.log(`${orderOk ? '✔' : '✘'} 脚本顺序: ${scripts.join(' → ')}`);

// 引用的静态文件必须真实存在
for (const src of scripts.concat(['css/style.css', 'data/world-110m.json'])) {
  const p = path.join(root, 'public', src);
  const exists = fs.existsSync(p);
  if (!exists) failures += 1;
  console.log(`${exists ? '✔' : '✘'} 资源存在: public/${src}`);
}

console.log(failures ? `\n前端静态校验失败（${failures} 项）` : '\n前端静态校验全部通过');
process.exit(failures ? 1 : 0);
