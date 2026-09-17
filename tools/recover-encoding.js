'use strict';
/**
 * draw.js 编码损坏恢复工具
 *
 * 事故原因：用 PowerShell 的 Get-Content/Set-Content 往返读写 UTF-8 文件时，
 * 文件内容被按系统 ANSI 代码页（GBK）误解码，再以 UTF-8 存回，
 * 于是每个汉字变成 2~3 个乱码字符（"限制" → "闄愬埗"）。
 *
 * 恢复原理：
 *   损坏是「UTF-8 字节 → 按 GBK 解码 → 存成 UTF-8」，只要把乱码字符串
 *   用 GBK 重新编码回字节，就得到原始 UTF-8 字节，再按 UTF-8 解码即可复原。
 *   为避免依赖 PowerShell 的代码页选择，这里用 Node 内置的 TextDecoder('gbk')
 *   自己构建「字符 → GBK 字节」反向表。
 */

const fs = require('fs');

/** 构建 GBK 反向编码表：字符 → 字节序列 */
function buildGbkEncoder() {
  const map = new Map();
  const decoder = new TextDecoder('gbk', { fatal: false });
  // 单字节区（ASCII）
  for (let b = 0x00; b <= 0x7f; b += 1) {
    map.set(String.fromCharCode(b), [b]);
  }
  // 双字节区
  const buf = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue;
      buf[0] = lead;
      buf[1] = trail;
      const text = decoder.decode(buf);
      // 只接受“恰好解出一个非替换字符”的组合，保证映射唯一
      if (text.length === 1 && text.charCodeAt(0) !== 0xfffd && !map.has(text)) {
        map.set(text, [lead, trail]);
      }
    }
  }
  return map;
}

function encodeGbk(text, table) {
  const out = [];
  const missing = new Set();
  for (const ch of text) {
    const bytes = table.get(ch);
    if (bytes) {
      out.push(...bytes);
      continue;
    }
    // 回退：尝试 latin1（单字节）表示，仍失败则记录缺失
    const code = ch.codePointAt(0);
    if (code <= 0xff) out.push(code);
    else missing.add(ch);
  }
  return { bytes: Buffer.from(out), missing: [...missing] };
}

function main() {
  const target = process.argv[2] || 'public/js/draw.js';
  const output = process.argv[3] || target;

  const damaged = fs.readFileSync(target, 'utf8').replace(/^\ufeff/, '');
  const table = buildGbkEncoder();
  console.log(`GBK 反向表条目数：${table.size}`);

  const { bytes, missing } = encodeGbk(damaged, table);
  if (missing.length) {
    console.log(`✘ 有 ${missing.length} 个字符无法映射回 GBK 字节，无法无损恢复：`);
    console.log('  ' + missing.slice(0, 40).join(' '));
    process.exit(1);
  }

  const restored = bytes.toString('utf8');
  if (restored.includes('\ufffd')) {
    // 定位所有替换字符的位置，输出其上下文十六进制，便于判断是哪些字节丢失
    const positions = [];
    for (let i = 0; i < restored.length && positions.length < 10; i += 1) {
      if (restored[i] === '\ufffd') positions.push(i);
    }
    console.log(`✘ 恢复结果包含 ${positions.length} 处替换字符，说明有字节丢失`);
    for (const pos of positions) {
      const charIndex = (restored.slice(0, pos).match(/[\s\S]/g) || []).length;
      const bytePos = Buffer.byteLength(restored.slice(0, pos), 'utf8');
      const from = Math.max(0, bytePos - 24);
      const to = Math.min(bytes.length, bytePos + 24);
      console.log(`  位置 ${pos}（字节 ${bytePos}）上下文: ${bytes.subarray(from, to).toString('hex')}`);
      console.log(`    损坏源文本: ${JSON.stringify(damaged.slice(Math.max(0, charIndex - 24), charIndex + 24))}`);
    }
    fs.writeFileSync(output + '.partial', restored, 'utf8');
    console.log(`  已写出部分恢复结果供检查：${output}.partial`);
    process.exit(1);
  }

  // 自校验：把恢复结果再按 GBK 解码，应当回到损坏文本
  const roundTrip = new TextDecoder('gbk', { fatal: false }).decode(Buffer.from(restored, 'utf8'));
  const exact = roundTrip === damaged;
  console.log(`自校验（恢复结果按 GBK 重新解码 == 原损坏文本）：${exact ? '✔ 通过' : '✘ 不通过'}`);
  if (!exact) {
    // 找出第一处差异，便于定位
    let i = 0;
    while (i < Math.min(roundTrip.length, damaged.length) && roundTrip[i] === damaged[i]) i += 1;
    console.log(`  首个差异位于第 ${i} 个字符：`);
    console.log('  原损坏: ' + JSON.stringify(damaged.slice(Math.max(0, i - 30), i + 30)));
    console.log('  再编码: ' + JSON.stringify(roundTrip.slice(Math.max(0, i - 30), i + 30)));
  }

  fs.writeFileSync(output, restored, 'utf8');
  console.log(`✔ 已写出恢复文件：${output}（${restored.length} 字符，${Buffer.byteLength(restored, 'utf8')} 字节）`);
  console.log('  抽样 : ' + JSON.stringify(restored.slice(0, 90)));
}

main();
