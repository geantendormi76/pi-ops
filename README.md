# pi-ops — 让 pi 在 Windows 上不再当 Linux 用

仓库：https://github.com/geantendormi76/pi-ops ｜ 测试：`npm test`（26 条守卫 + 35 条工具）

pi 的 `bash` 工具在 Windows 上走的是 Git bash（MSYS2），而模型默认会输出 Linux 习惯的命令：
`sudo apt-get install`、`systemctl restart`、`python3`、`/home/user/...`。每一条都会失败一次，
再重试一次，再解释一次——这才是真正浪费 token 的地方。

`pi-ops` 是一个 pi 扩展包，用三层机制消掉这笔浪费：

| 层 | 机制 | 作用 |
| --- | --- | --- |
| 1. 事实注入 | `before_agent_start` → `<windows_environment>` 提示段 | 把本机**实测**出来的信息放进系统提示：Windows 版本、代码页 936(GBK)、bash 种类、pwsh 版本、哪些 CLI 存在/缺失/是假壳（如 python 的 Microsoft Store stub）、WSL 发行版 |
| 2. 执行前拦截 | `tool_call` → 命令守卫 | `apt/brew/systemctl/sudo/python3/xdg-open` 等命令**在执行前**被拦下，返回值直接给出替代方案；`sudo`、`xdg-open` 则被自动改写后放行 |
| 3. 廉价工具 | `win_env` + `read_many` + `read_pdf` + `read_docx` + `diff_files` | 一次调用回答"这机器有什么"；一次读多份文件；直接读 PDF/Word；直接给出 diff——不用 `cat`/转换/`diff` 管道 |

## 装了什么

```
C:/dev/pi-ops/
├── package.json          pi.extensions = ["./src/index.ts"]（jiti 直接跑 TS，无需构建）
├── src/index.ts          扩展入口：注册工具、挂事件、激活内置工具
├── src/probe.ts          一次性 PowerShell 探测 → HostFacts（约 1.1s，会话内缓存）
├── src/prompt.ts         把 HostFacts 渲染成提示段（规则随探测结果动态裁剪）
├── src/guard.ts          纯函数 inspectBash / inspectPowerShell（无 I/O，可单测）
├── src/tools/win-env.ts  win_env 工具
├── src/tools/read-many.ts read_many 工具
├── src/tools/pdf.ts       read_pdf 工具（薄壳）
├── src/tools/pdf-core.ts  pdftotext / pypdf 调用、页码解析与标注（无 SDK 依赖，可单测）
├── src/tools/docx.ts      read_docx 工具（薄壳）
├── src/tools/docx-core.ts 纯 JS 解 zip + WordprocessingML → 文本
├── src/tools/diff.ts      diff_files 工具（薄壳）
├── src/tools/diff-core.ts git diff 调用、HEAD 快照、hunk 统计
├── src/tools/exec.ts      execFile 封装（argv 数组，永不过 shell）
├── src/tools/text.ts      输出预算裁剪与乱码比例检测
├── test/guard.test.mjs   26 条守卫回归测试：node test/guard.test.mjs
├── test/tools.test.mjs   35 条工具测试：node test/tools.test.mjs
└── test/make-fixtures.mjs 生成 docx/pdf 二进制测试样本（无外部依赖）
```

## 安装 / 卸载

```bash
pi install git:github.com/geantendormi76/pi-ops@v0.3.0   # 任意机器（推荐，锁版本）
pi install git:github.com/geantendormi76/pi-ops          # 跟 main
pi install C:/dev/pi-ops                                # 本机开发副本（已在 settings.json 里）
pi list                                                  # 确认已加载
pi remove git:github.com/geantendormi76/pi-ops@v0.3.0
```

包本身已经是可发布形态（v0.3.0、MIT、`files` 白名单、`publishConfig.access=public`，`npm pack` 19 文件 / 31 kB），
只是**暂未发布到 npm**（`pi-ops` 这个名字在 registry 上还空着）：需要时先 `npm login`，再
`npm publish --access public`，之后 `pi install npm:pi-ops` 即可。

安装后自动激活 pi 已内置但默认关闭的 `powershell`、`grep`、`find`、`ls`（幂等，不会关闭任何工具）。

## 开关

| 环境变量 / 参数 | 效果 |
| --- | --- |
| `PI_OPS_GUARD=off` 或 `pi --no-win-guard` | 关闭命令守卫（提示段仍保留） |
| `PI_OPS_NO_ACTIVATE=1` | 不自动激活 powershell/grep/find/ls |
| `/winenv` 命令 | 重新探测并打印环境报告 |

守卫只拦"在这台机器上必然失败"的命令，不拦内容里出现关键词的命令：`rg -n "apt-get" src/`
和 `wsl -e bash -lc "apt-get update"` 都放行，而 `apt-get install` / `docker ps`（未安装）/ `cd /home/x`
会被拦下并给出替代写法。

## 文件工具（对应 dsh-ops 的 ops_read_* / ops_diff）

都只依赖**本机已经装好的东西**，仓库里没有任何二进制，也不联网下载。

| 工具 | 后端 | 不依赖 |
| --- | --- | --- |
| `read_pdf` | 优先 `pdftotext`（Xpdf 4.06，随 Git for Windows 自带，`/mingw64/bin/pdftotext`）；缺失时退回 `uv run --with pypdf` | 不需要自己装 poppler、不需要 Python 环境、不需要 OCR |
| `read_docx` | 纯 Node：自己解析 zip 中央目录 + `inflateRawSync` 解压 `word/document.xml`，再把 WordprocessingML 转文本 | 不需要 Word/LibreOffice，不需要 `unzip` |
| `read_table` | 纯 Node：BOM 判编码（UTF-8 / UTF-16LE / UTF-16BE）+ RFC 4180 解析（引号内换行、`""` 转义）+ 行分页 | 不需要 `iconv`、不需要 Excel，不会把 GBK 静默解成乱码 |
| `diff_files` | `git diff --no-index`，失败退回 `diff -u`；只传 `a` 时用 `git show HEAD:<file>` 取基线 | 不需要手写 `git diff` 管道 |
| `read_many` | 一次读多个文件，行号 + 共享字符预算，跳过二进制 | 不需要 `cat a; cat b; cat c` 串行往返 |

```
read_pdf   { path: "report.pdf", offset: 1, limit: 10 }          # 页码窗口，带“--- page N ---”标注与 nextOffset
read_pdf   { path: "report.pdf", pages: "1-8", layout: true }   # 也可以用显式页列表
read_docx  { path: "spec.docx", offset: 1, limit: 50 }           # 按段落块分页，表头给 nextOffset
read_docx  { path: "spec.docx", include_headers: true }          # 附加页眉/页脚
read_table { path: "data.csv", limit: 100 }                      # 自动判分隔符/编码，表头即列名
read_table { path: "data.tsv", offset: 201, limit: 100 }         # 续读下一页
read_many  { paths: ["src/a.ts", "src/b.ts"], start_line: 1, end_line: 80 }
diff_files { a: "src/guard.ts" }                                 # 工作区 vs HEAD，先给 hunk/± 统计再给 diff
diff_files { a: "a.ts", b: "b.ts", context: 5 }
diff_files { a: "src/x.ts", content: "<新内容>" }                 # 写入前预览：给 sha/行数变化 + 真实 diff
```

共同约定：输出有字符预算（默认 pdf/table 40k、diff 20k），超了会保留头尾并提示如何收窄；
失败信息本身是可执行的下一步（文件缺失 / 不是 docx / HEAD 里没有该文件 / 扫描件无文本层）。

测试样本是仓库内生成的：`node test/make-fixtures.mjs` 用 Node 现场拼出 deflate 压缩的 docx
与最小 PDF，再由 `test/tools.test.mjs` 断言真实提取结果（含中文、表格、`<w:delText>` 修订删除）。

## 与 t-auto/dsh-ops 的逐项对齐（已用测试验证）

dsh-ops 的工具契约来自 `src/capabilities/documents.ts` 与 `src/capabilities/file.ts`（`offset`/`limit` 分页、
`nextOffset` 续读、header 处理、`read_table` 的编码约束、`diff` 的“写入前预览 + 双 sha”语义）。逐项对照：

| dsh-ops 契约 | pi-ops 现状 | 验证 |
| --- | --- | --- |
| `read_pdf` 的 `offset`(默认 1)/`limit`(默认 10，≤32 页) | 同名同默认值，另加 `pages: "1,4-6"` 显式列表 | `read_pdf labels the page window` |
| 返回 `nextOffset` 以便续读 | 表头给 `nextOffset`，`details.nextOffset` 也返回 | `read_pdf … nextOffset` |
| 页标注 / 文本层语义、无 OCR | `--- page N ---`；扫描件明确说“无文本层”，不编造 | `no extractable text` 分支 |
| `read_docx` 的段落 `offset`/`limit`(默认 1/200，≤1000) | 同名同默认值，按“段落块”分页 | `read_docx … nextOffset` |
| `read_docx` 的 `include_headers`（默认排除页眉页脚） | 默认排除，`include_headers: true` 附加 | 实现+测试 |
| `read_docx` 拒绝二进制 `.doc` 并给下一步 | 明确提示 `soffice --convert-to docx` 或 Word COM | `legacy .doc is unsupported` |
| `read_table`（csv/tsv、编码、header、行分页） | 已实现：BOM 判 UTF-8/UTF-16，RFC 4180，header，`offset`/`limit`(默认 1/200，≤1000) | `read_table … end to end` |
| `read_table` 的“解码失败要暴露” | 非 UTF-8 字节给出替换率警告并指向 `Get-Content -Encoding Default` | `warns when the bytes are not UTF-8` |
| `diff` 的“文件 vs 拟写入内容 + old/new sha + 行数 + 0 基分页” | `diff_files { a, content }`：双 sha、行数变化、真实 unified diff（分页由 `max_chars` + `nextOffset` 提示代替） | `previews proposed content with sha/line identity` |
| 内容相同要明确说“无差异”而不是空输出 | `no differences (sha …)` | `identical content as no differences` |
| 参数错误返回结构化错误而非抛异常 | 全部工具 `return` 文本 + `details.error`，不 throw | `rejects ambiguous b+content` |

有意不照抄的部分（更适配 pi，并非缺失）：

- **不打包运行时**：dsh-ops 自带 PortableGit/MSYS2/pwsh；pi-ops 探测本机已有的 bash/pwsh 并写进 prompt，无二进制、无下载。
- **PDF 用 `pdftotext` 而不是自写解析器**：dsh-ops 只支持 classic xref + Type1 标准字体，pi-ops 走 Xpdf 4.06，覆盖面和容错都更好。
- **`diff_files` 支持双文件 / 工作区 vs HEAD**：dsh-ops 的 `diff` 只能对比“拟写入内容”，只保留单个 trimmed hunk；pi-ops 给真实 unified diff（`--unified=N`、忽略空白/CRLF），更适合审查。
- **docx 表格不带 `[table/row/cell]` 坐标**：渲染成 `单元格 | 单元格` 更省 token；需要坐标时用 `include_headers` + 原文段落定位。
- **`read_many` 是 pi-ops 新增**：dsh-ops 没有等价的批量读，它的 `read_files` 是单文件。

回归范围：`npm test` 跑 guard（26 项）、工具核心（35 项）、真实工具对等（19 项，通过 `registerTool` 假宿主直调）、
入口冒烟（6 个工具/1 命令/3 事件）。

## 与 t-auto/dsh-ops 的关系

读了这个项目（MIT）：核心价值是"自带私有 Node 运行时 + 私有 PortableGit/MSYS2 + 私有 pwsh，
在 Windows 上不依赖用户环境"，并提供 ops_* 文件工具。把它的运行时搬进 pi 扩展性价比很低
（几十 MB 二进制、生命周期和 pi 自身的 shell 发现机制打架），而它真正解决问题的部分是
**"prompt 里写清 Windows 事实 + 拦住会失败的调用"**——这两点用 pi 原生扩展 API 几行就能做到，
并且探测的是**这台机器**（本仓库没有打包任何二进制）。所以这里是"按它的思想重写"，不是移植。

## 顺带修掉的默认模型问题
`~/.pi/agent/settings.json` 原来没有 `defaultProvider`/`defaultModel`，默认模型只能从
`models.json` 里那个 llama.cpp 手工条目兜底推出，属于不确定行为。现在固定：

```json
"defaultProvider": "deepseek",
"defaultModel": "deepseek-v4-pro"
```

注意内置目录里 flash 的 id 是 `deepseek-flash`（不是 `deepseek-v4-flash`），pro 才是 `deepseek-v4-pro`；
指定模型要带 provider：`pi --model deepseek/deepseek-flash`，否则会撞上 opencode/qwen 的同名模型。

同时删掉了 `models.json` 里自定义的 `deepseek` provider 块（它把 `deepseek-flash` 的
maxTokens 压到 8192）。删掉后走 pi 内置目录：pro/flash 都是 1M 上下文、384K 输出。
实测 `pi -p` 会话中 `PI_MODEL=deepseek-v4-pro`。
