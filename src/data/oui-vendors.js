'use strict';

/**
 * MAC 地址厂商前缀表（IEEE OUI 节选）
 *
 * 用途：网络扫描时把 MAC 前缀映射为设备厂商，帮助判断"这台设备是谁"，
 *      界面据此推断设备类型（路由器 / 手机 / 电脑 / 打印机 / NAS / 摄像头 / IoT）。
 *
 * 约定：
 *   - 键为 6 位大写十六进制（例如 "0017F2"），即 MAC 的前 3 字节（OUI）；
 *   - 值优先体现厂商，若该前缀在本场景下几乎总是指向某类设备，则附加中文提示；
 *   - 未命中返回 null，界面显示"未知厂商"，不编造数据；
 *   - 若 MAC 的第二位最低有效位为 1（本地管理地址，常见于虚拟机、
 *     随机化 MAC、Mesh 节点），它不会出现在 IEEE 分配表中，
 *     查询函数会返回 local=true，界面据此说明"本地管理地址"而不是"未知厂商"；
 *   - 完整 IEEE 库有 3 万余条，这里只收录家用/办公最常见的部分以控制体积，
 *     可按同样格式自行追加。
 *
 * 生成时间：2026-09-17T13:54:56.571Z（共 919 条）
 */
module.exports = {

  // ---- Apple ----
  '103025': 'Apple',

  // ---- Huawei ----
  '104780': 'Huawei',
  '143004': 'Huawei',

  // ---- OPPO ----
  '181212': 'OPPO',

  // ---- Apple ----
  '182032': 'Apple',
  '183451': 'Apple',

  // ---- vivo ----
  '185933': 'vivo',

  // ---- Xiaomi ----
  '185936': 'Xiaomi',

  // ---- Apple ----
  '186590': 'Apple',

  // ---- Samsung ----
  '206476': 'Samsung',

  // ---- Huawei ----
  '240995': 'Huawei',

  // ---- Microsoft ----
  '281878': 'Microsoft',

  // ---- Huawei ----
  '283152': 'Huawei',
  '308730': 'Huawei',

  // ---- OPPO ----
  '341298': 'OPPO',

  // ---- Apple ----
  '440010': 'Apple',

  // ---- Samsung ----
  '445943': 'Samsung',

  // ---- Intel ----
  '448500': 'Intel',

  // ---- Huawei ----
  '480031': 'Huawei',

  // ---- Microsoft ----
  '485073': 'Microsoft',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  '500291': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Apple ----
  '503237': 'Apple',

  // ---- QEMU/KVM（虚拟网卡） ----
  '525400': 'QEMU/KVM（虚拟网卡）',

  // ---- Apple ----
  '542696': 'Apple',

  // ---- Sony ----
  '544249': 'Sony',

  // ---- Google（Chromecast） ----
  '546009': 'Google（Chromecast）',

  // ---- Xiaomi ----
  '584498': 'Xiaomi',

  // ---- Microsoft ----
  '588238': 'Microsoft',

  // ---- Apple ----
  '600308': 'Apple',

  // ---- Intel ----
  '606720': 'Intel',

  // ---- Apple ----
  '606944': 'Apple',
  '609217': 'Apple',

  // ---- Xiaomi ----
  '742344': 'Xiaomi',

  // ---- Netgear ----
  '744401': 'Netgear',

  // ---- Apple ----
  '748114': 'Apple',

  // ---- Huawei ----
  '788102': 'Huawei',

  // ---- Netgear ----
  '803773': 'Netgear',

  // ---- Apple ----
  '842999': 'Apple',
  '843835': 'Apple',

  // ---- Huawei ----
  '844765': 'Huawei',

  // ---- Apple ----
  '885395': 'Apple',

  // ---- Netgear ----
  '941865': 'Netgear',

  // ---- Seiko Epson（打印机） ----
  '000048': 'Seiko Epson（打印机）',

  // ---- Canon（打印机） ----
  '000085': 'Canon（打印机）',

  // ---- Cisco ----
  '000142': 'Cisco',

  // ---- Intel ----
  '0002B3': 'Intel',

  // ---- Apple ----
  '000393': 'Apple',

  // ---- VMware（虚拟网卡） ----
  '000569': 'VMware（虚拟网卡）',

  // ---- QNAP（NAS） ----
  '00089F': 'QNAP（NAS）',

  // ---- Netgear ----
  '00095B': 'Netgear',

  // ---- Apple ----
  '000A27': 'Apple',
  '000A95': 'Apple',

  // ---- TP-Link ----
  '000AEB': 'TP-Link',

  // ---- Western Digital（NAS） ----
  '000C0D': 'Western Digital（NAS）',

  // ---- VMware（虚拟网卡） ----
  '000C29': 'VMware（虚拟网卡）',

  // ---- Routerboard (MikroTik) ----
  '000C42': 'Routerboard (MikroTik)',

  // ---- MediaTek ----
  '000C43': 'MediaTek',

  // ---- Microsoft ----
  '000D3A': 'Microsoft',

  // ---- Apple ----
  '000D93': 'Apple',

  // ---- Samsung（电视） ----
  '000DAE': 'Samsung（电视）',

  // ---- Apple ----
  '0010FA': 'Apple',

  // ---- Intel ----
  '001111': 'Intel',

  // ---- Apple ----
  '001124': 'Apple',

  // ---- Synology（NAS） ----
  '001132': 'Synology（NAS）',

  // ---- Cisco ----
  '0012DA': 'Cisco',

  // ---- Intel ----
  '0012F0': 'Intel',
  '001302': 'Intel',

  // ---- Zyxel ----
  '001349': 'Zyxel',

  // ---- Netgear ----
  '00146C': 'Netgear',

  // ---- Western Digital（NAS） ----
  '0014EE': 'Western Digital（NAS）',

  // ---- QNAP（NAS） ----
  '0014FD': 'QNAP（NAS）',

  // ---- Intel ----
  '001500': 'Intel',

  // ---- Microsoft Hyper-V（虚拟网卡） ----
  '00155D': 'Microsoft Hyper-V（虚拟网卡）',

  // ---- Samsung（打印机） ----
  '001599': 'Samsung（打印机）',

  // ---- Xensource（虚拟网卡） ----
  '00163E': 'Xensource（虚拟网卡）',

  // ---- Apple ----
  '0016CB': 'Apple',

  // ---- Xiaomi ----
  '0016E0': 'Xiaomi',

  // ---- Intel ----
  '0016EA': 'Intel',

  // ---- Philips（智能照明） ----
  '001788': 'Philips（智能照明）',

  // ---- Kyocera（打印机） ----
  '0017C8': 'Kyocera（打印机）',

  // ---- Samsung ----
  '0017C9': 'Samsung',

  // ---- Apple ----
  '0017F2': 'Apple',

  // ---- Microsoft ----
  '0017FA': 'Microsoft',

  // ---- Netgear ----
  '00184D': 'Netgear',

  // ---- Huawei ----
  '001882': 'Huawei',

  // ---- Intel ----
  '0018DE': 'Intel',
  '0019D1': 'Intel',

  // ---- Google（Chromecast） ----
  '001A11': 'Google（Chromecast）',

  // ---- Philips（智能照明） ----
  '001A22': 'Philips（智能照明）',

  // ---- Cisco ----
  '001B0C': 'Cisco',

  // ---- Intel ----
  '001B21': 'Intel',

  // ---- Netgear ----
  '001B2F': 'Netgear',

  // ---- Apple ----
  '001B63': 'Apple',

  // ---- HP（打印机） ----
  '001B78': 'HP（打印机）',

  // ---- Brother（打印机） ----
  '001BA9': 'Brother（打印机）',

  // ---- ASUSTek ----
  '001BFC': 'ASUSTek',

  // ---- VMware（虚拟网卡） ----
  '001C14': 'VMware（虚拟网卡）',

  // ---- Apple ----
  '001CB3': 'Apple',

  // ---- Intel ----
  '001CC0': 'Intel',

  // ---- Belkin ----
  '001CDF': 'Belkin',

  // ---- Samsung ----
  '001D25': 'Samsung',

  // ---- Microsoft ----
  '001DD8': 'Microsoft',

  // ---- Intel ----
  '001DE0': 'Intel',

  // ---- Canon（打印机） ----
  '001E0B': 'Canon（打印机）',

  // ---- Huawei ----
  '001E10': 'Huawei',

  // ---- Sony ----
  '001E45': 'Sony',

  // ---- Apple ----
  '001E52': 'Apple',

  // ---- D-Link ----
  '001E58': 'D-Link',

  // ---- Intel ----
  '001E64': 'Intel',

  // ---- Apple ----
  '001EC2': 'Apple',

  // ---- Realtek ----
  '001F1F': 'Realtek',

  // ---- Netgear ----
  '001F33': 'Netgear',

  // ---- Intel ----
  '001F3B': 'Intel',

  // ---- Apple ----
  '001F5B': 'Apple',

  // ---- OPPO ----
  '001FA4': 'OPPO',

  // ---- vivo ----
  '001FE1': 'vivo',

  // ---- Apple ----
  '001FF3': 'Apple',

  // ---- Advanced Digital Broadcast ----
  '001FF9': 'Advanced Digital Broadcast',

  // ---- Cisco ----
  '002155': 'Cisco',

  // ---- Intel ----
  '00215C': 'Intel',

  // ---- Xiaomi ----
  '0021CC': 'Xiaomi',

  // ---- Samsung ----
  '0021D1': 'Samsung',

  // ---- Apple ----
  '0021E9': 'Apple',

  // ---- Netgear ----
  '00223F': 'Netgear',

  // ---- Microsoft ----
  '002248': 'Microsoft',

  // ---- Liteon ----
  '00225F': 'Liteon',

  // ---- Cisco ----
  '002290': 'Cisco',

  // ---- D-Link ----
  '0022B0': 'D-Link',

  // ---- Intel ----
  '0022FB': 'Intel',

  // ---- Apple ----
  '002312': 'Apple',
  '002332': 'Apple',

  // ---- Cisco ----
  '00235E': 'Cisco',

  // ---- Apple ----
  '00236C': 'Apple',
  '0023DF': 'Apple',
  '002436': 'Apple',

  // ---- Samsung ----
  '002454': 'Samsung',

  // ---- Realtek ----
  '00247B': 'Realtek',

  // ---- Netgear ----
  '0024B2': 'Netgear',

  // ---- Sony ----
  '0024BE': 'Sony',

  // ---- Intel ----
  '0024D7': 'Intel',

  // ---- Apple ----
  '002500': 'Apple',
  '00254B': 'Apple',

  // ---- Huawei ----
  '002568': 'Huawei',

  // ---- Apple ----
  '0025BC': 'Apple',

  // ---- Sony ----
  '0025E7': 'Sony',

  // ---- Apple ----
  '002608': 'Apple',
  '00264A': 'Apple',

  // ---- Cisco-Linksys ----
  '00265E': 'Cisco-Linksys',

  // ---- Cisco ----
  '002699': 'Cisco',

  // ---- Apple ----
  '0026B0': 'Apple',
  '0026BB': 'Apple',

  // ---- Intel ----
  '0026C6': 'Intel',

  // ---- Netgear ----
  '0026F2': 'Netgear',

  // ---- TP-Link ----
  '002719': 'TP-Link',

  // ---- Cisco ----
  '002A6A': 'Cisco',

  // ---- Apple ----
  '003065': 'Apple',

  // ---- Huawei ----
  '0034FE': 'Huawei',

  // ---- Apple ----
  '003EE1': 'Apple',

  // ---- Axis Communications ----
  '00408C': 'Axis Communications',

  // ---- Huawei ----
  '00464B': 'Huawei',

  // ---- VMware（虚拟网卡） ----
  '005056': 'VMware（虚拟网卡）',

  // ---- D-Link ----
  '0050BA': 'D-Link',

  // ---- Apple ----
  '0050E4': 'Apple',

  // ---- Cisco ----
  '0050F2': 'Cisco',

  // ---- Huawei ----
  '005A13': 'Huawei',

  // ---- Apple ----
  '006171': 'Apple',

  // ---- Brother（打印机） ----
  '008077': 'Brother（打印机）',

  // ---- Apple ----
  '0080C8': 'Apple',

  // ---- Western Digital ----
  '0090A9': 'Western Digital',

  // ---- Apple ----
  '00A040': 'Apple',

  // ---- Intel ----
  '00A0C9': 'Intel',
  '00AA00': 'Intel',

  // ---- Apple ----
  '00C610': 'Apple',
  '00CDBA': 'Apple',
  '00DB70': 'Apple',

  // ---- Realtek ----
  '00E04C': 'Realtek',

  // ---- Apple ----
  '00F4B9': 'Apple',
  '00F76F': 'Apple',

  // ---- Docker（虚拟网卡） ----
  '0242AC': 'Docker（虚拟网卡）',

  // ---- Apple ----
  '040CCE': 'Apple',
  '042665': 'Apple',
  '04489A': 'Apple',
  '0452F3': 'Apple',

  // ---- TP-Link ----
  '045C6C': 'TP-Link',

  // ---- Sony ----
  '045D4B': 'Sony',

  // ---- vivo ----
  '045F7A': 'vivo',

  // ---- Apple ----
  '0469F8': 'Apple',

  // ---- Huawei ----
  '04BD70': 'Huawei',
  '04C06F': 'Huawei',

  // ---- Xiaomi ----
  '04CF8C': 'Xiaomi',

  // ---- Apple ----
  '04D3CF': 'Apple',
  '04DB56': 'Apple',
  '04E536': 'Apple',

  // ---- Xiaomi（电视） ----
  '04EE91': 'Xiaomi（电视）',

  // ---- Apple ----
  '04F13E': 'Apple',
  '04F7E4': 'Apple',

  // ---- Huawei ----
  '04F938': 'Huawei',

  // ---- Apple ----
  '080007': 'Apple',

  // ---- VirtualBox（虚拟网卡） ----
  '080027': 'VirtualBox（虚拟网卡）',

  // ---- Sony ----
  '080046': 'Sony',

  // ---- Samsung ----
  '08373D': 'Samsung',

  // ---- Huawei ----
  '086361': 'Huawei',

  // ---- Apple ----
  '086D41': 'Apple',
  '087045': 'Apple',
  '087402': 'Apple',

  // ---- Netgear ----
  '08BD43': 'Netgear',

  // ---- Apple ----
  '0C1539': 'Apple',

  // ---- Xiaomi ----
  '0C1DAF': 'Xiaomi',

  // ---- Apple ----
  '0C3021': 'Apple',

  // ---- Huawei ----
  '0C37DC': 'Huawei',

  // ---- Apple ----
  '0C3E9F': 'Apple',
  '0C4DE9': 'Apple',
  '0C5101': 'Apple',

  // ---- Samsung ----
  '0C715D': 'Samsung',

  // ---- TP-Link ----
  '0C722C': 'TP-Link',

  // ---- Apple ----
  '0C74C2': 'Apple',
  '0C771A': 'Apple',

  // ---- TP-Link ----
  '0C8063': 'TP-Link',
  '0C8268': 'TP-Link',

  // ---- Huawei ----
  '0C96BF': 'Huawei',

  // ---- Apple ----
  '0CBC9F': 'Apple',
  '0CD746': 'Apple',

  // ---- Sony ----
  '0CFE45': 'Sony',

  // ---- Huawei ----
  '101B54': 'Huawei',

  // ---- Apple ----
  '101C0C': 'Apple',

  // ---- TP-Link ----
  '1027F5': 'TP-Link',

  // ---- Xiaomi ----
  '102AB3': 'Xiaomi',

  // ---- OPPO ----
  '102EAF': 'OPPO',

  // ---- Apple ----
  '10417F': 'Apple',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  '10521C': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Buffalo ----
  '106F3F': 'Buffalo',

  // ---- Samsung ----
  '1077B1': 'Samsung',

  // ---- Apple ----
  '1093E9': 'Apple',
  '109ADD': 'Apple',

  // ---- Huawei ----
  '10C61F': 'Huawei',

  // ---- Tuya（智能家居） ----
  '10D561': 'Tuya（智能家居）',

  // ---- Apple ----
  '10DDB1': 'Apple',

  // ---- TP-Link ----
  '10FEE0': 'TP-Link',

  // ---- Apple ----
  '14109F': 'Apple',

  // ---- Samsung ----
  '14568E': 'Samsung',

  // ---- Apple ----
  '145A05': 'Apple',
  '14BD61': 'Apple',

  // ---- TP-Link ----
  '14CC20': 'TP-Link',
  '14CF92': 'TP-Link',

  // ---- Xiaomi ----
  '14F65A': 'Xiaomi',

  // ---- Apple ----
  '18810E': 'Apple',
  '18AF61': 'Apple',

  // ---- Sony ----
  '18B5EF': 'Sony',

  // ---- Samsung ----
  '18E2C2': 'Samsung',

  // ---- Apple ----
  '18E7F4': 'Apple',
  '18EE69': 'Apple',
  '18F643': 'Apple',
  '1C1AC0': 'Apple',

  // ---- Huawei ----
  '1C1D67': 'Huawei',

  // ---- Apple ----
  '1C36BB': 'Apple',

  // ---- TP-Link ----
  '1C3BF3': 'TP-Link',

  // ---- Samsung ----
  '1C5A3E': 'Samsung',

  // ---- Apple ----
  '1C5CF2': 'Apple',

  // ---- TP-Link ----
  '1C61B4': 'TP-Link',

  // ---- Sony ----
  '1C7B21': 'Sony',

  // ---- Huawei ----
  '1C8E5C': 'Huawei',

  // ---- Apple ----
  '1C9148': 'Apple',
  '1CABA7': 'Apple',
  '1CE62B': 'Apple',

  // ---- TP-Link ----
  '1CFA68': 'TP-Link',

  // ---- vivo ----
  '2032C6': 'vivo',

  // ---- Netgear ----
  '204E7F': 'Netgear',

  // ---- Apple ----
  '2078F0': 'Apple',
  '207D74': 'Apple',
  '20A2E4': 'Apple',

  // ---- Xiaomi ----
  '20A783': 'Xiaomi',

  // ---- Apple ----
  '20C9D0': 'Apple',

  // ---- Huawei ----
  '20F3A3': 'Huawei',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  '240AC4': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- QNAP（NAS） ----
  '245EBE': 'QNAP（NAS）',

  // ---- Huawei ----
  '24699E': 'Huawei',

  // ---- Apple ----
  '24A074': 'Apple',
  '24A2E1': 'Apple',
  '24AB81': 'Apple',

  // ---- Samsung ----
  '24DBED': 'Samsung',

  // ---- Xiaomi ----
  '24DC9C': 'Xiaomi',

  // ---- Apple ----
  '24E314': 'Apple',
  '24F094': 'Apple',

  // ---- Xiaomi ----
  '286C07': 'Xiaomi',

  // ---- Netgear ----
  '28C68E': 'Netgear',

  // ---- Apple ----
  '28CFDA': 'Apple',
  '28E02C': 'Apple',

  // ---- Xiaomi ----
  '28E31F': 'Xiaomi',

  // ---- Apple ----
  '28E7CF': 'Apple',
  '28ED6A': 'Apple',
  '28F076': 'Apple',
  '2C1F23': 'Apple',
  '2C200B': 'Apple',

  // ---- Netgear ----
  '2C3033': 'Netgear',

  // ---- Apple ----
  '2C3361': 'Apple',

  // ---- Samsung ----
  '2C440B': 'Samsung',

  // ---- Roku（电视盒子） ----
  '2C54CF': 'Roku（电视盒子）',

  // ---- Huawei ----
  '2C55D3': 'Huawei',

  // ---- Xiaomi ----
  '2C9802': 'Xiaomi',

  // ---- Apple ----
  '2CB43A': 'Apple',
  '2CF0A2': 'Apple',
  '2CF0EE': 'Apple',
  '3010E4': 'Apple',
  '3035AD': 'Apple',

  // ---- Netgear ----
  '30469A': 'Netgear',

  // ---- Apple ----
  '30636B': 'Apple',

  // ---- Samsung ----
  '3080CE': 'Samsung',

  // ---- Apple ----
  '3090AB': 'Apple',

  // ---- TP-Link ----
  '30B5C2': 'TP-Link',

  // ---- Huawei ----
  '30D17E': 'Huawei',

  // ---- Apple ----
  '30F7C5': 'Apple',

  // ---- Sony ----
  '30F9ED': 'Sony',

  // ---- Huawei ----
  '3400A3': 'Huawei',

  // ---- Apple ----
  '34363B': 'Apple',

  // ---- TP-Link ----
  '3460F9': 'TP-Link',

  // ---- Sony ----
  '3475C7': 'Sony',

  // ---- Xiaomi ----
  '3480B3': 'Xiaomi',

  // ---- Apple ----
  '34A395': 'Apple',

  // ---- Samsung ----
  '34AA8B': 'Samsung',

  // ---- Apple ----
  '34AB37': 'Apple',
  '34C059': 'Apple',

  // ---- Xiaomi ----
  '34CE00': 'Xiaomi',

  // ---- Intel ----
  '34E12D': 'Intel',

  // ---- Apple ----
  '34E2FD': 'Apple',

  // ---- TP-Link ----
  '34E894': 'TP-Link',

  // ---- Apple ----
  '380F4A': 'Apple',

  // ---- Tuya（智能家居） ----
  '381F8D': 'Tuya（智能家居）',

  // ---- Apple ----
  '38484C': 'Apple',
  '3871DE': 'Apple',

  // ---- Netgear ----
  '3894ED': 'Netgear',

  // ---- Samsung ----
  '38AA3C': 'Samsung',

  // ---- Apple ----
  '38B54D': 'Apple',
  '38C986': 'Apple',

  // ---- ASUSTek ----
  '38D547': 'ASUSTek',

  // ---- Huawei ----
  '38F889': 'Huawei',

  // ---- Apple ----
  '3C0754': 'Apple',

  // ---- Sony ----
  '3C0771': 'Sony',

  // ---- Brother（打印机） ----
  '3C2AF4': 'Brother（打印机）',

  // ---- Apple ----
  '3C2EF9': 'Apple',

  // ---- Netgear ----
  '3C3786': 'Netgear',

  // ---- TP-Link ----
  '3C46D8': 'TP-Link',

  // ---- Xiaomi ----
  '3C47E9': 'Xiaomi',

  // ---- Samsung ----
  '3C5A37': 'Samsung',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  '3C71BF': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- vivo ----
  '3C8BFE': 'vivo',

  // ---- Intel ----
  '3C9509': 'Intel',

  // ---- Apple ----
  '3CAB8E': 'Apple',
  '3CD0F8': 'Apple',

  // ---- Huawei ----
  '3CDFBD': 'Huawei',

  // ---- Apple ----
  '3CE072': 'Apple',

  // ---- Dahua（摄像头） ----
  '3CEF8C': 'Dahua（摄像头）',

  // ---- TP-Link ----
  '40169F': 'TP-Link',

  // ---- Sony ----
  '402BA1': 'Sony',

  // ---- Apple ----
  '40331A': 'Apple',

  // ---- OPPO ----
  '4045DA': 'OPPO',

  // ---- Netgear ----
  '405D82': 'Netgear',

  // ---- Xiaomi ----
  '406C2A': 'Xiaomi',

  // ---- Apple ----
  '406C8F': 'Apple',
  '40A6D9': 'Apple',
  '40B395': 'Apple',

  // ---- Huawei ----
  '40CBA8': 'Huawei',

  // ---- Apple ----
  '40D32D': 'Apple',

  // ---- Samsung ----
  '40D3AE': 'Samsung',

  // ---- Hikvision（摄像头） ----
  '4419B6': 'Hikvision（摄像头）',

  // ---- Xiaomi ----
  '44237C': 'Xiaomi',

  // ---- Apple ----
  '442A60': 'Apple',
  '4480EB': 'Apple',

  // ---- Netgear ----
  '4494FC': 'Netgear',

  // ---- Huawei ----
  '44C346': 'Huawei',

  // ---- Apple ----
  '44D884': 'Apple',

  // ---- Ubiquiti ----
  '44D9E7': 'Ubiquiti',

  // ---- Apple ----
  '44FB42': 'Apple',

  // ---- Arcadyan ----
  '44FE3B': 'Arcadyan',

  // ---- Apple ----
  '483B38': 'Apple',
  '48437C': 'Apple',
  '48746E': 'Apple',
  '48A195': 'Apple',

  // ---- Samsung ----
  '48A5E7': 'Samsung',

  // ---- Apple ----
  '48BF6B': 'Apple',

  // ---- Xiaomi ----
  '48C0C3': 'Xiaomi',

  // ---- Apple ----
  '48D705': 'Apple',

  // ---- D-Link ----
  '48EE0C': 'D-Link',

  // ---- Arcadyan ----
  '4C1744': 'Arcadyan',

  // ---- Huawei ----
  '4C1FCC': 'Huawei',

  // ---- Apple ----
  '4C3275': 'Apple',

  // ---- Intel ----
  '4C3488': 'Intel',

  // ---- Samsung ----
  '4C3C16': 'Samsung',

  // ---- Xiaomi ----
  '4C49E3': 'Xiaomi',

  // ---- Huawei ----
  '4C5499': 'Huawei',

  // ---- Apple ----
  '4C57CA': 'Apple',

  // ---- Netgear ----
  '4C60DE': 'Netgear',

  // ---- Apple ----
  '4C8D79': 'Apple',
  '4CB199': 'Apple',

  // ---- Huawei ----
  '501D93': 'Huawei',

  // ---- vivo ----
  '5076AF': 'vivo',

  // ---- TP-Link ----
  '50C7BF': 'TP-Link',

  // ---- Samsung ----
  '50CCF8': 'Samsung',

  // ---- Apple ----
  '50EAD6': 'Apple',

  // ---- Xiaomi ----
  '50EC50': 'Xiaomi',

  // ---- Realtek ----
  '52540A': 'Realtek',
  '5254AB': 'Realtek',

  // ---- ASUSTek ----
  '542B8D': 'ASUSTek',

  // ---- Huawei ----
  '5439DF': 'Huawei',

  // ---- Samsung ----
  '5492BE': 'Samsung',

  // ---- Apple ----
  '54AE27': 'Apple',
  '54E43A': 'Apple',
  '54EAA8': 'Apple',
  '581FAA': 'Apple',
  '5855CA': 'Apple',
  '58B035': 'Apple',

  // ---- Beijing Xiaomi ----
  '5C0214': 'Beijing Xiaomi',

  // ---- Xiaomi ----
  '5C02CA': 'Xiaomi',

  // ---- Samsung ----
  '5C0A5B': 'Samsung',

  // ---- LG（电视） ----
  '5C4979': 'LG（电视）',

  // ---- Huawei ----
  '5C4CA9': 'Huawei',

  // ---- Apple ----
  '5C5948': 'Apple',

  // ---- TP-Link ----
  '5C63BF': 'TP-Link',

  // ---- Apple ----
  '5C95AE': 'Apple',
  '5C969D': 'Apple',

  // ---- Huawei ----
  '5CA86A': 'Huawei',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  '5CCF7F': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Intel ----
  '5CE0C5': 'Intel',

  // ---- Apple ----
  '5CF5DA': 'Apple',
  '5CF938': 'Apple',

  // ---- Dell ----
  '5CF9DD': 'Dell',

  // ---- Samsung ----
  '606BB3': 'Samsung',
  '60A4D0': 'Samsung',

  // ---- Apple ----
  '60C547': 'Apple',
  '60D9C7': 'Apple',

  // ---- Huawei ----
  '60DEE4': 'Huawei',

  // ---- Apple ----
  '60F81D': 'Apple',
  '60FACD': 'Apple',
  '60FB42': 'Apple',
  '64200C': 'Apple',

  // ---- Huawei ----
  '643E8C': 'Huawei',

  // ---- Netgear ----
  '6466B3': 'Netgear',

  // ---- TP-Link ----
  '646E97': 'TP-Link',

  // ---- Xiaomi（智能家居） ----
  '6490C1': 'Xiaomi（智能家居）',

  // ---- OPPO ----
  '64A2F9': 'OPPO',

  // ---- Apple ----
  '64A3CB': 'Apple',

  // ---- Xiaomi ----
  '64B473': 'Xiaomi',

  // ---- Apple ----
  '64B9E8': 'Apple',

  // ---- Xiaomi ----
  '64CC2E': 'Xiaomi',

  // ---- Apple ----
  '64E682': 'Apple',

  // ---- Huawei ----
  '6805CA': 'Huawei',

  // ---- Xiaomi ----
  '683E34': 'Xiaomi',

  // ---- TP-Link ----
  '68572D': 'TP-Link',

  // ---- Apple ----
  '685B35': 'Apple',
  '68A86D': 'Apple',
  '68AE20': 'Apple',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  '68C63A': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Apple ----
  '68D93C': 'Apple',
  '68DB96': 'Apple',

  // ---- Samsung ----
  '68EBAE': 'Samsung',

  // ---- Apple ----
  '68FB7E': 'Apple',

  // ---- TP-Link ----
  '68FF7B': 'TP-Link',

  // ---- Sony ----
  '6C0E0D': 'Sony',

  // ---- Apple ----
  '6C19C0': 'Apple',

  // ---- Xiaomi ----
  '6C1B3F': 'Xiaomi',

  // ---- Samsung ----
  '6C2F2C': 'Samsung',

  // ---- Apple ----
  '6C3E6D': 'Apple',
  '6C4008': 'Apple',

  // ---- TCL ----
  '6C5AB0': 'TCL',

  // ---- vivo ----
  '6C5AB5': 'vivo',

  // ---- Apple ----
  '6C709F': 'Apple',
  '6C72E7': 'Apple',
  '6C8DC1': 'Apple',
  '6C94F8': 'Apple',

  // ---- Google（Chromecast） ----
  '6CADF8': 'Google（Chromecast）',

  // ---- Netgear ----
  '6CB0CE': 'Netgear',

  // ---- Huawei ----
  '6CB749': 'Huawei',

  // ---- Apple ----
  '6CC26B': 'Apple',
  '70110E': 'Apple',
  '7014A6': 'Apple',
  '703EAC': 'Apple',
  '70484D': 'Apple',

  // ---- Xiaomi ----
  '704D7B': 'Xiaomi',

  // ---- TP-Link ----
  '704F57': 'TP-Link',

  // ---- Huawei ----
  '7071BC': 'Huawei',

  // ---- Apple ----
  '7073CB': 'Apple',

  // ---- ASUSTek ----
  '708BCD': 'ASUSTek',

  // ---- Apple ----
  '70A2B3': 'Apple',

  // ---- Cisco Meraki ----
  '70A741': 'Cisco Meraki',

  // ---- Apple ----
  '70CD60': 'Apple',

  // ---- Huawei ----
  '70D931': 'Huawei',

  // ---- Apple ----
  '70DEE2': 'Apple',
  '70ECE4': 'Apple',

  // ---- Samsung ----
  '70F927': 'Samsung',

  // ---- Apple ----
  '7427EA': 'Apple',
  '745E1C': 'Apple',

  // ---- Huawei ----
  '74DADA': 'Huawei',

  // ---- Apple ----
  '74E1B6': 'Apple',
  '74E2F5': 'Apple',

  // ---- Xiaomi ----
  '7802F8': 'Xiaomi',

  // ---- Xiaomi（智能家居） ----
  '7811DC': 'Xiaomi（智能家居）',

  // ---- ASUSTek ----
  '7824AF': 'ASUSTek',

  // ---- Apple ----
  '7831C1': 'Apple',
  '783A84': 'Apple',

  // ---- Sony（电视） ----
  '785C72': 'Sony（电视）',

  // ---- Apple ----
  '786C1C': 'Apple',
  '787B8A': 'Apple',

  // ---- Sony ----
  '78843C': 'Sony',

  // ---- Ubiquiti ----
  '788A20': 'Ubiquiti',

  // ---- Apple ----
  '789F70': 'Apple',
  '78A3E4': 'Apple',

  // ---- Samsung ----
  '78ABBB': 'Samsung',

  // ---- Apple ----
  '78CA39': 'Apple',

  // ---- Netgear ----
  '78D294': 'Netgear',

  // ---- Huawei ----
  '78D752': 'Huawei',

  // ---- Apple ----
  '78D75F': 'Apple',
  '78FD94': 'Apple',
  '7C0191': 'Apple',
  '7C11BE': 'Apple',

  // ---- Xiaomi ----
  '7C1DD9': 'Xiaomi',

  // ---- Microsoft ----
  '7C1E52': 'Microsoft',

  // ---- Huawei ----
  '7C6097': 'Huawei',

  // ---- Samsung ----
  '7C6193': 'Samsung',

  // ---- Apple ----
  '7C6D62': 'Apple',
  '7C6DF8': 'Apple',

  // ---- TP-Link ----
  '7C8BCA': 'TP-Link',

  // ---- Intel ----
  '7CB27D': 'Intel',

  // ---- Xiaomi ----
  '7CB59B': 'Xiaomi',

  // ---- Apple ----
  '7CC3A1': 'Apple',
  '7CC537': 'Apple',
  '7CD1C3': 'Apple',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  '7CDFA1': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Apple ----
  '7CF05F': 'Apple',
  '7CFADF': 'Apple',
  '80006E': 'Apple',

  // ---- Samsung ----
  '8018A7': 'Samsung',

  // ---- Intel ----
  '8086F2': 'Intel',

  // ---- Huawei ----
  '80B686': 'Huawei',

  // ---- Apple ----
  '80BE05': 'Apple',
  '80E650': 'Apple',
  '80EA96': 'Apple',

  // ---- Huawei ----
  '80FB06': 'Huawei',

  // ---- Xiaomi ----
  '8400D2': 'Xiaomi',

  // ---- Samsung ----
  '84119E': 'Samsung',

  // ---- TP-Link ----
  '8416F9': 'TP-Link',

  // ---- Netgear ----
  '841B5E': 'Netgear',

  // ---- vivo ----
  '845CF3': 'vivo',

  // ---- Huawei ----
  '84A8E4': 'Huawei',

  // ---- Apple ----
  '84B153': 'Apple',

  // ---- Huawei ----
  '84D81B': 'Huawei',
  '84DBAC': 'Huawei',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  '84F3EB': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Apple ----
  '84FCAC': 'Apple',
  '84FCFE': 'Apple',

  // ---- Samsung ----
  '88329B': 'Samsung',

  // ---- Apple ----
  '8863DF': 'Apple',
  '886B6E': 'Apple',

  // ---- Huawei ----
  '88C397': 'Huawei',

  // ---- Apple ----
  '88C663': 'Apple',
  '88CB87': 'Apple',

  // ---- Huawei ----
  '88E3AB': 'Huawei',

  // ---- Apple ----
  '88E87F': 'Apple',
  '8C006D': 'Apple',

  // ---- Huawei ----
  '8C0D76': 'Huawei',

  // ---- Intel ----
  '8C1645': 'Intel',

  // ---- Apple ----
  '8C2937': 'Apple',
  '8C2DAA': 'Apple',
  '8C5877': 'Apple',

  // ---- Samsung ----
  '8C71F8': 'Samsung',

  // ---- Apple ----
  '8C7B9D': 'Apple',
  '8C7C92': 'Apple',
  '8C8EF2': 'Apple',

  // ---- Cisco ----
  '8CA682': 'Cisco',

  // ---- Xiaomi ----
  '8CBEBE': 'Xiaomi',

  // ---- Huawei ----
  '8CE081': 'Huawei',
  '8CF228': 'Huawei',

  // ---- Apple ----
  '8CFABA': 'Apple',

  // ---- Xiaomi ----
  '8CFDF0': 'Xiaomi',

  // ---- Dahua（摄像头） ----
  '9002A9': 'Dahua（摄像头）',

  // ---- Synology（NAS） ----
  '9009D0': 'Synology（NAS）',

  // ---- Huawei ----
  '90174F': 'Huawei',
  '9017AC': 'Huawei',

  // ---- Apple ----
  '9027E4': 'Apple',
  '9060F1': 'Apple',

  // ---- Samsung ----
  '90633B': 'Samsung',

  // ---- Xiaomi ----
  '9082EA': 'Xiaomi',

  // ---- Apple ----
  '90840D': 'Apple',

  // ---- D-Link ----
  '9094E4': 'D-Link',

  // ---- Apple ----
  '90B21F': 'Apple',
  '90B931': 'Apple',

  // ---- TP-Link ----
  '90F652': 'TP-Link',

  // ---- Apple ----
  '90FD61': 'Apple',

  // ---- Xiaomi ----
  '9412D3': 'Xiaomi',

  // ---- Samsung ----
  '943BB0': 'Samsung',

  // ---- OPPO ----
  '94652D': 'OPPO',

  // ---- Intel ----
  '94659C': 'Intel',

  // ---- Huawei ----
  '94A7B7': 'Huawei',
  '94DBDA': 'Huawei',

  // ---- Apple ----
  '94E96A': 'Apple',
  '94F6A3': 'Apple',
  '9801A7': 'Apple',
  '9823F6': 'Apple',

  // ---- Samsung ----
  '98398E': 'Samsung',

  // ---- Apple ----
  '985B7B': 'Apple',

  // ---- vivo ----
  '986EE8': 'vivo',

  // ---- Apple ----
  '989E63': 'Apple',
  '98B8E3': 'Apple',
  '98D6BB': 'Apple',

  // ---- TP-Link ----
  '98DED0': 'TP-Link',

  // ---- Apple ----
  '98E0D9': 'Apple',
  '98F0AB': 'Apple',
  '98FE94': 'Apple',

  // ---- Samsung ----
  '9C0298': 'Samsung',

  // ---- Apple ----
  '9C04EB': 'Apple',
  '9C207B': 'Apple',
  '9C293F': 'Apple',
  '9C35EB': 'Apple',

  // ---- Netgear ----
  '9C3DCF': 'Netgear',

  // ---- Apple ----
  '9C4FDA': 'Apple',

  // ---- Sony（电视） ----
  '9C5CF9': 'Sony（电视）',

  // ---- Apple ----
  '9C84BF': 'Apple',

  // ---- Xiaomi ----
  '9C99A0': 'Xiaomi',

  // ---- Xerox（打印机） ----
  '9CAED3': 'Xerox（打印机）',

  // ---- Huawei ----
  '9CB2B2': 'Huawei',

  // ---- Intel ----
  '9CB6D0': 'Intel',

  // ---- Apple ----
  '9CE65E': 'Apple',
  '9CF387': 'Apple',
  '9CFC01': 'Apple',

  // ---- Netgear ----
  'A00460': 'Netgear',

  // ---- Apple ----
  'A01828': 'Apple',

  // ---- Samsung ----
  'A02195': 'Samsung',

  // ---- Netgear ----
  'A040A0': 'Netgear',

  // ---- Xiaomi ----
  'A086C6': 'Xiaomi',

  // ---- Intel ----
  'A0A8CD': 'Intel',

  // ---- Sony ----
  'A0E453': 'Sony',

  // ---- Apple ----
  'A0EDCD': 'Apple',

  // ---- TP-Link ----
  'A0F3C1': 'TP-Link',

  // ---- Huawei ----
  'A0F479': 'Huawei',

  // ---- TP-Link ----
  'A42B8C': 'TP-Link',
  'A42BB0': 'TP-Link',

  // ---- Apple ----
  'A45E60': 'Apple',
  'A46706': 'Apple',

  // ---- Huawei ----
  'A47174': 'Huawei',

  // ---- Apple ----
  'A4B197': 'Apple',
  'A4C361': 'Apple',

  // ---- Intel ----
  'A4C494': 'Intel',

  // ---- Huawei ----
  'A4C64F': 'Huawei',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  'A4CF12': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Apple ----
  'A4D18C': 'Apple',
  'A4D1D2': 'Apple',

  // ---- Xiaomi ----
  'A4DA22': 'Xiaomi',

  // ---- Samsung ----
  'A4EBD3': 'Samsung',

  // ---- Apple ----
  'A4F1E8': 'Apple',

  // ---- LG（电视） ----
  'A816B2': 'LG（电视）',

  // ---- Apple ----
  'A82066': 'Apple',

  // ---- TP-Link ----
  'A8574E': 'TP-Link',

  // ---- Apple ----
  'A860B6': 'Apple',
  'A8667F': 'Apple',
  'A886DD': 'Apple',
  'A88808': 'Apple',
  'A8968A': 'Apple',
  'A8BB56': 'Apple',

  // ---- Huawei ----
  'A8C83A': 'Huawei',

  // ---- Apple ----
  'A8FAD8': 'Apple',

  // ---- ASUSTek ----
  'AC220B': 'ASUSTek',

  // ---- Apple ----
  'AC293A': 'Apple',

  // ---- Roku（电视盒子） ----
  'AC3A7A': 'Roku（电视盒子）',

  // ---- Apple ----
  'AC3C0B': 'Apple',

  // ---- Huawei ----
  'AC4E91': 'Huawei',

  // ---- Samsung ----
  'AC5F3E': 'Samsung',

  // ---- Apple ----
  'AC61EA': 'Apple',

  // ---- Intel ----
  'AC7289': 'Intel',

  // ---- Apple ----
  'AC7F3E': 'Apple',

  // ---- TP-Link ----
  'AC84C6': 'TP-Link',

  // ---- Huawei ----
  'AC853D': 'Huawei',

  // ---- Apple ----
  'AC87A3': 'Apple',

  // ---- Sony ----
  'AC9B0A': 'Sony',

  // ---- ASUSTek ----
  'AC9E17': 'ASUSTek',

  // ---- Apple ----
  'ACBC32': 'Apple',

  // ---- Xiaomi ----
  'ACC1EE': 'Xiaomi',

  // ---- Apple ----
  'ACCF5C': 'Apple',
  'ACFDEC': 'Apple',
  'B019C6': 'Apple',
  'B03495': 'Apple',

  // ---- Netgear ----
  'B03956': 'Netgear',

  // ---- TP-Link ----
  'B0487A': 'TP-Link',

  // ---- Apple ----
  'B065BD': 'Apple',

  // ---- Netgear ----
  'B07FB9': 'Netgear',

  // ---- TP-Link ----
  'B0958E': 'TP-Link',

  // ---- Huawei ----
  'B0989F': 'Huawei',

  // ---- Roku（电视盒子） ----
  'B0A737': 'Roku（电视盒子）',

  // ---- TP-Link ----
  'B0BE76': 'TP-Link',

  // ---- Apple ----
  'B0CA68': 'Apple',

  // ---- Samsung ----
  'B0DF3A': 'Samsung',

  // ---- Xiaomi ----
  'B0E235': 'Xiaomi',

  // ---- vivo ----
  'B40B78': 'vivo',

  // ---- TP-Link ----
  'B40F3B': 'TP-Link',

  // ---- Huawei ----
  'B41513': 'Huawei',

  // ---- Apple ----
  'B418D1': 'Apple',
  'B44BD2': 'Apple',

  // ---- Samsung ----
  'B46293': 'Samsung',

  // ---- Intel ----
  'B49691': 'Intel',

  // ---- TP-Link ----
  'B4B024': 'TP-Link',

  // ---- Xiaomi ----
  'B4F7A1': 'Xiaomi',

  // ---- Apple ----
  'B817C2': 'Apple',
  'B844D9': 'Apple',
  'B853AC': 'Apple',

  // ---- Samsung ----
  'B857D8': 'Samsung',

  // ---- Apple ----
  'B8782E': 'Apple',

  // ---- Huawei ----
  'B8BC1B': 'Huawei',

  // ---- Apple ----
  'B8C75D': 'Apple',
  'B8E856': 'Apple',
  'B8F6B1': 'Apple',

  // ---- Sony ----
  'B8F934': 'Sony',

  // ---- Apple ----
  'B8FF61': 'Apple',

  // ---- Samsung ----
  'BC1485': 'Samsung',

  // ---- Apple ----
  'BC3BAF': 'Apple',

  // ---- TP-Link ----
  'BC4699': 'TP-Link',

  // ---- Apple ----
  'BC4CC4': 'Apple',
  'BC52B7': 'Apple',
  'BC5436': 'Apple',
  'BC6778': 'Apple',
  'BC6C21': 'Apple',

  // ---- Sony ----
  'BC6EBE': 'Sony',

  // ---- Apple ----
  'BC926B': 'Apple',
  'BC9FEF': 'Apple',
  'BCA920': 'Apple',

  // ---- Hikvision（摄像头） ----
  'BCAD28': 'Hikvision（摄像头）',

  // ---- Huawei ----
  'BCE0C1': 'Huawei',

  // ---- Apple ----
  'BCEC5D': 'Apple',

  // ---- TP-Link ----
  'C006C3': 'TP-Link',

  // ---- Samsung ----
  'C01173': 'Samsung',

  // ---- Apple ----
  'C01ADA': 'Apple',

  // ---- TP-Link ----
  'C025E9': 'TP-Link',

  // ---- Netgear ----
  'C03F0E': 'Netgear',

  // ---- TP-Link ----
  'C04A00': 'TP-Link',

  // ---- Hikvision（摄像头） ----
  'C056E3': 'Hikvision（摄像头）',

  // ---- Apple ----
  'C06394': 'Apple',

  // ---- Huawei ----
  'C07009': 'Huawei',

  // ---- Apple ----
  'C0847A': 'Apple',

  // ---- Intel ----
  'C0E434': 'Intel',

  // ---- OPPO ----
  'C0EEFB': 'OPPO',

  // ---- Apple ----
  'C0F2FB': 'Apple',

  // ---- Netgear ----
  'C40415': 'Netgear',

  // ---- Huawei ----
  'C4072F': 'Huawei',

  // ---- Apple ----
  'C42C03': 'Apple',

  // ---- Netgear ----
  'C43DC7': 'Netgear',

  // ---- Samsung ----
  'C4576E': 'Samsung',

  // ---- Xiaomi ----
  'C46AB7': 'Xiaomi',

  // ---- TP-Link ----
  'C46E1F': 'TP-Link',

  // ---- Apple ----
  'C4B301': 'Apple',

  // ---- TP-Link ----
  'C4E984': 'TP-Link',

  // ---- LG（电视） ----
  'C808E9': 'LG（电视）',

  // ---- Samsung ----
  'C81479': 'Samsung',

  // ---- Apple ----
  'C81EE7': 'Apple',

  // ---- Huawei ----
  'C81FBE': 'Huawei',

  // ---- Apple ----
  'C82A14': 'Apple',
  'C8334B': 'Apple',

  // ---- Microsoft ----
  'C83F26': 'Microsoft',

  // ---- Apple ----
  'C869CD': 'Apple',
  'C88550': 'Apple',
  'C8B5B7': 'Apple',
  'C8BCC8': 'Apple',

  // ---- Huawei ----
  'C8D15E': 'Huawei',

  // ---- D-Link ----
  'C8D3A3': 'D-Link',

  // ---- Apple ----
  'C8E0EB': 'Apple',
  'C8F650': 'Apple',

  // ---- Samsung ----
  'CC07AB': 'Samsung',

  // ---- Apple ----
  'CC08E0': 'Apple',
  'CC29F5': 'Apple',

  // ---- Xiaomi ----
  'CC2D1B': 'Xiaomi',

  // ---- Netgear ----
  'CC40D0': 'Netgear',

  // ---- Apple ----
  'CC4463': 'Apple',

  // ---- Huawei ----
  'CC53B5': 'Huawei',

  // ---- Roku（电视盒子） ----
  'CC6DA0': 'Roku（电视盒子）',

  // ---- Apple ----
  'CC785F': 'Apple',

  // ---- Huawei ----
  'CC96A0': 'Huawei',

  // ---- Apple ----
  'CCC760': 'Apple',

  // ---- Samsung ----
  'D0176A': 'Samsung',

  // ---- Apple ----
  'D023DB': 'Apple',
  'D02598': 'Apple',

  // ---- Huawei ----
  'D02DB3': 'Huawei',

  // ---- Apple ----
  'D03311': 'Apple',

  // ---- Huawei ----
  'D0577B': 'Huawei',

  // ---- Apple ----
  'D0A637': 'Apple',
  'D0C5F3': 'Apple',
  'D0E140': 'Apple',

  // ---- Huawei ----
  'D4612E': 'Huawei',

  // ---- vivo ----
  'D46A91': 'vivo',

  // ---- TP-Link ----
  'D46E0E': 'TP-Link',

  // ---- Samsung ----
  'D487D8': 'Samsung',

  // ---- Xiaomi ----
  'D4970B': 'Xiaomi',

  // ---- Huawei ----
  'D4B709': 'Huawei',

  // ---- Apple ----
  'D4F46F': 'Apple',
  'D8004D': 'Apple',

  // ---- TP-Link ----
  'D80D17': 'TP-Link',

  // ---- Tuya（智能家居） ----
  'D81F12': 'Tuya（智能家居）',

  // ---- Apple ----
  'D83062': 'Apple',

  // ---- Roku（电视盒子） ----
  'D83134': 'Roku（电视盒子）',

  // ---- Samsung ----
  'D831CF': 'Samsung',

  // ---- OPPO ----
  'D83214': 'OPPO',

  // ---- Huawei ----
  'D8490B': 'Huawei',

  // ---- Apple ----
  'D89695': 'Apple',
  'D8A25E': 'Apple',

  // ---- Huawei ----
  'D8B370': 'Huawei',

  // ---- Apple ----
  'D8BB2C': 'Apple',
  'D8CF9C': 'Apple',
  'D8D1CB': 'Apple',

  // ---- Sony ----
  'D8D43C': 'Sony',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  'D8F15B': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Intel ----
  'D8FC93': 'Intel',

  // ---- Huawei ----
  'DC094C': 'Huawei',

  // ---- Apple ----
  'DC0C5C': 'Apple',
  'DC2B2A': 'Apple',
  'DC2B61': 'Apple',
  'DC3714': 'Apple',
  'DC415F': 'Apple',

  // ---- Xiaomi ----
  'DC44B6': 'Xiaomi',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  'DC4F22': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Samsung ----
  'DC7144': 'Samsung',

  // ---- Apple ----
  'DC86D8': 'Apple',
  'DC9B9C': 'Apple',

  // ---- Ubiquiti ----
  'DC9FDB': 'Ubiquiti',

  // ---- Apple ----
  'DCA4CA': 'Apple',
  'DCA904': 'Apple',

  // ---- Microsoft ----
  'DCB4C4': 'Microsoft',

  // ---- Huawei ----
  'DCD2FC': 'Huawei',

  // ---- Apple ----
  'DCE1AD': 'Apple',

  // ---- Netgear ----
  'DCEF09': 'Netgear',

  // ---- Huawei ----
  'E0247F': 'Huawei',

  // ---- AVM (Fritz!) ----
  'E0286D': 'AVM (Fritz!)',

  // ---- Apple ----
  'E0338E': 'Apple',

  // ---- Netgear ----
  'E0469A': 'Netgear',

  // ---- Dahua（摄像头） ----
  'E0508B': 'Dahua（摄像头）',

  // ---- Apple ----
  'E05F45': 'Apple',

  // ---- Netgear ----
  'E091F5': 'Netgear',

  // ---- Huawei ----
  'E09796': 'Huawei',

  // ---- Apple ----
  'E0ACCB': 'Apple',
  'E0B52D': 'Apple',
  'E0B9BA': 'Apple',
  'E0C767': 'Apple',
  'E0C97A': 'Apple',
  'E0F5C6': 'Apple',
  'E0F847': 'Apple',
  'E425E7': 'Apple',

  // ---- Samsung ----
  'E458B8': 'Samsung',

  // ---- Huawei ----
  'E468A3': 'Huawei',

  // ---- Apple ----
  'E48B7F': 'Apple',
  'E498D6': 'Apple',

  // ---- Intel ----
  'E4A471': 'Intel',

  // ---- Xiaomi ----
  'E4AAEC': 'Xiaomi',

  // ---- Huawei ----
  'E4C2D1': 'Huawei',

  // ---- Apple ----
  'E4CE8F': 'Apple',
  'E4E4AB': 'Apple',

  // ---- Netgear ----
  'E4F4C6': 'Netgear',

  // ---- Apple ----
  'E80688': 'Apple',

  // ---- vivo ----
  'E80734': 'vivo',

  // ---- Huawei ----
  'E8088B': 'Huawei',

  // ---- Samsung ----
  'E8508B': 'Samsung',

  // ---- Apple ----
  'E8802E': 'Apple',
  'E88D28': 'Apple',

  // ---- TP-Link ----
  'E894F6': 'TP-Link',

  // ---- Apple ----
  'E8B2AC': 'Apple',

  // ---- TP-Link ----
  'E8DE27': 'TP-Link',

  // ---- Netgear ----
  'E8FCAF': 'Netgear',

  // ---- TP-Link ----
  'EC086B': 'TP-Link',

  // ---- Samsung ----
  'EC1F72': 'Samsung',

  // ---- D-Link ----
  'EC2280': 'D-Link',

  // ---- Huawei ----
  'EC233D': 'Huawei',

  // ---- Apple ----
  'EC3586': 'Apple',
  'EC852F': 'Apple',

  // ---- Huawei ----
  'EC8CA2': 'Huawei',

  // ---- Xiaomi ----
  'EC9C32': 'Xiaomi',

  // ---- Apple ----
  'ECADB8': 'Apple',

  // ---- Philips（智能照明） ----
  'ECB5FA': 'Philips（智能照明）',

  // ---- Espressif（ESP 芯片，常见于 IoT 设备） ----
  'ECFABC': 'Espressif（ESP 芯片，常见于 IoT 设备）',

  // ---- Samsung ----
  'F008D1': 'Samsung',

  // ---- Apple ----
  'F01898': 'Apple',

  // ---- Huawei ----
  'F04347': 'Huawei',

  // ---- Apple ----
  'F0766F': 'Apple',
  'F0989D': 'Apple',

  // ---- OPPO ----
  'F09FC2': 'OPPO',

  // ---- Apple ----
  'F0B0E7': 'Apple',

  // ---- Xiaomi ----
  'F0B429': 'Xiaomi',

  // ---- Apple ----
  'F0B479': 'Apple',
  'F0C1F1': 'Apple',
  'F0CBA1': 'Apple',
  'F0DBE2': 'Apple',
  'F0DBF8': 'Apple',
  'F0DCE2': 'Apple',

  // ---- TP-Link ----
  'F0F336': 'TP-Link',

  // ---- Apple ----
  'F0F61C': 'Apple',

  // ---- Samsung ----
  'F409D8': 'Samsung',

  // ---- Apple ----
  'F437B7': 'Apple',

  // ---- Huawei ----
  'F44C7F': 'Huawei',

  // ---- Apple ----
  'F45C89': 'Apple',

  // ---- Xiaomi ----
  'F48B32': 'Xiaomi',

  // ---- Samsung ----
  'F49F54': 'Samsung',

  // ---- Huawei ----
  'F49FF3': 'Huawei',

  // ---- Xiaomi（智能家居） ----
  'F4CFA2': 'Xiaomi（智能家居）',

  // ---- TP-Link ----
  'F4EC38': 'TP-Link',

  // ---- Apple ----
  'F4F15A': 'Apple',

  // ---- TP-Link ----
  'F4F26D': 'TP-Link',

  // ---- Google（Chromecast） ----
  'F4F5D8': 'Google（Chromecast）',

  // ---- Apple ----
  'F4F951': 'Apple',

  // ---- Samsung ----
  'F8042E': 'Samsung',

  // ---- TP-Link ----
  'F81A67': 'TP-Link',

  // ---- Apple ----
  'F81EDF': 'Apple',
  'F82793': 'Apple',

  // ---- Huawei ----
  'F83DFF': 'Huawei',

  // ---- Intel ----
  'F8633F': 'Intel',

  // ---- Netgear ----
  'F87394': 'Netgear',

  // ---- Apple ----
  'F895EA': 'Apple',

  // ---- Xiaomi ----
  'F8A45F': 'Xiaomi',

  // ---- TP-Link ----
  'F8D111': 'TP-Link',

  // ---- Sony ----
  'FC0FE6': 'Sony',

  // ---- Apple ----
  'FC253F': 'Apple',

  // ---- Huawei ----
  'FC48EF': 'Huawei',

  // ---- Xiaomi ----
  'FC64BA': 'Xiaomi',

  // ---- D-Link ----
  'FC7516': 'D-Link',

  // ---- Samsung ----
  'FCC734': 'Samsung',

  // ---- TP-Link ----
  'FCD733': 'TP-Link',

  // ---- Huawei ----
  'FCE33C': 'Huawei',

  // ---- Apple ----
  'FCE998': 'Apple',
  'FCFC48': 'Apple',
};
