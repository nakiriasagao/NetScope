'use strict';

/**
 * 后台任务管理：为长耗时探测（traceroute / 端口扫描 / DNS 委派追踪）提供
 *  - 任务注册与状态查询
 *  - AbortController 取消
 *  - 单类任务并发上限，避免把本机网络打爆
 */

const crypto = require('crypto');

const tasks = new Map();
const MAX_FINISHED = 60;

function createTask(kind, meta = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  const controller = new AbortController();
  const task = {
    id,
    kind,
    meta,
    controller,
    signal: controller.signal,
    createdAt: Date.now(),
    finishedAt: null,
    status: 'running',
    progress: null,
    result: null,
    error: null,
    cancelReason: null,
  };
  tasks.set(id, task);
  pruneFinished();
  return task;
}

function finishTask(task, { result = null, error = null, status } = {}) {
  if (!task) return;
  task.finishedAt = Date.now();
  task.result = result;
  task.error = error ? (error.message || String(error)) : null;
  task.status = status || (error ? 'failed' : 'done');
  pruneFinished();
}

function cancelTask(id, reason = '用户取消') {
  const task = tasks.get(id);
  if (!task) return null;
  task.cancelReason = reason;
  try {
    task.controller.abort();
  } catch (_) {
    /* ignore */
  }
  return task;
}

function getTask(id) {
  return tasks.get(id) || null;
}

function pruneFinished() {
  const finished = [...tasks.values()].filter((t) => t.status !== 'running').sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  while (finished.length > MAX_FINISHED) {
    const t = finished.shift();
    tasks.delete(t.id);
  }
}

function runningCount(kind) {
  let n = 0;
  for (const t of tasks.values()) {
    if (t.status === 'running' && (!kind || t.kind === kind)) n += 1;
  }
  return n;
}

function listTasks() {
  return [...tasks.values()].map((t) => ({
    id: t.id,
    kind: t.kind,
    status: t.status,
    meta: t.meta,
    createdAt: new Date(t.createdAt).toISOString(),
    finishedAt: t.finishedAt ? new Date(t.finishedAt).toISOString() : null,
    error: t.error,
  }));
}

module.exports = { createTask, finishTask, cancelTask, getTask, runningCount, listTasks, tasks };
