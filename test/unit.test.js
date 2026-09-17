'use strict';

/**
 * NetScope 单元测试（零第三方依赖）
 *
 * 运行方式：
 *   cd D:\DSH\NetScope
 *   node --test test/unit.test.js          # 直接跑本文件
 *   node test/run-tests.js                 # 汇总入口（含 smoke）
 *
 * 设计约束：
 *   1. 只使用 Node 内置模块（node:test / node:assert / node:buffer），不引入任何第三方包；
 *   2. 全部为纯函数与内存样本，不执行真实系统命令（不调用 icmpPing / traceRoute 等），
 *      不访问外网，可重复运行；
 *   3. 被测业务代码位于 src/ 下，本测试不修改任何业务代码；
 *      发现的真实缺陷统一登记在文件末尾的「已知缺陷」describe 中（skip，不阻塞 CI），
 *      并在测试报告里给出文件名 + 行号 + 现象 + 建议修法。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const iputils = require('../src/core/iputils');
const parsers = require('../src/core/parsers');
const { decodeBest, scoreText, supportsEncoding } = require('../src/core/exec');
const sysinfo = require('../src/core/sysinfo');
const geo = require('../src/core/geo');
const reachability = require('../src/core/reachability');
const routes = require('../src/api/routes');

const { parseTraceroute, parsePing } = parsers;
const { isIPv4, isIPv6, isIP, ipv4ToInt, isInCidr4, classifyIP, isPrivateIP, parseTarget, cidrOf } = iputils;

/** 由行数组拼装样本，避免在断言里混入转义字符 */
const lines = (...rows) => rows.join('\n');

/* ================================================================== */
/* 样本：traceroute / tracert                                          */
/* ================================================================== */

// 1) Windows 中文 tracert：<1 毫秒 / 请求超时。/ 通过最多 30 个跃点跟踪到 … 的路由: / 跟踪完成。
const TRACE_WIN_CN = lines(
  '通过最多 30 个跃点跟踪到 www.baidu.com [110.242.68.3] 的路由:',
  '',
  '  1    <1 毫秒   <1 毫秒   <1 毫秒  192.168.1.1',
  '  2     2 ms     1 ms     2 ms  100.64.0.1',
  '  3     *        *        *     请求超时。',
  '  4     5 ms     4 ms     5 ms  202.97.58.90 [上海市 电信]',
  '  5     8 ms     7 ms     8 ms  110.242.68.3',
  '',
  '跟踪完成。',
  '',
);

// 2) Windows 英文 tracert：<1 ms / Request timed out. / Trace complete.
const TRACE_WIN_EN = lines(
  'Tracing route to www.google.com [142.250.72.196]',
  'over a maximum of 30 hops:',
  '',
  '  1     1 ms     1 ms     1 ms  192.168.1.1',
  '  2     *        *        *     Request timed out.',
  '  3    10 ms     9 ms    10 ms  10.0.0.1',
  '  4    12 ms    11 ms    12 ms  142.250.72.196',
  '',
  'Trace complete.',
  '',
);

// 3) Linux traceroute -n（数字形式 + “* * *” 超时跳）
const TRACE_NIX = lines(
  'traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets',
  ' 1  192.168.1.1  1.234 ms  1.5 ms  1.6 ms',
  ' 2  10.0.0.1  5.123 ms  5.2 ms  5.3 ms',
  ' 3  * * *',
  ' 4  202.97.58.90  20.456 ms  20.5 ms  20.6 ms',
  ' 5  8.8.8.8  30.123 ms  30.2 ms  30.3 ms',
  '',
);

// 4) 混合域名形式："ptr (IP)" 与 "IP [ptr]"
const TRACE_MIXED = lines(
  'traceroute to gateway.local (10.0.0.1), 30 hops max, 38 byte packets',
  ' 1  router.local (192.168.1.1)  0.512 ms  0.480 ms  0.470 ms',
  ' 2  gateway.local (10.0.0.1)  2.3 ms  2.4 ms  2.5 ms',
  ' 3  203.0.113.5 [ptr.example.net]  10.1 ms  10.2 ms  10.3 ms',
  ' 4  * * *',
  ' 5  edge.example.org (198.51.100.7)  15.0 ms  15.1 ms  15.2 ms',
  '',
);

// 附加：单跳部分丢包（3 次探测只响应 2 次）
const TRACE_PARTIAL_LOSS = lines(
  'traceroute to 1.1.1.1 (1.1.1.1), 30 hops max, 60 byte packets',
  ' 1  192.168.1.1  1.0 ms  1.1 ms  1.2 ms',
  ' 2  10.0.0.1  4.5 ms  *  4.7 ms',
  ' 3  * * *',
  '',
);

/* ================================================================== */
/* 样本：ping                                                          */
/* ================================================================== */

// Windows 中文 ping：4 发 4 收
const PING_WIN_CN = lines(
  '正在 Ping www.baidu.com [110.242.68.3] 具有 32 字节的数据:',
  '来自 110.242.68.3 的回复: 字节=32 时间=10ms TTL=51',
  '来自 110.242.68.3 的回复: 字节=32 时间=11ms TTL=51',
  '来自 110.242.68.3 的回复: 字节=32 时间=9ms TTL=51',
  '来自 110.242.68.3 的回复: 字节=32 时间=10ms TTL=51',
  '',
  '110.242.68.3 的 Ping 统计信息:',
  '    数据包: 已发送 = 4，已接收 = 4，丢失 = 0 (0% 丢失)，',
  '往返行程的估计时间(以毫秒为单位):',
  '    最短 = 9ms，最长 = 11ms，平均 = 10ms',
  '',
);

// Windows 中文 ping：丢 2 个（覆盖中文统计行的丢包分支）
const PING_WIN_CN_LOSS = lines(
  '正在 Ping www.baidu.com [110.242.68.3] 具有 32 字节的数据:',
  '来自 110.242.68.3 的回复: 字节=32 时间=10ms TTL=51',
  '请求超时。',
  '来自 110.242.68.3 的回复: 字节=32 时间=12ms TTL=51',
  '请求超时。',
  '',
  '110.242.68.3 的 Ping 统计信息:',
  '    数据包: 已发送 = 4，已接收 = 2，丢失 = 2 (50% 丢失)，',
  '往返行程的估计时间(以毫秒为单位):',
  '    最短 = 10ms，最长 = 12ms，平均 = 11ms',
  '',
);

// Windows 英文 ping（含 time<1ms 的亚毫秒回复）
const PING_WIN_EN = lines(
  'Pinging www.example.com [93.184.216.34] with 32 bytes of data:',
  'Reply from 93.184.216.34: bytes=32 time=14ms TTL=56',
  'Reply from 93.184.216.34: bytes=32 time=15ms TTL=56',
  'Reply from 93.184.216.34: bytes=32 time=13ms TTL=56',
  'Reply from 93.184.216.34: bytes=32 time<1ms TTL=128',
  '',
  'Ping statistics for 93.184.216.34:',
  '    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),',
  'Approximate round trip times in milli-seconds:',
  '    Minimum = 1ms, Maximum = 15ms, Average = 10ms',
  '',
);

// Linux ping：3 发 3 收 + rtt min/avg/max/mdev 汇总行
const PING_NIX = lines(
  'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.',
  '64 bytes from 8.8.8.8: icmp_seq=1 ttl=115 time=30.1 ms',
  '64 bytes from 8.8.8.8: icmp_seq=2 ttl=115 time=30.4 ms',
  '64 bytes from 8.8.8.8: icmp_seq=3 ttl=115 time=29.8 ms',
  '',
  '--- 8.8.8.8 ping statistics ---',
  '4 packets transmitted, 3 received, 25% packet loss, time 3004ms',
  'rtt min/avg/max/mdev = 29.812/30.104/30.421/0.267 ms',
  '',
);

// 全部超时
const PING_DEAD = lines(
  '正在 Ping 10.255.255.1 具有 32 字节的数据:',
  '请求超时。',
  '请求超时。',
  '请求超时。',
  '请求超时。',
  '',
  '10.255.255.1 的 Ping 统计信息:',
  '    数据包: 已发送 = 4，已接收 = 0，丢失 = 4 (100% 丢失)，',
  '',
);

/* ================================================================== */
/* 样本：ipconfig / arp / netstat / route                              */
/* ================================================================== */

// Windows 英文 ipconfig /all：含 ". . . ." 填充、DNS 续行、无地址的隧道/无线虚拟段落
const IPCONFIG_EN = lines(
  'Windows IP Configuration',
  '',
  '   Host Name . . . . . . . . . . . . : DESKTOP-ABC123',
  '   Node Type . . . . . . . . . . . . : Hybrid',
  '   IP Routing Enabled. . . . . . . . : No',
  '',
  'Ethernet adapter Ethernet:',
  '',
  '   Connection-specific DNS Suffix  . :',
  '   Description . . . . . . . . . . . : Realtek PCIe GbE Family Controller',
  '   Physical Address. . . . . . . . . : 00-1A-2B-3C-4D-5E',
  '   DHCP Enabled. . . . . . . . . . . : Yes',
  '   IPv4 Address. . . . . . . . . . . : 192.168.1.100(Preferred)',
  '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
  '   Default Gateway . . . . . . . . . : 192.168.1.1',
  '   DHCP Server . . . . . . . . . . . : 192.168.1.1',
  '   DNS Servers . . . . . . . . . . . : 192.168.1.1',
  '                                       8.8.8.8',
  '   NetBIOS over Tcpip. . . . . . . . : Enabled',
  '',
  'Tunnel adapter Teredo Tunneling Pseudo-Interface:',
  '',
  '   Description . . . . . . . . . . . : Microsoft Teredo Tunneling Adapter',
  '   Physical Address. . . . . . . . . : 00-00-00-00-00-00-00-E0',
  '',
  'Wireless LAN adapter WLAN:',
  '',
  '   Media State . . . . . . . . . . . : Media disconnected',
  '   Description . . . . . . . . . . . : Intel(R) Wi-Fi 6 AX201 160MHz',
  '',
);

// Windows 中文 ipconfig /all：结构与上面一一对应
const IPCONFIG_CN = lines(
  'Windows IP 配置',
  '',
  '   主机名  . . . . . . . . . . . . . : DESKTOP-ABC123',
  '   节点类型  . . . . . . . . . . . . : 混合',
  '',
  '以太网适配器 以太网:',
  '',
  '   连接特定的 DNS 后缀 . . . . . . . :',
  '   描述. . . . . . . . . . . . . . . : Realtek PCIe GbE Family Controller',
  '   物理地址. . . . . . . . . . . . . : 00-1A-2B-3C-4D-5E',
  '   DHCP 已启用 . . . . . . . . . . . : 是',
  '   IPv4 地址 . . . . . . . . . . . . : 192.168.1.100(首选)',
  '   子网掩码  . . . . . . . . . . . . : 255.255.255.0',
  '   默认网关. . . . . . . . . . . . . : 192.168.1.1',
  '   DHCP 服务器 . . . . . . . . . . . : 192.168.1.1',
  '   DNS 服务器  . . . . . . . . . . . : 192.168.1.1',
  '                                       8.8.8.8',
  '   TCPIP 上的 NetBIOS  . . . . . . . : 已启用',
  '',
  '隧道适配器 Teredo Tunneling Pseudo-Interface:',
  '',
  '   描述. . . . . . . . . . . . . . . : Microsoft Teredo Tunneling Adapter',
  '   物理地址. . . . . . . . . . . . . : 00-00-00-00-00-00-00-E0',
  '',
  '无线局域网适配器 WLAN:',
  '',
  '   媒体状态  . . . . . . . . . . . . : 媒体已断开连接',
  '   描述. . . . . . . . . . . . . . . : Intel(R) Wi-Fi 6 AX201 160MHz',
  '',
);

const ARP_EN = lines(
  'Interface: 192.168.1.100 --- 0xb',
  '  Internet Address      Physical Address      Type',
  '  192.168.1.1           aa-bb-cc-dd-ee-ff     dynamic',
  '  192.168.1.50          11-22-33-44-55-66     dynamic',
  '  192.168.1.255         ff-ff-ff-ff-ff-ff     static',
  '  224.0.0.22            01-00-5e-00-00-16     static',
  '  255.255.255.255       ff-ff-ff-ff-ff-ff     static',
  '  0.0.0.0               00-00-00-00-00-00     static',
  '',
);

const ARP_CN = lines(
  '接口: 192.168.1.100 --- 0xb',
  '  Internet 地址         物理地址              类型',
  '  192.168.1.1           aa-bb-cc-dd-ee-ff     动态',
  '  192.168.1.50          11-22-33-44-55-66     动态',
  '  192.168.1.255         ff-ff-ff-ff-ff-ff     静态',
  '  255.255.255.255       ff-ff-ff-ff-ff-ff     静态',
  '  239.255.255.250       01-00-5e-7f-ff-fa     静态',
  '',
);

const NETSTAT = lines(
  '',
  '活动连接',
  '',
  '  协议  本地地址          外部地址        状态           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1120',
  '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
  '  TCP    127.0.0.1:5354         0.0.0.0:0              LISTENING       3216',
  '  TCP    192.168.1.100:52341    110.242.68.3:443       ESTABLISHED     9876',
  '  TCP    192.168.1.100:52342    110.242.68.3:443       TIME_WAIT       0',
  '  UDP    0.0.0.0:500            *:*                                    1188',
  '  UDP    127.0.0.1:1900         *:*                                    4321',
  '  UDP    [::]:3702              *:*                                    2244',
  '  UDP    0.0.0.0:500            *:*                                    1188',
  '',
);

const ROUTE_WIN = lines(
  '===========================================================================',
  '接口列表',
  ' 12...00 1a 2b 3c 4d 5e ......Realtek PCIe GbE Family Controller',
  '===========================================================================',
  'IPv4 路由表',
  '===========================================================================',
  '活动路由:',
  '网络目标        网络掩码          网关       接口   跃点数',
  '          0.0.0.0          0.0.0.0     192.168.1.1     192.168.1.100     25',
  '        127.0.0.0        255.0.0.0        在链路上         127.0.0.1    331',
  '        192.168.1.0    255.255.255.0     192.168.1.1     192.168.1.100     26',
  '    192.168.1.255  255.255.255.255        在链路上     192.168.1.100    281',
  '===========================================================================',
  '',
);

const ROUTE_LINUX = lines(
  'default via 192.168.1.1 dev eth0 proto dhcp src 192.168.1.100 metric 100',
  '192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.100 metric 100',
  'default via 10.0.0.1 dev wlan0 metric 600',
  '',
);

/* ================================================================== */
/* 1. iputils                                                          */
/* ================================================================== */

describe('iputils：IP 判定与目标解析', () => {
  it('isIPv4 接受合法点分十进制', () => {
    assert.strictEqual(isIPv4('0.0.0.0'), true);
    assert.strictEqual(isIPv4('192.168.1.1'), true);
    assert.strictEqual(isIPv4('255.255.255.255'), true);
    assert.strictEqual(isIPv4(' 8.8.8.8 '), true, '应容忍首尾空白');
  });

  it('isIPv4 拒绝越界、前导零与非数字', () => {
    assert.strictEqual(isIPv4('256.1.1.1'), false);
    assert.strictEqual(isIPv4('192.168.1'), false);
    assert.strictEqual(isIPv4('192.168.01.1'), false, '前导零易与八进制混淆，应拒绝');
    assert.strictEqual(isIPv4('abc'), false);
    assert.strictEqual(isIPv4(''), false);
    assert.strictEqual(isIPv4(null), false);
  });

  it('isIPv6 支持压缩写法与方括号', () => {
    assert.strictEqual(isIPv6('::1'), true);
    assert.strictEqual(isIPv6('fe80::1'), true);
    assert.strictEqual(isIPv6('2001:db8::1'), true);
    assert.strictEqual(isIPv6('[2400:3200::1]'), true, '带方括号的地址应可识别');
    assert.strictEqual(isIPv6('192.168.1.1'), false);
    assert.strictEqual(isIPv6('fe80::1::2'), false, '出现两次 :: 应拒绝');
  });

  it('isIP 覆盖 IPv4 与 IPv6', () => {
    assert.strictEqual(isIP('8.8.8.8'), true);
    assert.strictEqual(isIP('::1'), true);
    assert.strictEqual(isIP('not-an-ip'), false);
  });

  it('ipv4ToInt 与边界值', () => {
    assert.strictEqual(ipv4ToInt('0.0.0.0'), 0);
    assert.strictEqual(ipv4ToInt('0.0.0.1'), 1);
    assert.strictEqual(ipv4ToInt('255.255.255.255'), 4294967295);
    assert.strictEqual(ipv4ToInt('192.168.1.1'), 3232235777);
    assert.strictEqual(ipv4ToInt('192.168.1'), null);
  });

  it('isInCidr4：/24 的边界命中与不命中', () => {
    assert.strictEqual(isInCidr4('192.168.1.255', '192.168.1.0/24'), true, '网段末地址应命中');
    assert.strictEqual(isInCidr4('192.168.1.0', '192.168.1.0/24'), true, '网段首地址应命中');
    assert.strictEqual(isInCidr4('192.168.2.1', '192.168.1.0/24'), false, '相邻网段不应命中');
  });

  it('isInCidr4：/0 命中一切、/32 精确匹配', () => {
    assert.strictEqual(isInCidr4('8.8.8.8', '0.0.0.0/0'), true);
    assert.strictEqual(isInCidr4('255.255.255.255', '0.0.0.0/0'), true);
    assert.strictEqual(isInCidr4('192.168.1.1', '192.168.1.1/32'), true);
    assert.strictEqual(isInCidr4('192.168.1.2', '192.168.1.1/32'), false);
  });

  it('isInCidr4：非法输入返回 false 而不抛错', () => {
    assert.strictEqual(isInCidr4('not-an-ip', '192.168.1.0/24'), false);
    assert.strictEqual(isInCidr4('1.2.3.4', '999.1.1.1/24'), false);
    assert.strictEqual(isInCidr4('1.2.3.4', '1.2.3.0/33'), false);
    assert.strictEqual(isInCidr4('1.2.3.4', 'garbage'), false);
  });

  it('classifyIP：IPv4 各地址性质', () => {
    assert.strictEqual(classifyIP('10.0.0.1').kind, 'private');
    assert.strictEqual(classifyIP('172.16.0.1').kind, 'private');
    assert.strictEqual(classifyIP('192.168.1.1').kind, 'private');
    assert.strictEqual(classifyIP('127.0.0.1').kind, 'loopback');
    assert.strictEqual(classifyIP('169.254.1.1').kind, 'linklocal');
    assert.strictEqual(classifyIP('100.64.0.1').kind, 'cgnat');
    assert.strictEqual(classifyIP('224.0.0.1').kind, 'multicast');
    assert.strictEqual(classifyIP('8.8.8.8').kind, 'public');
  });

  it('classifyIP：IPv6 各地址性质', () => {
    assert.strictEqual(classifyIP('::1').kind, 'loopback');
    assert.strictEqual(classifyIP('fe80::1').kind, 'linklocal');
    assert.strictEqual(classifyIP('fd00::1').kind, 'private', 'ULA 应视为私有');
    assert.strictEqual(classifyIP('2400:3200::1').kind, 'public');
  });

  it('classifyIP：非法输入返回 invalid 而不是抛错', () => {
    assert.strictEqual(classifyIP('hello world').kind, 'invalid');
    assert.strictEqual(classifyIP('').kind, 'invalid');
    assert.strictEqual(classifyIP(null).kind, 'invalid');
    assert.strictEqual(classifyIP('192.168.1.1').isPublic, false);
    assert.strictEqual(classifyIP('8.8.8.8').isPublic, true);
  });

  it('isPrivateIP：私有/环回/链路本地为真，公网为假', () => {
    assert.strictEqual(isPrivateIP('10.0.0.1'), true);
    assert.strictEqual(isPrivateIP('192.168.1.1'), true);
    assert.strictEqual(isPrivateIP('127.0.0.1'), true);
    assert.strictEqual(isPrivateIP('169.254.1.1'), true);
    assert.strictEqual(isPrivateIP('100.64.0.1'), true);
    assert.strictEqual(isPrivateIP('8.8.8.8'), false);
    assert.strictEqual(isPrivateIP('999.999.999.999'), false);
  });

  it('cidrOf：按前缀归拢网段', () => {
    assert.strictEqual(cidrOf('192.168.1.100', 24), '192.168.1.0/24');
    assert.strictEqual(cidrOf('192.168.1.100', 32), '192.168.1.100/32');
    assert.strictEqual(cidrOf('10.1.2.3', 8), '10.0.0.0/8');
    assert.strictEqual(cidrOf('172.16.5.9', 12), '172.16.0.0/12');
    assert.strictEqual(cidrOf('192.168.1.100', 0), '0.0.0.0/0');
  });

  it('cidrOf：非法 IP / 越界前缀返回 null', () => {
    assert.strictEqual(cidrOf('not-an-ip', 24), null);
    assert.strictEqual(cidrOf('192.168.1.1', 33), null);
    assert.strictEqual(cidrOf('192.168.1.1', -1), null);
    assert.strictEqual(cidrOf('192.168.1.1', 'x'), null);
  });

  it('parseTarget：URL 形式（协议 + 路径 + 查询串）', () => {
    const t = parseTarget('https://www.example.com/path?q=1');
    assert.strictEqual(t.protocol, 'https');
    assert.strictEqual(t.host, 'www.example.com');
    assert.strictEqual(t.port, null);
    assert.strictEqual(t.kind, 'hostname');
    assert.strictEqual(t.defaultPort, 443, 'https 默认 443');
  });

  it('parseTarget：host:port 形式', () => {
    const t = parseTarget('example.com:8080');
    assert.strictEqual(t.host, 'example.com');
    assert.strictEqual(t.port, 8080);
    assert.strictEqual(t.kind, 'hostname');
    assert.strictEqual(t.defaultPort, 8080);

    const t2 = parseTarget('www.baidu.com:443/x');
    assert.strictEqual(t2.host, 'www.baidu.com');
    assert.strictEqual(t2.port, 443);
  });

  it('parseTarget：纯 IPv4', () => {
    const t = parseTarget('192.168.1.1');
    assert.strictEqual(t.host, '192.168.1.1');
    assert.strictEqual(t.kind, 'ipv4');
    assert.strictEqual(t.port, null);
    assert.strictEqual(t.defaultPort, 80);
  });

  it('parseTarget：带方括号与端口的 IPv6', () => {
    const t = parseTarget('[2400:3200::1]:443');
    assert.strictEqual(t.host, '2400:3200::1');
    assert.strictEqual(t.port, 443);
    assert.strictEqual(t.kind, 'ipv6');
    assert.strictEqual(t.defaultPort, 443);

    const t2 = parseTarget('::1');
    assert.strictEqual(t2.host, '::1');
    assert.strictEqual(t2.port, null, '裸 IPv6 不应被误判出端口');
    assert.strictEqual(t2.kind, 'ipv6');
  });

  it('parseTarget：localhost 与带用户信息的 URL', () => {
    assert.strictEqual(parseTarget('localhost').kind, 'hostname');
    assert.strictEqual(parseTarget('localhost:3000').port, 3000);
    const t = parseTarget('http://user:pass@www.example.com/x');
    assert.strictEqual(t.host, 'www.example.com', '应剥离 user:pass@');
    assert.strictEqual(t.protocol, 'http');
    assert.strictEqual(t.defaultPort, 80);
  });

  it('parseTarget：非法输入抛错', () => {
    assert.throws(() => parseTarget(''), /目标不能为空/);
    assert.throws(() => parseTarget('http://'), /无法识别目标主机/);
    assert.throws(() => parseTarget('!!!bad!!!'), /无法识别的目标/);
    assert.throws(() => parseTarget('example.com:abc'), /无法识别的目标/);
    assert.throws(() => parseTarget('a'.repeat(256)), /过长/);
  });

  it('parseTarget：端口越界抛错', () => {
    assert.throws(() => parseTarget('example.com:70000'), /端口不合法/);
    assert.throws(() => parseTarget('example.com:0'), /端口不合法/);
  });
});

/* ================================================================== */
/* 2. parsers.parseTraceroute                                          */
/* ================================================================== */

describe('parsers.parseTraceroute：Windows 中文 tracert', () => {
  const result = parseTraceroute(TRACE_WIN_CN, { targetIP: '110.242.68.3', queries: 3, maxHops: 30 });

  it('跃点数量与 TTL 序列正确（头部/尾部噪声行被忽略）', () => {
    assert.strictEqual(result.hops.length, 5);
    assert.deepStrictEqual(result.hops.map((h) => h.ttl), [1, 2, 3, 4, 5]);
  });

  it('每跳 IP 解析正确', () => {
    assert.deepStrictEqual(result.hops.map((h) => h.ip), [
      '192.168.1.1',
      '100.64.0.1',
      null,
      '202.97.58.90',
      '110.242.68.3',
    ]);
  });

  it('"<1 毫秒" 视为 1ms，latency.avg 取三次探测均值', () => {
    assert.strictEqual(result.hops[0].latency.avg, 1);
    assert.strictEqual(result.hops[0].latency.min, 1);
    assert.strictEqual(result.hops[0].latency.max, 1);
    assert.strictEqual(result.hops[0].latency.responded, 3);
    assert.strictEqual(result.hops[1].latency.avg, 1.7, '(2+1+2)/3 = 1.67 → 1.7');
    assert.strictEqual(result.hops[3].latency.avg, 4.7, '(5+4+5)/3 = 4.67 → 4.7');
  });

  it('"* * * 请求超时。" 识别为超时跳（lossPct=100，avg=null）', () => {
    const hop = result.hops[2];
    assert.strictEqual(hop.isTimeout, true);
    assert.strictEqual(hop.ip, null);
    assert.strictEqual(hop.latency.avg, null);
    assert.strictEqual(hop.latency.min, null);
    assert.strictEqual(hop.latency.lossPct, 100);
    assert.strictEqual(hop.latency.attempts, 3);
  });

  it('"IP [ptr]" 形式可提取主机名', () => {
    assert.strictEqual(result.hops[3].hostname, '上海市 电信');
    assert.strictEqual(result.hops[0].hostname, null);
  });

  it('summary：hopCount / destinationIP / reachedTarget / 超时统计 / RTT 汇总', () => {
    assert.strictEqual(result.summary.hopCount, 5);
    assert.strictEqual(result.summary.respondedHops, 4);
    assert.strictEqual(result.summary.timeouts, 1);
    assert.strictEqual(result.summary.destinationIP, '110.242.68.3');
    assert.strictEqual(result.summary.reachedTarget, true);
    assert.strictEqual(result.summary.lastHopIP, '110.242.68.3');
    assert.strictEqual(result.summary.minRtt, 1);
    assert.strictEqual(result.summary.maxRtt, 7.7);
    assert.strictEqual(result.summary.avgRtt, 3.8);
    assert.strictEqual(result.summary.totalRtt, 8.7);
  });

  it('"跟踪完成。" 置 complete=true', () => {
    assert.strictEqual(result.complete, true);
  });
});

describe('parsers.parseTraceroute：Windows 英文 tracert', () => {
  const result = parseTraceroute(TRACE_WIN_EN, { targetIP: '142.250.72.196' });

  it('跃点数量、TTL 与 IP', () => {
    assert.strictEqual(result.hops.length, 4);
    assert.deepStrictEqual(result.hops.map((h) => h.ttl), [1, 2, 3, 4]);
    assert.deepStrictEqual(result.hops.map((h) => h.ip), ['192.168.1.1', null, '10.0.0.1', '142.250.72.196']);
  });

  it('"Request timed out." 识别为超时跳', () => {
    assert.strictEqual(result.hops[1].isTimeout, true);
    assert.strictEqual(result.hops[1].latency.lossPct, 100);
    assert.strictEqual(result.hops[1].latency.avg, null);
  });

  it('latency.avg 与 summary 汇总', () => {
    assert.strictEqual(result.hops[0].latency.avg, 1);
    assert.strictEqual(result.hops[2].latency.avg, 9.7);
    assert.strictEqual(result.hops[3].latency.avg, 11.7);
    assert.strictEqual(result.summary.hopCount, 4);
    assert.strictEqual(result.summary.destinationIP, '142.250.72.196');
    assert.strictEqual(result.summary.reachedTarget, true);
    assert.strictEqual(result.summary.timeouts, 1);
    assert.strictEqual(result.complete, true, '"Trace complete." 应置 complete');
  });
});

describe('parsers.parseTraceroute：Linux traceroute -n', () => {
  const result = parseTraceroute(TRACE_NIX, { targetIP: '8.8.8.8', queries: 3 });

  it('数字形式跃点与毫秒小数解析', () => {
    assert.strictEqual(result.hops.length, 5);
    assert.deepStrictEqual(result.hops.map((h) => h.ip), [
      '192.168.1.1',
      '10.0.0.1',
      null,
      '202.97.58.90',
      '8.8.8.8',
    ]);
    assert.strictEqual(result.hops[0].latency.avg, 1.4, '(1.234+1.5+1.6)/3 → 1.4');
    assert.strictEqual(result.hops[0].latency.min, 1.2);
    assert.strictEqual(result.hops[0].latency.max, 1.6);
    assert.strictEqual(result.hops[0].latency.jitter, 0.4);
  });

  it('" 5  * * *" 形式的超时跳', () => {
    const hop = result.hops[2];
    assert.strictEqual(hop.ttl, 3);
    assert.strictEqual(hop.isTimeout, true);
    assert.strictEqual(hop.latency.lossPct, 100);
  });

  it('无 "Trace complete" 时 complete=false，但命中 targetIP 仍视为到达', () => {
    assert.strictEqual(result.complete, false);
    assert.strictEqual(result.summary.destinationIP, '8.8.8.8');
    assert.strictEqual(result.summary.reachedTarget, true);
    assert.strictEqual(result.summary.lastHopIP, '8.8.8.8');
    assert.strictEqual(result.summary.avgRtt, 14.3);
  });

  it('单跳部分丢包：2/3 响应 → lossPct=33.3', () => {
    const partial = parseTraceroute(TRACE_PARTIAL_LOSS, { targetIP: '1.1.1.1' });
    const hop = partial.hops[1];
    assert.strictEqual(hop.ip, '10.0.0.1');
    assert.strictEqual(hop.latency.attempts, 3);
    assert.strictEqual(hop.latency.responded, 2);
    assert.strictEqual(hop.latency.lossPct, 33.3);
    assert.strictEqual(hop.latency.avg, 4.6);
  });
});

describe('parsers.parseTraceroute：混合域名 / PTR 形式', () => {
  it('"host (IP)" 形式提取主机名', () => {
    const r = parseTraceroute(TRACE_MIXED, { targetIP: '198.51.100.7' });
    assert.strictEqual(r.hops[0].ip, '192.168.1.1');
    assert.strictEqual(r.hops[0].hostname, 'router.local');
    assert.strictEqual(r.hops[1].ip, '10.0.0.1');
    assert.strictEqual(r.hops[1].hostname, 'gateway.local');
    assert.strictEqual(r.hops[1].latency.avg, 2.4);
  });

  it('"IP [ptr]" 形式提取主机名', () => {
    const r = parseTraceroute(TRACE_MIXED, { targetIP: '198.51.100.7' });
    assert.strictEqual(r.hops[2].ip, '203.0.113.5');
    assert.strictEqual(r.hops[2].hostname, 'ptr.example.net');
    assert.strictEqual(r.hops[4].hostname, 'edge.example.org');
  });

  it('未传 targetIP 时 destinationIP 回退为最后一个响应跳，reachedTarget=false', () => {
    const r = parseTraceroute(TRACE_MIXED, {});
    assert.strictEqual(r.hops.length, 5);
    assert.strictEqual(r.summary.destinationIP, '198.51.100.7');
    assert.strictEqual(r.summary.lastHopIP, '198.51.100.7');
    assert.strictEqual(r.summary.reachedTarget, false);
    assert.strictEqual(r.summary.hopCount, 5);
    assert.strictEqual(r.summary.timeouts, 1);
  });

  it('空输入与纯噪声输入返回空结构而不抛错', () => {
    for (const input of ['', '   \n\n', 'Tracing route to nowhere\n\nTrace complete.']) {
      const r = parseTraceroute(input, {});
      assert.strictEqual(Array.isArray(r.hops), true);
      assert.strictEqual(r.summary.hopCount, r.hops.length);
    }
    const noise = parseTraceroute('Tracing route to nowhere\n\nTrace complete.', {});
    assert.strictEqual(noise.hops.length, 0);
    assert.strictEqual(noise.summary.destinationIP, null);
    assert.strictEqual(noise.summary.reachedTarget, true, '显式 complete 视为到达');
  });
});

/* ================================================================== */
/* 3. parsers.parsePing                                                */
/* ================================================================== */

describe('parsers.parsePing：Windows 中文', () => {
  it('全部响应的统计：sent/received/lossPct/min/max/avg/alive', () => {
    const r = parsePing(PING_WIN_CN);
    assert.strictEqual(r.resolvedIP, '110.242.68.3');
    assert.strictEqual(r.sent, 4);
    assert.strictEqual(r.received, 4);
    assert.strictEqual(r.lost, 0);
    assert.strictEqual(r.lossPct, 0);
    assert.strictEqual(r.min, 9);
    assert.strictEqual(r.max, 11);
    assert.strictEqual(r.avg, 10);
    assert.strictEqual(r.jitter, 2);
    assert.strictEqual(r.alive, true);
    assert.deepStrictEqual(r.samples, [10, 11, 9, 10]);
  });

  it('部分丢包（已发送=4，已接收=2，50% 丢失）', () => {
    const r = parsePing(PING_WIN_CN_LOSS);
    assert.strictEqual(r.sent, 4);
    assert.strictEqual(r.received, 2);
    assert.strictEqual(r.lost, 2);
    assert.strictEqual(r.lossPct, 50);
    assert.strictEqual(r.min, 10);
    assert.strictEqual(r.max, 12);
    assert.strictEqual(r.avg, 11);
    assert.strictEqual(r.alive, true);
    assert.deepStrictEqual(r.samples, [10, 12], '超时行不计入 samples');
  });
});

describe('parsers.parsePing：Windows 英文', () => {
  it('含 time<1ms 的样本：sent/received/lossPct/min/max/avg/alive', () => {
    const r = parsePing(PING_WIN_EN);
    assert.strictEqual(r.resolvedIP, '93.184.216.34');
    assert.strictEqual(r.sent, 4);
    assert.strictEqual(r.received, 4);
    assert.strictEqual(r.lossPct, 0);
    assert.strictEqual(r.min, 1);
    assert.strictEqual(r.max, 15);
    assert.strictEqual(r.avg, 10);
    assert.strictEqual(r.alive, true);
    assert.deepStrictEqual(r.samples, [14, 15, 13, 1], 'time<1ms 记作 1ms');
  });
});

describe('parsers.parsePing：Linux', () => {
  it('4 packets transmitted, 3 received, 25% packet loss + rtt min/avg/max/mdev', () => {
    const r = parsePing(PING_NIX);
    assert.strictEqual(r.resolvedIP, '8.8.8.8');
    assert.strictEqual(r.sent, 4);
    assert.strictEqual(r.received, 3);
    assert.strictEqual(r.lost, 1);
    assert.strictEqual(r.lossPct, 25);
    assert.strictEqual(r.min, 29.8);
    assert.strictEqual(r.max, 30.4);
    assert.strictEqual(r.avg, 30.1);
    assert.strictEqual(r.alive, true);
    assert.deepStrictEqual(r.samples, [30.1, 30.4, 29.8]);
  });
});

describe('parsers.parsePing：全部超时', () => {
  it('alive=false，samples 为空，min/max/avg 为 null', () => {
    const r = parsePing(PING_DEAD);
    assert.strictEqual(r.sent, 4);
    assert.strictEqual(r.received, 0);
    assert.strictEqual(r.lost, 4);
    assert.strictEqual(r.lossPct, 100);
    assert.strictEqual(r.min, null);
    assert.strictEqual(r.max, null);
    assert.strictEqual(r.avg, null);
    assert.deepStrictEqual(r.samples, []);
    assert.strictEqual(r.alive, false);
  });

  it('空输入返回全空结构且 alive=false', () => {
    const r = parsePing('');
    assert.strictEqual(r.alive, false);
    assert.strictEqual(r.samples.length, 0);
    assert.strictEqual(r.lossPct, null);
  });
});

/* ================================================================== */
/* 4. exec：编码识别                                                   */
/* ================================================================== */

describe('exec.decodeBest：多编码自动识别', () => {
  it('纯 ASCII 原样返回', () => {
    assert.strictEqual(decodeBest(Buffer.from('Trace complete.\n', 'utf8')), 'Trace complete.\n');
  });

  it('UTF-8 BOM：剥离 BOM 后按 UTF-8 解码中文', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文 BOM 测试', 'utf8')]);
    assert.strictEqual(decodeBest(buf), '中文 BOM 测试');
  });

  it('UTF-16LE BOM：按 UTF-16LE 解码', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文 UTF-16LE', 'utf16le')]);
    assert.strictEqual(decodeBest(buf), '中文 UTF-16LE');
  });

  it('UTF-16BE BOM：交换字节后解码', () => {
    const body = Buffer.from('中文 UTF-16BE', 'utf16le');
    body.swap16();
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    assert.strictEqual(decodeBest(buf), '中文 UTF-16BE');
  });

  it('GBK：中文 Windows 命令输出的典型字节序列', () => {
    const gbk = Buffer.from([
      0xcd, 0xa8, 0xb9, 0xfd, 0xd7, 0xee, 0xb6, 0xe0, 0x20, 0x33, 0x20, 0xb8, 0xf6, 0xd4, 0xbe, 0xb5, 0xe3,
    ]);
    assert.strictEqual(decodeBest(gbk), '通过最多 3 个跃点');
  });

  it('空 Buffer 返回空串', () => {
    assert.strictEqual(decodeBest(Buffer.alloc(0)), '');
    assert.strictEqual(decodeBest(null), '');
  });
});

describe('exec.scoreText：文本质量评分', () => {
  it('常用汉字/ASCII 记正分，空串记 0', () => {
    assert.strictEqual(scoreText(''), 0);
    assert.strictEqual(scoreText('abc'), 3);
    assert.strictEqual(scoreText('中文'), 6, '汉字记 +3：中文正常文本应显著优于 latin1 乱码');
    assert.strictEqual(scoreText('通过最多 3 个跃点'), 24, '8 个汉字×3 + 数字 1 = 24，空格不计分');
    assert.strictEqual(scoreText('a\n'), 2);
  });

  it('Latin-1 / 扩展区字符（乱码高发区）记轻微负分', () => {
    assert.ok(scoreText('è·Ÿè¸ªå®Œæˆ') < scoreText('跟踪完成'), 'latin1 乱码得分必须低于正确的中文');
  });

  it('非法代理区与控制字符记负分（误解码的强信号）', () => {
    assert.strictEqual(scoreText('\ud800'), -8);
    assert.strictEqual(scoreText('\ufffd'), -8);
    assert.strictEqual(scoreText('a\u0001b'), 0);
    assert.ok(scoreText('\ud800\ud800') < 0);
  });
});

describe('exec.supportsEncoding：解码能力探测', () => {
  it('内置编码可用，未知编码返回 false', () => {
    assert.strictEqual(supportsEncoding('utf-8'), true);
    assert.strictEqual(supportsEncoding('utf-16le'), true);
    assert.strictEqual(supportsEncoding('no-such-encoding'), false);
  });

  it('gbk / big5 是否可用（可用则 GBK 样本必须正确解码）', { skip: supportsEncoding('gbk') && supportsEncoding('big5') ? false : '当前 Node 缺少 gbk/big5 解码能力（小 ICU 构建）' }, () => {
    assert.strictEqual(supportsEncoding('gbk'), true);
    assert.strictEqual(supportsEncoding('big5'), true);
    const gbk = Buffer.from([0xcd, 0xa8, 0xb9, 0xfd]);
    assert.strictEqual(decodeBest(gbk), '通过');
  });
});

/* ================================================================== */
/* 5. sysinfo                                                          */
/* ================================================================== */

describe('sysinfo.maskToBits', () => {
  it('常见掩码换算为前缀位数', () => {
    assert.strictEqual(sysinfo.maskToBits('255.255.255.0'), 24);
    assert.strictEqual(sysinfo.maskToBits('255.255.0.0'), 16);
    assert.strictEqual(sysinfo.maskToBits('255.0.0.0'), 8);
    assert.strictEqual(sysinfo.maskToBits('255.255.255.255'), 32);
    assert.strictEqual(sysinfo.maskToBits('0.0.0.0'), 0);
  });

  it('非法掩码回退为 24', () => {
    assert.strictEqual(sysinfo.maskToBits('bogus'), 24);
    assert.strictEqual(sysinfo.maskToBits(''), 24);
    assert.strictEqual(sysinfo.maskToBits(undefined), 24);
  });
});

describe('sysinfo.parseIpconfig：Windows 英文 ipconfig /all', () => {
  const adapters = sysinfo.parseIpconfig(IPCONFIG_EN);

  it('识别真实网卡，丢弃无地址的隧道 / 无线虚拟段落', () => {
    assert.strictEqual(adapters.length, 1, '只应保留有 IPv4 或网关的段落');
    assert.strictEqual(adapters[0].name, 'Ethernet adapter Ethernet');
    assert.strictEqual(adapters.some((a) => /Teredo/i.test(a.name)), false);
    assert.strictEqual(adapters.some((a) => /WLAN/.test(a.name)), false);
  });

  it('网关与 DNS（含 ". . . ." 填充与 DNS 续行）解析正确', () => {
    assert.deepStrictEqual(adapters[0].gateways, ['192.168.1.1']);
    assert.deepStrictEqual(adapters[0].dns, ['192.168.1.1', '8.8.8.8'], '第二个 DNS 位于续行');
  });

  it('IPv4 地址 / 描述 / MAC 解析正确', () => {
    assert.deepStrictEqual(adapters[0].ipv4, ['192.168.1.100']);
    assert.strictEqual(adapters[0].description, 'Realtek PCIe GbE Family Controller');
    assert.strictEqual(adapters[0].mac, '00-1A-2B-3C-4D-5E');
  });

  it('空输入 / 噪声输入返回空数组且不抛错', () => {
    assert.deepStrictEqual(sysinfo.parseIpconfig(''), []);
    assert.deepStrictEqual(sysinfo.parseIpconfig('随便一行文本\n\n另一行'), []);
    assert.deepStrictEqual(sysinfo.parseIpconfig(null), []);
  });
});

describe('sysinfo.parseIpconfig：Windows 中文 ipconfig /all', () => {
  it('返回结构始终合法（数组 + 字段类型）', () => {
    const adapters = sysinfo.parseIpconfig(IPCONFIG_CN);
    assert.ok(Array.isArray(adapters));
    for (const a of adapters) {
      assert.strictEqual(typeof a.name, 'string');
      assert.ok(Array.isArray(a.gateways));
      assert.ok(Array.isArray(a.dns));
      assert.ok(Array.isArray(a.ipv4));
    }
  });

  it('中文 ipconfig /all：应解析出网卡段落、网关与 DNS（BUG-2 回归）', () => {
    const adapters = sysinfo.parseIpconfig(IPCONFIG_CN);
    assert.strictEqual(adapters.length, 1, '中文段落标题必须能被识别');
    assert.deepStrictEqual(adapters[0].gateways, ['192.168.1.1']);
    assert.deepStrictEqual(adapters[0].dns, ['192.168.1.1', '8.8.8.8']);
    assert.deepStrictEqual(adapters[0].ipv4, ['192.168.1.100']);
    assert.strictEqual(adapters[0].mac, '00-1A-2B-3C-4D-5E');
  });
});

describe('sysinfo.parseArp', () => {
  it('英文 arp -a：过滤 .255 / 255.255.255.255 / 0.0.0.0，MAC 归一化', () => {
    const rows = sysinfo.parseArp(ARP_EN);
    assert.deepStrictEqual(rows.map((r) => r.ip), ['192.168.1.1', '192.168.1.50', '224.0.0.22']);
    assert.strictEqual(rows.some((r) => r.ip.endsWith('.255')), false);
    assert.strictEqual(rows.some((r) => r.ip === '255.255.255.255'), false);
    assert.strictEqual(rows.some((r) => r.ip === '0.0.0.0'), false);
    assert.strictEqual(rows[0].mac, 'AA:BB:CC:DD:EE:FF', '短横线 MAC 转为大写冒号形式');
    assert.strictEqual(rows[0].type, 'dynamic');
    assert.strictEqual(rows[2].type, 'static');
  });

  it('中文 arp -a：过滤规则与 MAC 归一化一致', () => {
    const rows = sysinfo.parseArp(ARP_CN);
    assert.deepStrictEqual(rows.map((r) => r.ip), ['192.168.1.1', '192.168.1.50', '239.255.255.250']);
    assert.strictEqual(rows[0].mac, 'AA:BB:CC:DD:EE:FF');
  });

  it('空输入与 Linux 风格 arp 输出不会误解析', () => {
    assert.deepStrictEqual(sysinfo.parseArp(''), []);
    assert.deepStrictEqual(sysinfo.parseArp('? (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0'), []);
  });
});

describe('sysinfo.parseNetstat', () => {
  const listeners = sysinfo.parseNetstat(NETSTAT);

  it('丢弃 ESTABLISHED / TIME_WAIT 等非监听 TCP 行', () => {
    assert.ok(listeners.length > 0);
    assert.strictEqual(listeners.some((l) => l.state === 'ESTABLISHED'), false);
    assert.strictEqual(listeners.some((l) => l.state === 'TIME_WAIT'), false);
  });

  it('保留 UDP 行并解析本地地址与端口', () => {
    const udp = listeners.filter((l) => l.proto === 'UDP');
    assert.deepStrictEqual(udp.map((l) => `${l.address}:${l.port}`), ['0.0.0.0:500', '127.0.0.1:1900', '[::]:3702']);
    assert.strictEqual(udp.every((l) => l.state === 'LISTEN'), true);
  });

  it('按端口升序返回且去重', () => {
    const ports = listeners.map((l) => l.port);
    assert.deepStrictEqual(ports, [...ports].sort((a, b) => a - b));
    const keys = listeners.map((l) => `${l.proto}:${l.address}:${l.port}`);
    assert.strictEqual(new Set(keys).size, keys.length, '重复行应被去重');
  });
});

describe('sysinfo.parseIpRoute：Windows route print -4', () => {
  it('解析带完整四元组的行，跳过 "在链路上" 行', () => {
    const routes = sysinfo.parseIpRoute(ROUTE_WIN);
    assert.strictEqual(routes.length, 2);
    const def = routes.find((r) => r.destination === '0.0.0.0');
    assert.ok(def, '应能解析出默认路由');
    assert.strictEqual(def.netmask, '0.0.0.0');
    assert.strictEqual(def.gateway, '192.168.1.1');
    assert.strictEqual(def.interface, '192.168.1.100');
    assert.strictEqual(def.metric, 25);
    assert.strictEqual(routes[1].destination, '192.168.1.0');
    assert.strictEqual(routes[1].metric, 26);
    assert.strictEqual(routes.some((r) => r.destination === '127.0.0.0'), false, '"在链路上" 行不应被解析');
  });

  it('空输入返回空数组', () => {
    assert.deepStrictEqual(sysinfo.parseIpRoute(''), []);
  });
});

describe('sysinfo.parseIfaceRoute：Linux ip route', () => {
  it('解析默认路由的网关 / 网卡 / metric', () => {
    const routes = sysinfo.parseIfaceRoute(ROUTE_LINUX);
    assert.strictEqual(routes.length, 2);
    assert.deepStrictEqual(routes[0], { destination: '0.0.0.0', gateway: '192.168.1.1', interface: 'eth0', metric: 100 });
    assert.deepStrictEqual(routes[1], { destination: '0.0.0.0', gateway: '10.0.0.1', interface: 'wlan0', metric: 600 });
  });

  it('无 metric 时回退为 0', () => {
    const routes = sysinfo.parseIfaceRoute('default via 172.16.0.1 dev enp0s3\n');
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].metric, 0);
    assert.strictEqual(routes[0].interface, 'enp0s3');
  });

  it('空输入返回空数组', () => {
    assert.deepStrictEqual(sysinfo.parseIfaceRoute(''), []);
  });
});

describe('sysinfo.listInterfaces', () => {
  const ifaces = sysinfo.listInterfaces();

  it('返回数组且每条记录字段完整', () => {
    assert.ok(Array.isArray(ifaces));
    for (const item of ifaces) {
      assert.strictEqual(typeof item.name, 'string');
      assert.strictEqual(isIP(item.address), true, `地址应合法：${item.address}`);
      assert.ok(item.family === 'IPv4' || item.family === 'IPv6', `family 应为 IPv4/IPv6：${item.family}`);
      assert.strictEqual(typeof item.isPrivate, 'boolean');
      assert.ok(item.cidr === null || /\//.test(String(item.cidr)), 'cidr 应形如 x.x.x.x/nn');
    }
  });

  it('不包含环回等 internal 地址', () => {
    assert.strictEqual(ifaces.some((i) => i.address === '127.0.0.1'), false);
    assert.strictEqual(ifaces.some((i) => i.address === '::1'), false);
  });
});

/* ================================================================== */
/* 6. offline-geo / geo.lookupOffline                                  */
/* ================================================================== */

describe('geo.lookupOffline：内置离线地理库（纯本地，不发网络请求）', () => {
  const cases = [
    ['8.8.8.8', 'US'],
    ['1.1.1.1', 'AU'],
    ['223.5.5.5', 'CN'],
    ['202.97.58.90', 'CN'],
  ];

  for (const [ip, countryCode] of cases) {
    it(`${ip} 命中离线库并返回带经纬度的对象`, () => {
      const info = geo.lookupOffline(ip);
      assert.ok(info, `${ip} 应命中内置离线库`);
      assert.strictEqual(info.ip, ip);
      assert.strictEqual(Number.isFinite(info.lat), true, 'lat 必须是有限数字');
      assert.strictEqual(Number.isFinite(info.lon), true, 'lon 必须是有限数字');
      assert.ok(info.lon >= -180 && info.lon <= 180, `lon 越界：${info.lon}`);
      assert.ok(info.lat >= -90 && info.lat <= 90, `lat 越界：${info.lat}`);
      assert.strictEqual(typeof info.city, 'string');
      assert.strictEqual(info.countryCode, countryCode);
      assert.strictEqual(typeof info.matchedPrefix, 'string');
    });
  }

  it('明显不在表内的公网地址返回 null', () => {
    assert.strictEqual(geo.lookupOffline('4.4.4.4'), null);
    assert.strictEqual(geo.lookupOffline('198.51.100.7'), null);
  });

  it('非 IP 输入返回 null', () => {
    assert.strictEqual(geo.lookupOffline('not-an-ip'), null);
    assert.strictEqual(geo.lookupOffline('fe80::1'), null, '离线库只覆盖 IPv4');
    assert.strictEqual(geo.lookupOffline(''), null);
  });

  it('最长前缀优先：202.97.58.90 命中 /16 骨干段', () => {
    const info = geo.lookupOffline('202.97.58.90');
    assert.strictEqual(info.matchedPrefix, '202.97.0.0/16');
    assert.strictEqual(info.lat, 31.22);
    assert.strictEqual(info.lon, 121.46);
  });

  it('内置表结构合法：经纬度均为有限数字且在有效范围内', () => {
    const table = require('../src/data/offline-geo');
    assert.ok(Array.isArray(table.ranges) && table.ranges.length > 0);
    for (const row of table.ranges) {
      assert.strictEqual(isIPv4(row.start), true, `start 非法：${row.start}`);
      assert.strictEqual(isIPv4(row.end), true, `end 非法：${row.end}`);
      assert.ok(ipv4ToInt(row.start) <= ipv4ToInt(row.end), `区间倒置：${row.prefix}`);
      assert.strictEqual(Number.isFinite(row.lat), true, `lat 非法：${row.prefix}`);
      assert.strictEqual(Number.isFinite(row.lon), true, `lon 非法：${row.prefix}`);
      assert.ok(row.lat >= -90 && row.lat <= 90 && row.lon >= -180 && row.lon <= 180, `坐标越界：${row.prefix}`);
    }
  });
});

/* ================================================================== */
/* 7. reachability                                                     */
/* ================================================================== */

describe('reachability.serviceOf / TOP_PORTS', () => {
  it('常见端口映射到服务名', () => {
    assert.strictEqual(reachability.serviceOf(20), 'FTP-Data');
    assert.strictEqual(reachability.serviceOf(22), 'SSH');
    assert.strictEqual(reachability.serviceOf(53), 'DNS');
    assert.strictEqual(reachability.serviceOf(80), 'HTTP');
    assert.strictEqual(reachability.serviceOf(443), 'HTTPS');
    assert.strictEqual(reachability.serviceOf(3306), 'MySQL');
    assert.strictEqual(reachability.serviceOf(3389), 'RDP');
    assert.strictEqual(reachability.serviceOf(27017), 'MongoDB');
  });

  it('未登记端口与非法入参返回 null', () => {
    assert.strictEqual(reachability.serviceOf(9999), null);
    assert.strictEqual(reachability.serviceOf(0), null);
    assert.strictEqual(reachability.serviceOf(undefined), null);
    assert.strictEqual(reachability.serviceOf(null), null);
  });

  it('TOP_PORTS 结构合法：端口唯一、升序、服务名非空', () => {
    const list = reachability.TOP_PORTS;
    assert.ok(Array.isArray(list) && list.length > 0);
    const ports = list.map((p) => p.port);
    assert.strictEqual(new Set(ports).size, ports.length, '端口不应重复');
    assert.deepStrictEqual(ports, [...ports].sort((a, b) => a - b), '应按端口升序');
    for (const item of list) {
      assert.strictEqual(Number.isInteger(item.port), true);
      assert.ok(item.port >= 1 && item.port <= 65535);
      assert.strictEqual(typeof item.service, 'string');
      assert.ok(item.service.length > 0);
    }
    for (const must of [22, 80, 443, 3389]) {
      assert.ok(ports.includes(must), `常用端口表应包含 ${must}`);
    }
  });
});

/* ================================================================== */
/* 8. api.health（不调用 selfTest：它会真实访问网络且耗时）              */
/* ================================================================== */

describe('api.health', () => {
  it('返回 ok=true / name=NetScope，并包含 capabilities 与 geo 字段', async () => {
    const h = await routes.health();
    assert.strictEqual(h.ok, true);
    assert.strictEqual(h.name, 'NetScope');
    assert.strictEqual(typeof h.version, 'string');
    assert.strictEqual(typeof h.platform, 'string');
    assert.strictEqual(typeof h.node, 'string');
    assert.strictEqual(typeof h.uptimeSec, 'number');
    assert.strictEqual(Number.isNaN(Date.parse(h.startedAt)), false, 'startedAt 应为可解析时间');
  });

  it('capabilities 为运行期能力探测结果', async () => {
    const { capabilities } = await routes.health();
    assert.strictEqual(typeof capabilities, 'object');
    assert.strictEqual(typeof capabilities.pipeBlocked, 'boolean');
    assert.ok('shellFileWorks' in capabilities);
    assert.ok('probed' in capabilities);
  });

  it('geo 为地理缓存统计信息', async () => {
    const { geo: geoStats } = await routes.health();
    assert.strictEqual(typeof geoStats, 'object');
    assert.strictEqual(typeof geoStats.memoryEntries, 'number');
    assert.strictEqual(typeof geoStats.diskEntries, 'number');
    assert.strictEqual(typeof geoStats.cacheFile, 'string');
    assert.strictEqual(typeof geoStats.onlineEnabled, 'boolean');
    assert.ok(Array.isArray(geoStats.providers));
  });

  it('running 字段给出在跑任务数', async () => {
    const { running } = await routes.health();
    assert.strictEqual(typeof running.traces, 'number');
    assert.strictEqual(typeof running.scans, 'number');
  });

  it('health 是异步接口（返回 Promise）', () => {
    const p = routes.health();
    assert.strictEqual(typeof p.then, 'function');
    return p;
  });
});

/* ================================================================== */
/* 9. 缺陷修复回归（曾经的真实缺陷，现已修复并固化为回归用例）             */
/* ================================================================== */

describe('缺陷修复回归', () => {
  it('decodeBest 应正确解码无 BOM 的 UTF-8 中文（BUG-1 回归）', () => {
    const original = '跟踪完成：中文测试';
    assert.strictEqual(decodeBest(Buffer.from(original, 'utf8')), original);
  });

  it('parseIpconfig 应解析中文 ipconfig /all 的网关与 DNS（BUG-2 回归）', () => {
    const adapters = sysinfo.parseIpconfig(IPCONFIG_CN);
    assert.strictEqual(adapters.length, 1);
    assert.deepStrictEqual(adapters[0].gateways, ['192.168.1.1']);
    assert.deepStrictEqual(adapters[0].dns, ['192.168.1.1', '8.8.8.8']);
    assert.deepStrictEqual(adapters[0].ipv4, ['192.168.1.100']);
  });

  it('parseNetstat 应保留 TCP LISTENING 行并带上 PID（BUG-3 回归）', () => {
    const listeners = sysinfo.parseNetstat(NETSTAT);
    const tcp = listeners.filter((l) => l.proto === 'TCP');
    assert.deepStrictEqual(tcp.map((l) => l.port), [135, 445, 5354]);
    assert.strictEqual(tcp.every((l) => l.state === 'LISTENING'), true);
    assert.deepStrictEqual(tcp.map((l) => l.pid), [1120, 4, 3216]);
  });

  it('parsePing 应解析 Windows 英文统计行（Sent / Received / Lost / N% loss）（BUG-4 回归）', () => {
    const lossy = parsePing(lines(
      'Pinging www.example.com [93.184.216.34] with 32 bytes of data:',
      'Reply from 93.184.216.34: bytes=32 time=14ms TTL=56',
      'Request timed out.',
      'Reply from 93.184.216.34: bytes=32 time=13ms TTL=56',
      'Request timed out.',
      '',
      'Ping statistics for 93.184.216.34:',
      '    Packets: Sent = 4, Received = 2, Lost = 2 (50% loss),',
      'Approximate round trip times in milli-seconds:',
      '    Minimum = 13ms, Maximum = 14ms, Average = 13ms',
      '',
    ));
    assert.strictEqual(lossy.sent, 4);
    assert.strictEqual(lossy.received, 2);
    assert.strictEqual(lossy.lost, 2);
    assert.strictEqual(lossy.lossPct, 50);
    assert.strictEqual(lossy.alive, true);
  });

  it('parseArp 应把中文 “动态” 识别为 dynamic（BUG-7 回归）', () => {
    const rows = sysinfo.parseArp(ARP_CN);
    assert.strictEqual(rows[0].type, 'dynamic');
    assert.strictEqual(rows[1].type, 'dynamic');
    assert.strictEqual(rows[2].type, 'static');
  });
});

/* ================================================================== */
/* 10. 附加回归位（低优先级边界，锁定当前行为）                          */
/* ================================================================== */

describe('边界回归位', () => {
  it('parsePing：英文 "time=<1ms" 的回复应被解析为 1ms（BUG-5 回归）', () => {
    const r = parsePing(lines(
      'Pinging 192.168.1.1 with 32 bytes of data:',
      'Reply from 192.168.1.1: bytes=32 time=<1ms TTL=128',
      'Reply from 192.168.1.1: bytes=32 time=2ms TTL=128',
      '',
    ));
    assert.deepStrictEqual(r.samples, [1, 2]);
  });

  it('parsePing：ping 裸 IP 且回复带冒号时应解析出 resolvedIP（BUG-6 回归）', () => {
    const r = parsePing(lines(
      'Pinging 8.8.8.8 with 32 bytes of data:',
      'Reply from 8.8.8.8: bytes=32 time=10ms TTL=115',
      '',
    ));
    assert.strictEqual(r.resolvedIP, '8.8.8.8');
    assert.strictEqual(r.avg, 10, '时延本身仍可正常解析');
  });
});
