# -*- coding: utf-8 -*-
"""
DeepSeek KaTeX / CSS / LaTeX 渲染器
在本地 WebView2 窗口中打开 chat.deepseek.com，并向页面注入 KaTeX + 渲染脚本，
使对话中的 LaTeX 公式、CSS 代码块能够正确渲染显示。

构建：pyinstaller --onefile --windowed ...（见 README）
"""
import os
import sys
import threading
import time

import webview

APP_NAME = "DeepSeek KaTeX 渲染器"
TARGET_URL = "https://chat.deepseek.com/"


def resource_path(rel):
    """兼容 PyInstaller 单文件打包后的资源路径。"""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


def _read(rel):
    with open(resource_path(rel), "r", encoding="utf-8") as f:
        return f.read()


# 固定 WebView2 用户数据目录，保证登录状态跨会话持久化
def _ensure_user_data_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    d = os.path.join(base, "DeepSeekKaTeX", "WebView2")
    os.makedirs(d, exist_ok=True)
    os.environ.setdefault("WEBVIEW2_USER_DATA_FOLDER", d)


_ensure_user_data_dir()

KATEX_JS = _read("assets/katex.min.js")
KATEX_CSS = _read("assets/katex.selfcontained.css")
RENDERER_JS = _read("assets/renderer.js")

# KaTeX 对 \text{中文} 会输出 .cjk_fallback 类，补充中文字体回退，保证公式里的中文正常显示
CJK_FALLBACK_CSS = (
    '.katex .cjk_fallback{font-family:"Microsoft YaHei","PingFang SC",'
    '"Noto Sans CJK SC","Source Han Sans SC","SimSun",sans-serif;}'
)
KATEX_CSS += CJK_FALLBACK_CSS

_window = None
_inject_lock = threading.Lock()

# 日志写入固定位置，便于无控制台模式下排查
_LOG_PATH = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "DeepSeekKaTeX", "log.txt",
)


def _log(msg):
    try:
        with open(_LOG_PATH, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:  # noqa: BLE001
        pass


def _reset_log():
    try:
        os.makedirs(os.path.dirname(_LOG_PATH), exist_ok=True)
        with open(_LOG_PATH, "w", encoding="utf-8") as f:
            f.write("[%s] DeepSeek KaTeX 渲染器启动\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
    except Exception:  # noqa: BLE001
        pass


def _inject():
    global _window
    w = _window
    if w is None:
        return
    with _inject_lock:
        try:
            if not w.evaluate_js("!!window.katex"):
                w.evaluate_js(KATEX_JS)
            w.load_css(KATEX_CSS)
            w.evaluate_js(RENDERER_JS)
            _log("注入完成（KaTeX + CSS + 渲染器）")
        except Exception as e:  # noqa: BLE001
            _log("注入失败：" + repr(e))


def _inject_delayed(delay=0.6):
    time.sleep(delay)
    _inject()


def on_loaded():
    # 从后台线程注入，避免在 loaded 回调（UI 线程）内等待主循环造成死锁
    threading.Thread(target=_inject_delayed, daemon=True).start()


def _watchdog():
    """兜底：若 SPA 整页替换导致渲染器丢失，自动重新注入。"""
    while True:
        time.sleep(5)
        try:
            w = _window
            if w is None:
                continue
            ok = w.evaluate_js("!!(window.__dkxReady && window.katex)")
            if not ok:
                _inject()
        except Exception:  # noqa: BLE001
            pass


def main():
    global _window
    _reset_log()
    _log("目标地址：" + TARGET_URL)
    _window = webview.create_window(
        APP_NAME,
        url=TARGET_URL,
        width=1280,
        height=860,
        min_size=(940, 600),
        text_select=True,
    )
    _window.events.loaded += on_loaded
    threading.Thread(target=_watchdog, daemon=True).start()
    _log("窗口已创建，开始运行")
    webview.start(debug=False)


if __name__ == "__main__":
    main()
