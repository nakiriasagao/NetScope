package com.netscope.app;

import android.content.Context;
import android.content.res.AssetManager;

import com.netscope.app.core.NetHttpd;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 静态资源提供者：从 APK 的 assets/web/ 读取前端页面
 *
 * 手机端把整个 public/ 目录打包进 assets/web/，
 * 因此 WebView 加载 http://127.0.0.1:port/ 时拿到的就是与桌面版**完全一致**的界面。
 *
 * 注意：多线程并发读取 AssetManager 是安全的（Android 文档明确支持）。
 */
public class AssetsProvider implements NetHttpd.AssetProvider {

    private final AssetManager assets;
    private final String prefix;

    public AssetsProvider(Context context) {
        this(context.getAssets(), "web/");
    }

    public AssetsProvider(AssetManager assets, String prefix) {
        this.assets = assets;
        this.prefix = prefix == null ? "" : prefix;
    }

    @Override
    public byte[] read(String path) {
        InputStream in = null;
        try {
            in = assets.open(prefix + path);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } catch (Exception e) {
            return null;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    /* ignore */
                }
            }
        }
    }

    @Override
    public boolean exists(String path) {
        InputStream in = null;
        try {
            in = assets.open(prefix + path);
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    /* ignore */
                }
            }
        }
    }
}
