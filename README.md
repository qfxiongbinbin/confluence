# Confluence（汇流）— 核心引擎 + CLI

跨平台多模型 Agent 桌面客户端的 **M1 内核**。这一版实现了 PRD 里最难、也最有价值的那部分：把国内外各家大模型 API 的脾气抹平，让 Agent 能在你的电脑上**安全地**真正干活。

界面层（Tauri 或 Electron）还没做——PRD 把这个定为 M0 的待决策项，先把内核跑通，两条路后面都能接。

```
packages/core   引擎：provider 适配 / 权限 / 沙箱 / 工具 / Agent Loop / 持久化
packages/cli    命令行前端（cf）
scripts/smoke   端到端冒烟测试
```

零运行时依赖：`node:sqlite`、内置 `fetch`、`node:test`。装完就能跑。

---

## 快速开始

```bash
npm install
npm run build

# 方式一：环境变量（最快，不落盘）
export CF_KEY_DEEPSEEK='sk-...'
node packages/cli/dist/index.js provider add deepseek

# 方式二：交互式添加，密钥进系统密钥链
node packages/cli/dist/index.js provider add deepseek

# 自检：沙箱能不能用、密钥存哪、各家 provider 有什么坑
node packages/cli/dist/index.js doctor

# 真跑一个任务
node packages/cli/dist/index.js run "把当前目录的 md 文件整理成一个索引" --mode smart
```

建个别名会顺手很多：`alias cf='node ~/confluence/packages/cli/dist/index.js'`

---

## 已实现的部分

### 1. Provider 适配层（PRD F1）

这是整个产品最容易出 bug 的地方，所以做成了**声明式 quirks 配置** —— 新增一家 provider 的成本是「写一份配置 + 跑一遍兼容性测试」，不是改核心代码。

内置预设 11 家：DeepSeek、阿里百炼、智谱 GLM、Kimi、OpenAI、Anthropic、Ollama、LM Studio、硅基流动、OpenRouter，以及标记为**未验证**的火山方舟。任意 OpenAI/Anthropic 兼容端点都能作为自定义 provider 接入（one-api、new-api、LiteLLM、企业自建网关）。

已经处理掉的真实差异，每一条都对应一个测试：

| 坑 | 处理方式 |
|---|---|
| DeepSeek 的 `reasoning_content` 在多轮 + 工具调用时不回传就 400 | 消息模型里全程保留思维链，落库也不丢；`mustEchoBack` 声明式控制 |
| Kimi `k2.7-code` 不显式开思考直接 400 | 模型级 quirk 覆盖 `always_on`，引擎自动补上 |
| 智谱 GLM 的 temperature 区间是 (0,1) 且不接受 0 | 按 provider 动态夹紧并告诉用户改了什么 |
| DeepSeek 思考模式下 temperature 静默失效 | 不发送 + 明确警告，而不是让用户以为生效了 |
| 火山方舟模型要先在控制台开通 | 错误被识别成「去开通管理激活」，不是笼统的 400 |
| Ollama 只收 base64 图片、不支持若干参数 | 自动转换 + 静默剔除 |
| 各家限流模型完全不同 | 并发型（DeepSeek）短退避、RPM 型（阿里）长退避、分级型（Kimi Tier0 只有 3 RPM）等 20s+ |
| 阿里 Anthropic 端点没有 `/v1/models` | 允许手填模型名，不因此阻塞 |

双协议适配（OpenAI Chat Completions + Anthropic Messages）。**Anthropic 协议在国内已经普及**——DeepSeek、阿里、智谱、Kimi、MiniMax、StepFun、OpenRouter 都有 `/anthropic` 端点，有些能力只在这条路上完整暴露，所以不是可选项。

### 2. 权限引擎（PRD F4.2）

五级模式：`readonly` / `step_confirm` / `auto_edit` / `smart` / `full_auto`。

**强制拒绝清单不可关闭**，即使 `full_auto` 也拦得住：

- `.git/hooks/`、`.git/config` —— 下次 git 操作时会以非沙箱身份执行
- shell 启动文件（`.bashrc` / `.zshrc` / PowerShell profile）
- `.mcp.json`、Agent 配置目录
- 系统计划任务、登录项、`/etc/cron*`、systemd
- **应用自身的凭据目录**（读也拒绝）—— 否则 Agent 能通过 shell 读到自己的 API Key

前四条防的是「在沙箱里埋后门，下次逃逸」。最后一条是 Agent 客户端特有的漏洞。

### 3. OS 级沙箱（PRD F4.3，核心差异化）

- **macOS**：Seatbelt / `sandbox-exec`，内核强制
- **Linux**：bubblewrap + namespace 隔离，**fail-closed**
- **Windows**：MVP 未实现，如实上报为不可用

fail-closed 是刻意的：bwrap 不可用时**拒绝执行**，而不是像 Claude Code 那样静默降级成无沙箱。`cf doctor` 会检测 Ubuntu 23.10+ / 24.04 默认开启的 `apparmor_restrict_unprivileged_userns`（这个会让已安装的 bwrap 照样失败），并给出具体修法。

想承担风险可以显式 `--sandbox none`，但得自己说出口。

### 4. 工具集与回滚（PRD F4.1 / F3.5）

`read_file` `list_dir` `search` `write_file` `edit_file` `move_file` `trash_file` `run_command` `http_fetch`

- **没有 `delete_file`**，删除一律进任务回收站
- 写入前自动快照，`cf task rollback <id>` 一键回滚，默认先预演
- `edit_file` 的 `old_string` 必须唯一，否则拒绝执行——避免改错地方
- `run_command` 放进独立进程组，中止时整组 kill（实测 <2s）

**回滚的边界，写在代码里也印在输出里**：只覆盖 fs 工具产生的改动。`run_command` 的副作用（git push、npm install、数据库写入）回滚不了，任务结束和回滚确认时都会明说有多少条命令不在范围内。

### 5. Agent Loop（PRD F3）

结构性约束：Loop 产出的是**意图**，每个副作用都必须过权限引擎再过沙箱。没有第二条路径。这在 `agent.test.js` 里有测试兜着——用户拒绝时文件绝不落盘，拒绝原因作为 tool_result 回给模型让它调整。

还包括：逐步 checkpoint、结构化轨迹、上下文自动压缩（保留目标 / pin 的消息 / 已执行操作 / 文件改动，折叠冗长的中间过程）、预算上限、中止。

### 6. 成本核算（PRD F2.5）

- 缓存命中单独计价（DeepSeek 缓存命中比未命中便宜 120 倍，不单算的话统计毫无意义）
- 阶梯定价按输入长度选档
- **汇率在调用时刻固化进每条用量记录**，统计时不按当前汇率回算——否则跨月对不上账
- 未知模型标 `priced: false`，不假装 ¥0
- 价格表可远程更新、可用户覆盖；内置表里没核实的条目**标了「未核实」**

### 7. 密钥存储（PRD F7.1）

三种后端：环境变量 / 系统密钥链（macOS `security`、Linux `secret-tool`）/ 加密文件（AES-256-GCM + scrypt，需主密码）。

**绝不静默降级成明文** —— 这正是 Electron `safeStorage` 在没有 secret service 的 Linux 上的失效方式。没有可用后端时会拒绝保存并告诉你三个可选方案。

边界如实声明：不防同一用户身份下的恶意进程，不防运行时内存提取。

---

## 命令

```
cf run "<任务>"        让 Agent 干活
cf chat               交互式对话，/model 可中途切换
cf compare "<问题>" -m a -m b    并排跑多个模型，对比效果、延迟、成本
cf provider           ls / presets / add / set-key / test / rm
cf model ls|add       列出或手填模型
cf task               ls / show / trace / rollback
cf usage              用量与花费
cf price              ls / set（覆盖价格）
cf config             proxy / fx / default / secret-backend
cf doctor             自检
```

`cf run` 常用选项：

```
--dir <path>          工作目录
--mode <mode>         readonly | step_confirm | auto_edit | smart | full_auto
-m <provider/model>   指定模型
--thinking <level>    off | low | medium | high | max
--network <policy>    none | allowlist | all（默认 none）
--allow-domain <d>    放行域名（会自动切到 allowlist）
--budget <cny>        费用上限
--sandbox none        显式放弃 OS 级隔离
```

代理：`cf config proxy http://127.0.0.1:7890`。注意这只影响**模型 API 出站**；Agent 工具的网络访问由任务的 `--network` 单独管，两条链路是分开的。

---

## 测试

```bash
npm run check      # 70 个单测 + 14 项端到端冒烟
```

- `compat.test.js` —— provider 兼容性套件。**mock server 会像真实 API 一样失败**：不回传 reasoning_content 就返回 400，不开思考就返回 400，temperature=0 就报错。这是 PRD 要求的「对任意新接入的 provider 一键跑通」。
- `permission.test.js` —— 越权、路径穿越、强制拒绝清单、命令黑名单
- `tools.test.js` —— 快照回滚、超时杀进程、中止响应、fail-closed
- `agent.test.js` —— 端到端 Loop、上下文压缩、持久化、成本
- `scripts/smoke.mjs` —— 驱动真实 CLI 二进制，从配置到跑任务到回滚

开发时发现并修掉的真问题：Ollama 被误发 `parallel_tool_calls`；allowlist 里的域名还在重复询问；`/etc/cron.d` 没被拒绝规则覆盖；Node 的 `fetch` 把 ECONNREFUSED 藏在 `cause` 里导致网络错误显示成空消息（这条对国内用户最要命）。

---

## 还没做

按 PRD 的 M2/M3 排期，下一步依次是：

- **MCP 客户端** —— stdio + Streamable HTTP，且要做 2026-07-28 / 2025-11-25 双协议兼容
- **Windows 沙箱** —— 受限 token + Job Object + 本地回环代理（WFP 需管理员权限，不做主路径）
- **智能路由与故障转移** —— 客户端骨架已在，规则引擎未接
- **界面层** —— Tauri 还是 Electron 是 M0 决策点，流式 IPC 压测没做就别定
- **文档理解与 `create_document`** —— PRD 里 S-05「80 个 PDF 汇总成 Excel」依赖它
- **自动更新、备份恢复、首启引导**

内核里的 `PermissionEngine` 和沙箱层是纯函数式、无外部依赖的，将来搬到 Rust 侧做守门人是机械工作。这是当初这么写的原因。

---

## 许可

Apache-2.0
