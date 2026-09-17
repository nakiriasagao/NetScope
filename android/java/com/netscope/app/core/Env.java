package com.netscope.app.core;

/**
 * 运行时环境信息（把 Android 相关调用集中到一处）
 *
 * 这样 NetApi / LocalNet / Probe 等核心类都能保持**纯 Java**，
 * 既便于在桌面 JVM 上做单元验证，也让核心逻辑与 UI 解耦。
 */
public final class Env {

    private Env() {
    }

    /** 由 Android 侧在 Application.onCreate 里注入真实实现 */
    public interface Info {
        String platformName();

        String platformVersion();

        String model();

        String primaryAbi();
    }

    private static Info info = new Info() {
        @Override
        public String platformName() {
            return System.getProperty("os.name", "unknown");
        }

        @Override
        public String platformVersion() {
            return System.getProperty("os.version", "");
        }

        @Override
        public String model() {
            return "desktop-jvm";
        }

        @Override
        public String primaryAbi() {
            return System.getProperty("os.arch", "unknown");
        }
    };

    public static void setInfo(Info impl) {
        if (impl != null) info = impl;
    }

    public static String platform() {
        return info.platformName() + " " + info.platformVersion();
    }

    public static String model() {
        return info.model();
    }

    public static String arch() {
        return info.primaryAbi();
    }

    public static boolean isAndroid() {
        return "Android".equalsIgnoreCase(info.platformName());
    }
}
