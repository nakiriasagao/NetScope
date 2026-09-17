'use strict';
/**
 * 把项目发布到 GitHub 仓库
 * 用法：node tools/publish-github.js [--message "提交说明"] [--dry-run]
 *
 * 说明：不引入任何第三方依赖，直接用 git 命令完成 init / add / commit / push。
 *      推送使用系统凭据管理器中的 GitHub 凭据（HTTPS + Personal Access Token）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO_URL = 'https://github.com/nakiriasagao/webtraceor.git';
const BRANCH = 'main';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DRY_RUN = process.argv.includes('--dry-run');
const COMMIT_MESSAGE =
  arg('--message', null) ||
  [
    'feat: NetScope 网络连接探测与世界地图拓扑可视化',
    '',
    '输入 IP / 域名 / 网址即可：',
    '  · 解析目标（DNS、反向解析、地址性质判定）',
    '  · 探测连通性（ICMP 延迟丢包、TCP 端口、HTTP(S) 响应、TLS 证书）',
    '  · 追踪完整路由（原生 ICMP 套接字 + 系统 tracert 双引擎，自动降级）',
    '  · 地理定位每一跳（多数据源降级 + 磁盘缓存 + 内置离线库）',
    '  · 在世界地图上绘制完整网络拓扑图（延迟着色、数据包流动画）',
    '  · 查看当前网络的拓扑图（网卡/网关/DNS/ARP/监听端口/公网出口）',
    '',
    '技术要点：',
    '  · 零第三方运行时依赖，只用 Node 内置模块，Node >= 18',
    '  · 前端 Canvas + SVG 手写渲染，世界地图数据在构建期预投影，运行时不依赖 CDN',
    '  · 命令输出三级捕获策略（管道 → PowerShell 文件重定向 → cmd 重定向），适配受限环境',
    '  · 多编码自动识别（UTF-8 / GBK / Big5 / UTF-16），中文 Windows 输出不乱码',
    '  · 连线只连接能确定地理位置的节点，未定位跳点不参与拓扑连线',
    '  · 地图数据在构建期按日界线切分并裁剪多边形，消除跨 ±180° 造成的横条纹',
    '',
    '测试：单元 100 用例、接口冒烟 12 项、浏览器端到端、渲染对抗性审计、前端静态校验',
  ].join('\n');

function run(args, options = {}) {
  console.log('\n$ git ' + args.join(' '));
  const result = spawnSync('git', args, {
    cwd: ROOT,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: options.prompt === false ? '0' : '1' },
    timeout: options.timeout || 300000,
  });
  if (result.error) throw new Error(`执行 git 失败：${result.error.message}`);
  if (options.capture) {
    return { code: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
  }
  if (result.status !== 0) throw new Error(`git ${args[0]} 执行失败（退出码 ${result.status}）`);
  return { code: 0 };
}

function main() {
  console.log('项目目录：' + ROOT);
  console.log('目标仓库：' + REPO_URL);
  if (DRY_RUN) console.log('（--dry-run：只做检查，不提交与推送）');

  // 1) 初始化仓库
  const inside = run(['rev-parse', '--is-inside-work-tree'], { capture: true, prompt: false });
  if (inside.stdout !== 'true') {
    run(['init', '-b', BRANCH]);
  } else {
    console.log('\n已是 git 仓库，跳过 init');
  }

  // 2) 确认提交者信息
  const name = run(['config', 'user.name'], { capture: true }).stdout;
  const email = run(['config', 'user.email'], { capture: true }).stdout;
  if (!name || !email) {
    throw new Error('缺少 git 提交者信息，请先设置：git config --global user.name "名字" 与 user.email "邮箱"');
  }
  console.log(`提交者：${name} <${email}>`);

  // 3) 设置远端
  const remotes = run(['remote'], { capture: true }).stdout.split('\n').filter(Boolean);
  if (!remotes.includes('origin')) {
    run(['remote', 'add', 'origin', REPO_URL]);
  } else {
    run(['remote', 'set-url', 'origin', REPO_URL]);
  }

  // 4) 暂存并查看将要提交的内容
  run(['add', '-A']);
  const status = run(['status', '--short'], { capture: true }).stdout;
  const fileCount = status ? status.split('\n').length : 0;
  console.log(`\n待提交文件数：${fileCount}`);
  if (fileCount === 0) {
    console.log('没有需要提交的改动。');
  } else {
    const preview = status.split('\n').slice(0, 25).join('\n');
    console.log(preview + (fileCount > 25 ? `\n… 其余 ${fileCount - 25} 个文件` : ''));
    // 安全检查：运行期产物不应被提交
    const leaked = status
      .split('\n')
      .filter((line) => /geoip-cache\.json|runtime-config\.js|data\/screenshots|data\\screenshots/.test(line));
    if (leaked.length) {
      console.log('\n⚠ 注意：以下运行期文件出现在待提交列表中，建议确认是否应忽略：');
      leaked.forEach((l) => console.log('   ' + l));
    }
  }

  if (DRY_RUN) {
    console.log('\n--dry-run 结束，未提交。');
    return;
  }

  // 5) 提交
  if (fileCount > 0) {
    run(['commit', '-F', writeMessageFile()]);
  }

  // 6) 推送
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).stdout || BRANCH;
  console.log(`\n当前分支：${branch}`);
  run(['push', '-u', 'origin', `${branch}:${BRANCH}`], { prompt: false, timeout: 600000 });

  // 7) 结果
  const log = run(['log', '--oneline', '-1'], { capture: true }).stdout;
  const remoteRef = run(['ls-remote', '--heads', 'origin', BRANCH], { capture: true }).stdout;
  console.log('\n================ 发布结果 ================');
  console.log('最新提交：' + log);
  console.log('远端分支：' + (remoteRef || '（未找到，请检查推送输出）'));
  console.log('仓库地址：https://github.com/nakiriasagao/webtraceor');
}

function writeMessageFile() {
  const file = path.join(ROOT, '.git-commit-message.txt');
  fs.writeFileSync(file, COMMIT_MESSAGE, 'utf8');
  return file;
}

try {
  main();
} catch (error) {
  console.error('\n✘ 发布失败：' + error.message);
  process.exit(1);
}
