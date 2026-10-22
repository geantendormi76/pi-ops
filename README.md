# pi-ops — 让 pi 在 Windows 上不再当 Linux 用

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
pi install C:/dev/pi-ops     # 已执行，写入 ~/.pi/agent/settings.json
pi list                      # 可见最后一项为 C:\dev\pi-ops
pi remove C:/dev/pi-ops
```

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

## 三个文件工具（对应 dsh-ops 的 ops_read_pdf / ops_read_docx / ops_diff）

都只依赖**本机已经装好的东西**，仓库里没有任何二进制，也不联网下载。

| 工具 | 后端 | 不依赖 |
| --- | --- | --- |
| `read_pdf` | 优先 `pdftotext`（Xpdf 4.06，随 Git for Windows 自带，`/mingw64/bin/pdftotext`）；缺失时退回 `uv run --with pypdf` | 不需要自己装 poppler、不需要 Python 环境、不需要 OCR |
| `read_docx` | 纯 Node：自己解析 zip 中央目录 + `inflateRawSync` 解压 `word/document.xml`，再把 WordprocessingML 转文本 | 不需要 Word/LibreOffice，不需要 `unzip` |
| `diff_files` | `git diff --no-index`，失败退回 `diff -u`；只传 `a` 时用 `git show HEAD:<file>` 取基线 | 不需要手写 `git diff` 管道 |

```
read_pdf   { path: "report.pdf", pages: "1-8", layout: true }   # 页码带“--- page N ---”标注，可按需只读几页
read_docx  { path: "spec.docx", include_headers: true }          # 段落换行、表格渲染成 “单元格 | 单元格”、保留 CJK、丢弃修订删除文本
_diff_files { a: "src/guard.ts" }                                # 工作区 vs HEAD，先给 hunk/± 统计再给 diff
diff_files { a: "a.ts", b: "b.ts", context: 5 }
```

共同约定：输出有字符预算（默认 pdf 40k、diff 20k），超了会保留头尾并提示如何收窄；
失败信息本身是可执行的下一步（文件缺失 / 不是 docx / HEAD 里没有该文件 / 扫描件无文本层）。

测试样本是仓库内生成的：`node test/make-fixtures.mjs` 用 Node 现场拼出 deflate 压缩的 docx
与最小 PDF，再由 `test/tools.test.mjs` 断言真实提取结果（含中文、表格、`<w:delText>` 修订删除）。

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

同时删掉了 `models.json` 里自定义的 `deepseek` provider 块（它把 `deepseek-flash` 的
maxTokens 压到 8192）。删掉后走 pi 内置目录：pro/flash 都是 1M 上下文、384K 输出。
实测 `pi -p` 会话中 `PI_MODEL=deepseek-v4-pro`。
