/*
 * DeepSeek KaTeX / CSS / LaTeX 渲染器
 * 运行在 chat.deepseek.com 页面上下文中（由宿主注入）。
 * 功能：
 *   1. 识别并渲染 LaTeX 数学公式：$..$ \(..\) $$..$$ \[..\] \begin{..}\end{..}
 *   2. 提取回复中的 CSS 代码块（```css / language-css）并应用为 <style>
 *   3. 将 ```math / ```latex / ```tex 代码块渲染为显示公式
 *   4. 将 ```text / 纯文本 / 未知语言 代码块中的数学公式一并渲染
 *   5. 将行内 code（如 `$x$`）中纯数学表达式渲染
 *   6. 预处理 KaTeX 不支持的命令（\scalebox/\rotatebox/\multicolumn/\hfill/@{} 等）
 *   7. MutationObserver 持续监听流式输出
 */
(function () {
  "use strict";
  if (window.__dkxReady) {
    if (window.__dkxRender) window.__dkxRender();
    return;
  }
  window.__dkxReady = true;

  const katex = window.katex;
  if (!katex) return;

  // ---------- 工具 ----------
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  // ================= LaTeX 预处理（转换 KaTeX 不支持的命令） =================
  function readGroup(tex, start) {
    let i = start;
    while (i < tex.length && /\s/.test(tex[i])) i++;
    if (tex[i] !== "{") return null;
    let depth = 0;
    for (let j = i; j < tex.length; j++) {
      if (tex[j] === "{") depth++;
      else if (tex[j] === "}") { depth--; if (depth === 0) return { content: tex.slice(i + 1, j), end: j + 1 }; }
    }
    return null;
  }

  function isWordChar(c) { return !!c && /[a-zA-Z]/.test(c); }

  // \cmd{arg1}...{argN} → replacer(args)（按左到右，配合循环处理嵌套）
  function replaceArgs(tex, cmdName, argCount, replacer) {
    const marker = "\\" + cmdName;
    let result = "";
    let i = 0;
    while (i < tex.length) {
      const idx = tex.indexOf(marker, i);
      if (idx === -1) { result += tex.slice(i); break; }
      if (isWordChar(tex[idx - 1])) { result += tex.slice(i, idx + marker.length); i = idx + marker.length; continue; }
      result += tex.slice(i, idx);
      let j = idx + marker.length;
      const args = [];
      let ok = true;
      for (let k = 0; k < argCount; k++) {
        const g = readGroup(tex, j);
        if (!g) { ok = false; break; }
        args.push(g.content);
        j = g.end;
      }
      if (!ok) { result += marker; i = idx + marker.length; continue; }
      result += replacer(args);
      i = j;
    }
    return result;
  }

  // \rotatebox[origin=c]{angle}{content} → content（去掉可选参数与旋转）
  function replaceRotatebox(tex) {
    const marker = "\\rotatebox";
    let result = "";
    let i = 0;
    while (i < tex.length) {
      const idx = tex.indexOf(marker, i);
      if (idx === -1) { result += tex.slice(i); break; }
      if (isWordChar(tex[idx - 1])) { result += tex.slice(i, idx + marker.length); i = idx + marker.length; continue; }
      result += tex.slice(i, idx);
      let j = idx + marker.length;
      let k = j;
      while (k < tex.length && /\s/.test(tex[k])) k++;
      if (tex[k] === "[") {
        let d = 1, m = k + 1;
        while (m < tex.length && d > 0) { if (tex[m] === "[") d++; else if (tex[m] === "]") d--; m++; }
        j = m;
      }
      const g1 = readGroup(tex, j);
      if (!g1) { result += marker; i = idx + marker.length; continue; }
      const g2 = readGroup(tex, g1.end);
      if (!g2) { result += marker; i = idx + marker.length; continue; }
      result += g2.content;
      i = g2.end;
    }
    return result;
  }

  function preprocessLatex(tex) {
    // 探测面板宽度锚点 \rule{Xem}{0pt}
    let widthEm = 18;
    const wm = tex.match(/\\rule\{(\d+(?:\.\d+)?)em\}\{0pt\}/);
    if (wm) widthEm = parseFloat(wm[1]);

    // 非嵌套类替换
    tex = tex.replace(/@\{\}/g, "");
    tex = tex.replace(/@\{[^{}]*\}/g, "");
    tex = tex.replace(/\\hfill/g, "\\hspace{2em}");
    tex = tex.replace(/\\hfil\b/g, "\\hspace{2em}");
    tex = tex.replace(/\\＜/g, "＜");

    // 嵌套类命令：循环处理直到稳定（外层剥掉后可能露出内层同名命令）
    for (let iter = 0; iter < 20; iter++) {
      const before = tex;
      // \multicolumn{N}{align}{content} → htmlStyle 对齐（KaTeX 不支持 multicolumn）
      tex = replaceArgs(tex, "multicolumn", 3, function (args) {
        const align = args[1].trim();
        const content = args[2];
        if (align === "r") return "\\htmlStyle{display:inline-block;width:" + widthEm + "em;text-align:right;}{" + content + "}";
        if (align === "c") return "\\htmlStyle{display:inline-block;width:" + widthEm + "em;text-align:center;}{" + content + "}";
        return content;
      });
      // \scalebox{factor}{content} → content（丢弃缩放）
      tex = replaceArgs(tex, "scalebox", 2, function (args) { return args[1]; });
      // \rotatebox[opt]{angle}{content} → content（丢弃旋转）
      tex = replaceRotatebox(tex);
      // \colorbox{color}{content}（文本模式）→ \htmlStyle{background-color}（数学模式）
      tex = replaceArgs(tex, "colorbox", 2, function (args) {
        return "\\htmlStyle{background-color:" + args[0].trim() + ";}{" + args[1] + "}";
      });
      // \fcolorbox{frame}{bg}{content}
      tex = replaceArgs(tex, "fcolorbox", 3, function (args) {
        return "\\htmlStyle{background-color:" + args[1].trim() + ";border:1px solid " + args[0].trim() + ";}{" + args[2] + "}";
      });
      // \raisebox{dim}{content}（文本模式）→ \htmlStyle{position:relative;top}（数学模式）
      tex = replaceArgs(tex, "raisebox", 2, function (args) {
        const dim = args[0].trim();
        const neg = dim.charAt(0) === "-" ? dim.slice(1) : "-" + dim;
        return "\\htmlStyle{position:relative;top:" + neg + ";display:inline-block;}{" + args[1] + "}";
      });
      // MathJax 的 CSS 挂钩命令 → KaTeX 等价命令；保留 id/class，用户 CSS 可直接命中
      tex = replaceArgs(tex, "cssId", 2, function (args) {
        return "\\htmlId{" + args[0].trim() + "}{" + args[1] + "}";
      });
      tex = replaceArgs(tex, "cssClass", 2, function (args) {
        return "\\htmlClass{" + args[0].trim() + "}{" + args[1] + "}";
      });
      tex = replaceArgs(tex, "class", 2, function (args) {
        return "\\htmlClass{" + args[0].trim() + "}{" + args[1] + "}";
      });
      tex = replaceArgs(tex, "style", 2, function (args) {
        return "\\htmlStyle{" + args[0].trim() + "}{" + args[1] + "}";
      });
      if (tex === before) break;
    }

    return tex;
  }

  // 仅放行 KaTeX 的 HTML 属性类命令（\cssId→\htmlId 等需要），不放行 \href / \includegraphics
  const TRUST_FN = function (context) {
    const c = context.command;
    return c === "\\htmlStyle" || c === "\\htmlClass" || c === "\\htmlId" || c === "\\htmlData";
  };

  function renderTex(tex, display) {
    let t = String(tex || "").trim();
    if (!t) return null;
    let disp = display;
    // 剥离外层分隔符（KaTeX 不支持 \[ \] 与 \( \)，内部用 $$ / $）
    if (t.slice(0, 2) === "\\[" && t.slice(-2) === "\\]") { t = t.slice(2, -2).trim(); disp = true; }
    else if (t.slice(0, 2) === "\\(" && t.slice(-2) === "\\)") { t = t.slice(2, -2).trim(); disp = false; }
    else if (t.slice(0, 2) === "$$" && t.slice(-2) === "$$") { t = t.slice(2, -2).trim(); disp = true; }
    // 整段被单个 $...$ 包裹（常见于「把多行面板塞进行内公式」）→ 剥离首尾 $，
    // 否则 KaTeX 会报 "Can't use function '$' in math mode"
    else if (t.length >= 2 && t.charAt(0) === "$" && t.charAt(t.length - 1) === "$" && t.charAt(1) !== "$") {
      t = t.slice(1, -1).trim();
    }
    // 预处理不支持的命令
    t = preprocessLatex(t);
    try {
      const html = katex.renderToString(t, {
        displayMode: disp,
        throwOnError: false,
        strict: false,
        trust: TRUST_FN,
      });
      // KaTeX 解析失败会回显红色源码，此时判定为失败，交给上层重试/保持原样
      if (html && (html.indexOf("katex-error") >= 0 || /color:#cc0000/.test(html))) return null;
      return html;
    } catch (e) {
      return null;
    }
  }

  // 判断一段文本是否是「用 LaTeX 拼出来的整块面板」（含嵌套 array，绝不能切碎）
  function isPanelLatex(text) {
    const t = text || "";
    if (t.length < 120) return false;
    if (t.indexOf("\\colorbox") < 0) return false;
    return /\\begin\{array/.test(t) || /\\multicolumn\{/.test(t) || /\\scalebox\{/.test(t);
  }

  // ---------- CSS 代码块提取与应用 ----------
  const appliedCSS = new Set();
  const cssByOwner = new WeakMap(); // 代码块/容器 → 对应 <style>，支持流式输出时持续更新

  function applyCSS(text, owner) {
    const t = (text || "").trim();
    if (!t) return false;
    const head = document.head || document.documentElement;
    if (owner) {
      let st = cssByOwner.get(owner);
      if (st) {
        if (st.textContent !== t) { st.textContent = t; return true; } // 流式补全后覆盖
        return false;
      }
      st = document.createElement("style");
      st.setAttribute("data-dkx-css", "");
      st.textContent = t;
      head.appendChild(st);
      cssByOwner.set(owner, st);
      return true;
    }
    const key = t.length + ":" + hashStr(t);
    if (appliedCSS.has(key)) return false;
    appliedCSS.add(key);
    const style = document.createElement("style");
    style.setAttribute("data-dkx-css", "");
    style.textContent = t;
    head.appendChild(style);
    return true;
  }

  // 判断一段文本是否是 CSS 规则（用于无围栏的裸 CSS / 混合块）
  function looksLikeCss(t) {
    if (!t || /\\(?:begin|colorbox|frac|text|rule|hspace|raisebox|scalebox|rotatebox|multicolumn)\b/.test(t)) return false;
    if (!/[.#a-zA-Z\[][^{}]*\{[^{}]*:[^{}]*\}/.test(t)) return false;
    return /(?:color|background|font|border|padding|margin|display|width|height|text-align|box-shadow|border-radius|opacity|transform|line-height|white-space|overflow)/i.test(t);
  }

  // 从一段文本中抽出 CSS（```css 围栏 / <style> 标签 / 裸 CSS 规则），返回剩余正文
  function extractCss(text) {
    let css = "";
    let rest = String(text || "");
    rest = rest.replace(/```(?:css|scss|less|sass|style)\b[ \t]*\r?\n([\s\S]*?)```/gi, function (m, c) { css += c + "\n"; return ""; });
    rest = rest.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, function (m, c) { css += c + "\n"; return ""; });
    // 裸 CSS 规则（逐行聚合，避免吃掉 LaTeX）
    if (!css) {
      const lines = rest.split(/\r?\n/);
      const kept = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (looksLikeCss(ln) && !/\\(?:begin|end|frac|text|colorbox)/.test(ln)) css += ln + "\n";
        else kept.push(ln);
      }
      if (css) rest = kept.join("\n");
    }
    return { css: css.trim(), rest: rest };
  }

  const KNOWN_LANGS = [
    "css", "scss", "less", "sass", "stylus",
    "latex", "tex", "math", "katex",
    "text", "plaintext", "txt", "plain",
    "python", "javascript", "typescript", "html", "json", "bash", "shell",
  ];

  // 从 <pre> 中识别语言标签（兼容 data-* 属性、大小写、纯 class 名）
  function detectLang(pre) {
    const code = pre.querySelector("code");
    const els = [pre, code].filter(Boolean);
    // 1) 直接读 data-language / data-lang 等属性值（很多站点不带 "language=" 前缀）
    for (let e = 0; e < els.length; e++) {
      const attrs = ["data-language", "data-lang", "data-code-language", "data-highlight", "data-type"]
        .map(function (a) { return els[e].getAttribute(a); })
        .filter(Boolean).join(" ");
      const found = attrs.toLowerCase().match(/\b([a-z+#.-]+)\b/);
      if (found && KNOWN_LANGS.indexOf(found[1]) >= 0) return found[1];
      if (found && /^(?:css|scss|less|sass|stylus)$/.test(found[1])) return found[1];
    }
    const hay = [
      (code && code.className) || "",
      (code && code.getAttribute("data-language")) || "",
      (code && code.getAttribute("data-lang")) || "",
      pre.className || "",
      pre.getAttribute("data-language") || "",
      pre.getAttribute("data-lang") || "",
    ].join(" ");
    let m = hay.match(/language-([A-Za-z0-9_+#.-]+)/i);
    if (m) return m[1].toLowerCase();
    m = hay.match(/(?:lang|language)[=:]\s*["']?([A-Za-z0-9_+#.-]+)/i);
    if (m) return m[1].toLowerCase();
    // class 名直接就是语言名（如 class="css"）
    m = hay.trim().toLowerCase().match(/(?:^|\s)(css|scss|less|latex|tex|math|katex|text|plaintext|txt)(?:\s|$)/);
    if (m) return m[1];
    // 语言标签可能出现在 pre 的某个小元素里（如 <span>text</span>）
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_ELEMENT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (n === code) continue;
      if (n.querySelector("code")) continue;
      const txt = (n.textContent || "").trim().toLowerCase();
      if (txt.length > 0 && txt.length <= 20 && /^[a-z0-9_+#.-]+$/.test(txt)) {
        return txt;
      }
    }
    return "";
  }

  // ---------- 数学解析 ----------
  const MATH_OPEN = /\$|\\\(|\\\[|\\begin\{/;
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA",
    "NOSCRIPT", "IFRAME", "SVG", "MATH", "SELECT",
  ]);

  function isInlineMoney(content) {
    // 规避 $5 / $1,000.50 这类货币误判
    return /^[0-9\s.,\-]*$/.test(content);
  }

  // 把文本按 LaTeX 分隔符拆成 [{type:'text'|'math', value, display}]
  function tokenize(s) {
    const out = [];
    let i = 0;
    const n = s.length;
    let buf = "";
    const pushText = function () {
      if (buf) { out.push({ type: "text", value: buf }); buf = ""; }
    };
    const esc = function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };

    while (i < n) {
      const rest = s.slice(i);

      // \begin{env} ... \end{env}（配对计数，兼容嵌套 array，避免把面板切碎）
      const mBegin = rest.match(/^\\begin\{([a-zA-Z*]+)\}/);
      if (mBegin) {
        const env = mBegin[1];
        const beginTok = "\\begin{" + env + "}";
        const endTok = "\\end{" + env + "}";
        let depth = 0, pos = 0, endAt = -1;
        while (pos < rest.length) {
          const bIdx = rest.indexOf(beginTok, pos);
          const eIdx = rest.indexOf(endTok, pos);
          if (eIdx === -1) break;
          if (bIdx !== -1 && bIdx < eIdx) { depth++; pos = bIdx + beginTok.length; }
          else { depth--; pos = eIdx + endTok.length; if (depth === 0) { endAt = pos; break; } }
        }
        if (endAt > 0) {
          pushText();
          out.push({ type: "math", value: rest.slice(0, endAt), display: true });
          i += endAt;
          continue;
        }
      }

      // $$ ... $$
      if (rest.startsWith("$$")) {
        const j = s.indexOf("$$", i + 2);
        if (j !== -1) {
          pushText();
          out.push({ type: "math", value: s.slice(i + 2, j), display: true });
          i = j + 2;
          continue;
        }
      }

      // \[ ... \]
      if (rest.startsWith("\\[")) {
        const j = s.indexOf("\\]", i + 2);
        if (j !== -1) {
          pushText();
          out.push({ type: "math", value: s.slice(i + 2, j), display: true });
          i = j + 2;
          continue;
        }
      }

      // \( ... \)
      if (rest.startsWith("\\(")) {
        const j = s.indexOf("\\)", i + 2);
        if (j !== -1) {
          pushText();
          out.push({ type: "math", value: s.slice(i + 2, j), display: false });
          i = j + 2;
          continue;
        }
      }

      // $ ... $ 单行内联
      if (rest.startsWith("$")) {
        const nxt = s[i + 1];
        if (nxt && nxt !== " " && nxt !== "\n" && nxt !== "$") {
          let j = i + 1;
          let found = -1;
          while (j < n) {
            if (s[j] === "\n") break;
            if (s[j] === "$" && s[j - 1] !== " " && s[j - 1] !== "\\") {
              found = j; break;
            }
            j++;
          }
          if (found !== -1 && found > i + 1) {
            const inner = s.slice(i + 1, found);
            if (!isInlineMoney(inner)) {
              pushText();
              out.push({ type: "math", value: inner, display: false });
              i = found + 1;
              continue;
            }
          }
        }
      }

      buf += s[i];
      i++;
    }
    pushText();
    return out;
  }

  // 把一段文本渲染成「文本节点 + 数学元素」的片段
  function renderMixedContent(text) {
    const frag = document.createDocumentFragment();
    // 整块 LaTeX 面板：必须整体渲染，绝不能按分隔符切碎
    if (isPanelLatex(text)) {
      const panelHtml = renderTex(text, true);
      if (panelHtml) {
        const p = document.createElement("div");
        p.setAttribute("data-dkx-math", "");
        p.style.display = "block";
        p.style.overflowX = "auto";
        p.innerHTML = panelHtml;
        frag.appendChild(p);
        return { frag: frag, hasMath: true };
      }
      // 尚未完整（流式输出中）或解析失败：保持原样，等面板级重试
      frag.appendChild(document.createTextNode(text));
      return { frag: frag, hasMath: false };
    }
    const parts = tokenize(text);
    let hasMath = false;
    for (let k = 0; k < parts.length; k++) {
      const p = parts[k];
      if (p.type === "text") {
        frag.appendChild(document.createTextNode(p.value));
      } else {
        const html = renderTex(p.value, p.display);
        if (html) {
          hasMath = true;
          const wrap = document.createElement(p.display ? "div" : "span");
          wrap.setAttribute("data-dkx-math", ""); wrap.className = "dkx-math";
          if (p.display) wrap.style.display = "block";
          wrap.innerHTML = html;
          frag.appendChild(wrap);
        } else {
          frag.appendChild(document.createTextNode(p.value));
        }
      }
    }
    return { frag: frag, hasMath: hasMath };
  }

  function renderTextNode(textNode) {
    const s = textNode.nodeValue;
    if (!s || !MATH_OPEN.test(s)) return;
    const { frag, hasMath } = renderMixedContent(s);
    if (!hasMath) return;
    const parent = textNode.parentNode;
    if (!parent) return;
    try { parent.replaceChild(frag, textNode); } catch (e) { /* ignore */ }
  }

  function scanMath(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !MATH_OPEN.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        // 属于 LaTeX 面板的文本节点交给 scanPanels 整体渲染，避免逐节点切碎
        const cont = node.parentElement ? node.parentElement.closest("div,p,pre,article,section,li,td") : null;
        if (cont && isPanelLatex(cont.textContent || "")) return NodeFilter.FILTER_REJECT;
        let p = node.parentElement;
        while (p) {
          const tag = p.tagName;
          if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
          if (p.hasAttribute && (p.hasAttribute("data-dkx-math") ||
              p.hasAttribute("data-dkx-math-block") ||
              p.hasAttribute("data-dkx-code-math") ||
              p.hasAttribute("data-dkx-css"))) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (let k = 0; k < nodes.length; k++) {
      if (nodes[k].parentNode) renderTextNode(nodes[k]);
    }
  }

  // 需要保留为纯代码的语言（不渲染其中的数学，避免破坏代码）
  const CODE_LANGS = new Set([
    "css", "scss", "less", "sass", "stylus",
    "html", "xml", "svg", "vue", "svelte", "markdown", "md",
    "javascript", "js", "jsx", "typescript", "ts", "tsx",
    "python", "py", "java", "c", "cpp", "c++", "csharp", "cs",
    "go", "golang", "rust", "rs", "php", "ruby", "rb", "perl",
    "swift", "kotlin", "scala", "dart", "r", "matlab", "objectivec",
    "shell", "bash", "sh", "zsh", "powershell", "ps1", "cmd", "bat",
    "sql", "json", "yaml", "yml", "toml", "ini", "diff",
    "dockerfile", "makefile", "graphql", "protobuf", "regex", "nginx",
  ]);

  const MATH_BLOCK_LANGS = new Set(["math", "latex", "tex", "katex"]);
  const CSS_LANGS = new Set(["css", "scss", "less"]);

  // 处理代码块：CSS 应用 / 公式渲染 / 文本块内数学
  const seenCodeBlocks = new WeakSet();

  function scanCodeBlocks(root) {
    if (!root.querySelectorAll) return;
    const pres = root.querySelectorAll("pre");
    for (let i = 0; i < pres.length; i++) {
      const pre = pres[i];
      const lang0 = detectLang(pre);
      const isCssBlock = CSS_LANGS.has(lang0);
      // 纯 CSS 块不进去重集合：流式输出时每轮刷新 <style>，避免半截 CSS 定格
      if (seenCodeBlocks.has(pre) && !isCssBlock) continue;
      if (!isCssBlock) seenCodeBlocks.add(pre);
      const lang = lang0;
      const code = pre.querySelector("code");
      const rawText = (code ? code.textContent : pre.textContent) || "";
      let text = rawText;

      // 0) CSS 与 LaTeX 混排在同一块：先抽出 CSS 应用，剩余部分继续渲染公式
      if (!CSS_LANGS.has(lang)) {
        const parts = extractCss(rawText);
        if (parts.css) {
          applyCSS(parts.css, pre);
          pre.setAttribute("data-dkx-applied", "css");
          text = parts.rest.trim();
          if (!text) continue;
        }
      }

      // 1) 纯 CSS 代码块 → 应用为样式（owner 关联，流式补全时自动更新）
      if (CSS_LANGS.has(lang)) {
        if (applyCSS(rawText, pre)) pre.setAttribute("data-dkx-applied", "css");
        continue;
      }

      // 2) math/latex/tex 代码块 → 整个作为显示公式
      if (MATH_BLOCK_LANGS.has(lang)) {
        const t = text.trim();
        if (!t || /\\documentclass|\\begin\{document\}/.test(t)) continue;
        const html = renderTex(t, true);
        if (html) {
          const wrap = document.createElement("div");
          wrap.setAttribute("data-dkx-math-block", ""); wrap.className = "dkx-math dkx-math-block";
          wrap.style.display = "block";
          wrap.style.overflowX = "auto";
          wrap.innerHTML = html;
          if (pre.parentNode) pre.parentNode.replaceChild(wrap, pre);
        } else {
          seenCodeBlocks.delete(pre); // 流式未结束，下次重试
        }
        continue;
      }

      // 3) 已知编程语言 → 保留纯代码，不动
      if (CODE_LANGS.has(lang)) continue;

      // 4) text / 纯文本 / 未知语言 → 整块 LaTeX 面板优先整体渲染
      if (isPanelLatex(text)) {
        const panelHtml = renderTex(text, true);
        if (panelHtml) {
          const wrap = document.createElement("div");
          wrap.setAttribute("data-dkx-math-panel", ""); wrap.className = "dkx-panel";
          wrap.style.overflowX = "auto";
          wrap.innerHTML = panelHtml;
          if (pre.parentNode) pre.parentNode.replaceChild(wrap, pre);
        } else {
          seenCodeBlocks.delete(pre); // 下次重试
        }
        continue;
      }

      if (MATH_OPEN.test(text)) {
        const { frag, hasMath } = renderMixedContent(text);
        if (hasMath) {
          const wrap = document.createElement("div");
          wrap.setAttribute("data-dkx-code-math", ""); wrap.className = "dkx-math dkx-code-math";
          wrap.style.whiteSpace = "pre-wrap";
          wrap.style.overflowX = "auto";
          wrap.appendChild(frag);
          if (pre.parentNode) pre.parentNode.replaceChild(wrap, pre);
        }
      }
    }
  }

  // 行内 code 中的纯数学表达式（如 `$x$`）
  const seenInlineCode = new WeakSet();
  function scanInlineCode(root) {
    if (!root.querySelectorAll) return;
    const codes = root.querySelectorAll("code");
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (seenInlineCode.has(code)) continue;
      seenInlineCode.add(code);
      if (code.closest("pre")) continue; // 代码块已在 scanCodeBlocks 处理
      const t = (code.textContent || "").trim();
      if (!t || !MATH_OPEN.test(t)) continue;
      // 仅当整体是一个数学表达式时渲染，避免破坏普通行内代码
      if (/^\$[^$\n]+\$$/.test(t) || /^\\\(.*\\\)$/.test(t) || /^\\\[[\s\S]*\\\]$/.test(t) || /^\\begin\{[\s\S]*\\end\{[a-zA-Z*]+\}$/.test(t)) {
        const display = /^\$\$|^\\\[|^\\begin/.test(t);
        const inner = t.replace(/^\$\$?|\$\$?$/g, "").replace(/^\\\[|\\\]$/g, "").replace(/^\\\(|\\\)$/g, "");
        const html = renderTex(inner, display);
        if (html) {
          const wrap = document.createElement(display ? "div" : "span");
          wrap.setAttribute("data-dkx-math", ""); wrap.className = "dkx-math";
          if (display) wrap.style.display = "block";
          wrap.innerHTML = html;
          if (code.parentNode) code.parentNode.replaceChild(wrap, code);
        }
      }
    }
  }

  // ---------- 整块 LaTeX 面板（正文裸文本 / 跨多个文本节点） ----------
  const seenPanels = new WeakSet();

  function scanPanels(root) {
    if (!root.querySelectorAll) return;
    const all = root.querySelectorAll("div, p, pre, section, article, li, td");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (seenPanels.has(el)) continue;
      if (el.hasAttribute && el.hasAttribute("data-dkx-math-panel")) { seenPanels.add(el); continue; }
      let txt = el.textContent || "";
      // 同一容器里若带 CSS 代码块：抽出 CSS、并从 LaTeX 文本中剔除，避免污染；DOM 保留
      const cssPres = [];
      const pres = el.querySelectorAll("pre");
      for (let q = 0; q < pres.length; q++) {
        const p = pres[q];
        if (CSS_LANGS.has(detectLang(p)) || p.hasAttribute("data-dkx-applied")) {
          cssPres.push(p);
          const ct = p.textContent || "";
          if (ct) txt = txt.split(ct).join("");
        }
      }
      const ext = extractCss(txt);
      if (ext.css) { applyCSS(ext.css, el); txt = ext.rest; }
      if (!isPanelLatex(txt)) continue;
      // 只处理最内层满足条件的容器，避免把整个消息列表一起替换
      let hasInnerPanel = false;
      for (let j = 0; j < el.children.length; j++) {
        if (isPanelLatex(el.children[j].textContent || "")) { hasInnerPanel = true; break; }
      }
      if (hasInnerPanel) continue;
      // 整体渲染（流式输出未结束时可能失败，不标记，留待下次重试）
      const html = renderTex(txt, true);
      if (!html) continue;
      seenPanels.add(el);
      const box = document.createElement("div");
      box.setAttribute("data-dkx-math-panel", "");
      box.className = "dkx-panel";
      box.style.overflowX = "auto";
      box.innerHTML = html;
      el.replaceChildren(box);
      // CSS 代码块放回容器，样式与公式互不干扰
      for (let q = 0; q < cssPres.length; q++) el.insertBefore(cssPres[q], box);
    }
  }

  // ---------- 全量扫描 ----------
  function run() {
    if (!document.body) return;
    scanCodeBlocks(document.body);
    // 页面存在 LaTeX 面板源码时才做容器级扫描
    if ((document.body.textContent || "").indexOf("\\colorbox") >= 0) scanPanels(document.body);
    scanInlineCode(document.body);
    scanMath(document.body);
  }

  window.__dkxRender = run;

  // 兜底轮询：流式输出停止后不再有 DOM 变更，靠定时器触发重试；
  // 仅在页面仍存在未渲染的 LaTeX 面板源码时才全量扫描，长对话下几乎零开销
  setInterval(function () {
    if (!document.body) return;
    const txt = document.body.textContent || "";
    if (txt.indexOf("\\colorbox") >= 0 || txt.indexOf("\\begin{array") >= 0) run();
  }, 1500);

  // ---------- 监听 DOM 变化 ----------
  let timer = null;
  const observer = new MutationObserver(function () {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      run();
    }, 250);
  });

  function startObserve() {
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    run();
  }

  if (document.body) startObserve();
  else document.addEventListener("DOMContentLoaded", startObserve);
})();
