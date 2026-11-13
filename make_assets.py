import base64
import os
import re
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "package", "dist")
DST = os.path.join(HERE, "DeepSeekKaTeX", "assets")

os.makedirs(DST, exist_ok=True)
os.makedirs(os.path.join(DST, "fonts"), exist_ok=True)

# 1) 拷贝 katex.min.js
shutil.copyfile(os.path.join(SRC, "katex.min.js"), os.path.join(DST, "katex.min.js"))

# 2) 生成自包含 CSS：字体 base64 内嵌，去掉 woff/ttf 回退，只保留 woff2
css = open(os.path.join(SRC, "katex.min.css"), "r", encoding="utf-8").read()

font_dir = os.path.join(SRC, "fonts")


def repl_woff2(m):
    name = m.group(1)
    path = os.path.join(font_dir, name)
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return 'url(data:font/woff2;base64,%s)' % b64


css = re.sub(r'url\(fonts/([A-Za-z0-9_-]+\.woff2)\)', repl_woff2, css)
# 删除剩余的 woff/ttf 回退引用
css = re.sub(r',url\(fonts/[^)]*\) format\("[^"]*"\)', '', css)

out_css = os.path.join(DST, "katex.selfcontained.css")
with open(out_css, "w", encoding="utf-8") as f:
    f.write(css)

print("katex.min.js ->", os.path.getsize(os.path.join(DST, "katex.min.js")), "bytes")
print("katex.selfcontained.css ->", os.path.getsize(out_css), "bytes")
# 校验不再有未内嵌的 fonts/ 引用
leftover = re.findall(r'url\(fonts/', css)
print("remaining url(fonts/ refs:", len(leftover))
