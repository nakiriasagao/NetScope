package com.netscope.app.core;

/**
 * 服务信息（把 NetApi 与具体的 HTTP 实现解耦）
 *
 * NetApi 只需要知道端口与运行时长，不需要依赖 NetHttpd 本身；
 * 这样既避免了循环依赖，也方便在桌面 JVM 上做单元验证。
 */
public interface ServerInfo {

    /** 实际监听端口 */
    int getPort();

    /** 已运行秒数 */
    long uptimeSec();

    /** 启动时间的 ISO 字符串 */
    String startedAtIso();
}
