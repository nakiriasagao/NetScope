package com.netscope.app;

import android.app.Application;
import android.os.Build;

import com.netscope.app.core.Env;

/**
 * 应用入口：把 Android 环境信息注入核心层
 *
 * core/ 下的类刻意不依赖任何 Android API（便于在桌面 JVM 上验证），
 * 因此需要在这里做一次桥接。
 */
public class NetScopeApp extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        Env.setInfo(new Env.Info() {
            @Override
            public String platformName() {
                return "Android";
            }

            @Override
            public String platformVersion() {
                return Build.VERSION.RELEASE == null ? "?" : Build.VERSION.RELEASE;
            }

            @Override
            public String model() {
                String brand = Build.BRAND == null ? "" : Build.BRAND;
                String model = Build.MODEL == null ? "" : Build.MODEL;
                return (brand + " " + model).trim();
            }

            @Override
            public String primaryAbi() {
                String[] abis = Build.SUPPORTED_ABIS;
                return abis != null && abis.length > 0 ? abis[0] : "unknown";
            }
        });
    }
}
