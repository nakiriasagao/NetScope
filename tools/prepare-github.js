'use strict';
/**
 * GitHub 上传前检查：确认远端可达、仓库状态、当前分支与差异
 * 用法：node tools/prepare-github.js [--local-only]
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'https://github.com/nakiriasagao/NetScope.git';

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.stdio || 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: options.prompt === false ? '0' : '1' },
    timeout: options.timeout || 120000,
  });
  return {
    code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error ? result.error.code : null,
  };
}

function step(title) {
  console.log('\n=== ' + title + ' ===');
}

step('仓库状态');
const isRepo = git(['rev-parse', '--is-inside-work-tree']);
if (isRepo.stdout !== 'true') {
  console.log('当前目录尚未初始化 git 仓库（这是第一次上传，稍后会 git init）');
} else {
  console.log('已是 git 仓库');
}

step('远端可达性与认证');
const lsRemote = git(['ls-remote', '--heads', REPO], { prompt: false, timeout: 90000 });
if (lsRemote.code === 0) {
  console.log('✔ 远端可访问，已认证');
  console.log('  远端分支：' + (lsRemote.stdout ? lsRemote.stdout.split('\n').map((l) => l.split('\t')[1]).join(', ') : '（空仓库）'));
} else {
  console.log('✘ 远端访问失败（退出码 ' + lsRemote.code + '）');
  console.log('  stderr: ' + lsRemote.stderr.slice(0, 400));
  if (/could not read Username|terminal prompts disabled|Authentication failed/i.test(lsRemote.stderr)) {
    console.log('  → 需要 GitHub 凭据（HTTPS 需要用户名 + Personal Access Token）');
  }
  if (/not found|404/i.test(lsRemote.stderr)) {
    console.log('  → 远端仓库可能不存在或无权访问');
  }
}

step('忽略规则检查');
const gi = path.join(ROOT, '.gitignore');
console.log(fs.existsSync(gi) ? '.gitignore 已存在：\n' + fs.readFileSync(gi, 'utf8') : '.gitignore 不存在');
