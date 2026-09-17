package com.netscope.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 设置页：配置 NetScope 服务地址
 *
 * 完全用代码构建界面，避免引入 AppCompat / Material 依赖，
 * 从而让 APK 保持极小且不需要额外的支持库。
 */
public class SettingsActivity extends Activity {

    private EditText input;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("NetScope 设置");

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0B1220);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(40, 40, 40, 40);
        scroll.addView(root);

        root.addView(label("NetScope 服务地址", 17, 0xFFDBE9FF, 0));
        root.addView(label("填写运行 NetScope 的电脑地址，例如 http://192.168.1.5:8787\n"
                + "（电脑上启动 NetScope 后，窗口里显示的“访问地址”就是它）", 13, 0xFF8FA7C7, 8));

        SharedPreferences sp = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
        input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(sp.getString(MainActivity.KEY_SERVER, MainActivity.DEFAULT_SERVER));
        input.setTextColor(0xFFDBE9FF);
        input.setHintTextColor(0xFF5B6B85);
        input.setHint("http://192.168.1.5:8787");
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputParams.topMargin = 20;
        input.setLayoutParams(inputParams);
        root.addView(input);

        root.addView(button("保存", 24, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                save();
            }
        }));

        root.addView(label("常用地址", 15, 0xFF8FA7C7, 32));
        root.addView(button("Android 模拟器访问本机（10.0.2.2）", 8, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                input.setText("http://10.0.2.2:8787");
            }
        }));
        root.addView(button("本机（手机自己跑服务）", 8, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                input.setText("http://127.0.0.1:8787");
            }
        }));

        root.addView(label("提示", 15, 0xFF8FA7C7, 32));
        root.addView(label("· 手机与电脑需要连同一个 Wi-Fi；\n"
                + "· 电脑上启动时若只监听 127.0.0.1，手机将无法访问，"
                + "需要用 netscope.exe --host 0.0.0.0 启动；\n"
                + "· 若电脑开了防火墙，请允许该端口（默认 8787）的入站连接。", 13, 0xFF8FA7C7, 8));

        setContentView(scroll);
    }

    private TextView label(String text, int sp, int color, int topMargin) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(sp);
        tv.setTextColor(color);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = topMargin;
        tv.setLayoutParams(p);
        return tv;
    }

    private Button button(String text, int topMargin, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.topMargin = topMargin;
        b.setLayoutParams(p);
        b.setOnClickListener(listener);
        return b;
    }

    private void save() {
        String raw = input.getText().toString().trim();
        if (raw.isEmpty()) {
            Toast.makeText(this, "请填写服务地址", Toast.LENGTH_SHORT).show();
            return;
        }
        if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
            raw = "http://" + raw;
        }
        // 补默认端口，减少用户输错的机会
        String withoutScheme = raw.substring(raw.indexOf("://") + 3);
        if (withoutScheme.indexOf(':') < 0 && withoutScheme.indexOf('/') < 0) {
            raw = raw + ":8787";
        }
        SharedPreferences sp = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
        sp.edit().putString(MainActivity.KEY_SERVER, raw).apply();
        Toast.makeText(this, "已保存：" + raw, Toast.LENGTH_SHORT).show();
        finish();
    }
}
