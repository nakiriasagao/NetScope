/* NetScope 前端配置
 *
 * API 基地址解析顺序：
 *   1. URL 查询参数 ?api=http://host:port
 *   2. 服务端启动时写入的 js/runtime-config.js（window.NETSCOPE_RUNTIME.apiBase）
 *   3. 页面自身的 origin（同源部署时直接可用）
 *   4. 本地默认 http://127.0.0.1:8787
 *
 * 之所以需要第 4 步：前端页面也可能被直接用 file:// 打开，
 * 此时不存在同源后端，需要指向本机默认端口。
 */
(function () {
  'use strict';

  var DEFAULT_PORT = 8787;

  function fromQuery() {
    try {
      var params = new URLSearchParams(window.location.search);
      var api = params.get('api');
      if (api) return api.replace(/\/+$/, '');
    } catch (e) {
      /* 忽略 */
    }
    return null;
  }

  function fromRuntimeConfig() {
    var runtime = window.NETSCOPE_RUNTIME;
    if (runtime && runtime.apiBase) return String(runtime.apiBase).replace(/\/+$/, '');
    return null;
  }

  function fromOrigin() {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return window.location.origin;
    }
    return null;
  }

  var apiBase = fromQuery() || fromRuntimeConfig() || fromOrigin() || 'http://127.0.0.1:' + DEFAULT_PORT;

  window.NetScopeConfig = {
    apiBase: apiBase,
    version: (window.NETSCOPE_RUNTIME && window.NETSCOPE_RUNTIME.version) || '1.0.0',
    /** 默认探测参数（与后端 config.js 保持一致） */
    defaults: {
      maxHops: 30,
      queries: 3,
      timeoutMs: 900,
      resolveNames: true,
      engine: 'auto',
    },
    /** 地图配色 */
    colors: {
      ocean: 'rgba(9, 16, 30, 0.85)',
      land: '#16273f',
      landStroke: '#26456b',
      /** 一级行政区（省/州/地区）边界：比国界更淡，放大后才渐显 */
      admin1: 'rgba(120, 165, 220, 0.42)',
      graticule: 'rgba(56, 189, 248, 0.08)',
      route: '#38bdf8',
      routeSlow: '#f87171',
      routeMid: '#fbbf24',
      start: '#34d399',
      target: '#f472b6',
      timeout: '#5b6b85',
      label: '#dbe9ff',
      arcGlow: 'rgba(56, 189, 248, 0.35)',
    },
    /** 延迟分级阈值（毫秒）：<good 绿、<mid 黄、其余红 */
    latencyThresholds: { good: 60, mid: 180 },
  };
})();
