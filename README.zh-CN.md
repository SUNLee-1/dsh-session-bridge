# dsh-session-bridge

[English](README.md) · **简体中文**

在 **DeepSeek Harness** 与 **Codex** 之间双向搬运单个编程对话——不修改任何已有会话。

DSH 作为控制中心：它按 Codex 自己的样子显示 Codex 侧边栏，写入 Codex 前会先备份。

```
┌ 会话互通 ─────────────────────────────────────────────┐
│  选择迁移方向                                          │
│  ┌───────────────────┐ ┌───────────────────┐          │
│  │ Codex → DSH       │ │ DSH → Codex       │          │
│  └───────────────────┘ └───────────────────┘          │
└────────────────────────────────────────────────────────┘
        ↓
┌ 项目（按来源软件自己的分组）      │ 对话详情        ┐
│ 论文+毕设专家助理              5 │ 11 条消息      │
│ LibTV Plugin                  9 │ 29 次工具调用   │
│ 飞书+UIUX                      4 │ 2 轮           │
│ 互通收件箱                     0 │ 目标位置 [下拉] │
│                                 │ [ 开始导入 ]    │
└─────────────────────────────────┴────────────────┘
```

## 它和普通格式转换器有什么不同

**照抄对方的界面，而不是猜分组。** Codex 的侧边栏不是按工作目录分的，它把布局存在
`.codex-global-state.json`（`project-order` / `local-projects` /
`thread-project-assignments` / `sidebar-project-thread-orders` /
`projectless-thread-ids`），并且隐藏了自己的内部复核线程
（`thread_source = guardian_review`）。读这些键，才是 28 条真实对话，而不是 104 条混杂记录。

**跟随 DSH 的 schema，而不是写死字段。** 每条事件的必填项在运行时从
`<安装目录>/docs/persistence-schema.json` 解析；`schema/baseline.json` 记录本版基线，
`asb drift` 会在对方升级后告诉你。

**很小。** 零依赖、无构建步骤、约 3.4k 行。会话是「流式读出 → 直写目标」，从不整份读入内存。

| 操作 | 开销 |
|---|---|
| 插件常驻内存 | ≈ 7 MB |
| 列 110 个 Codex 会话（语料 1.3 GB，最大单个 299 MB） | 约 30–110 ms，瞬时 +25 MB |
| 3 秒内重复打开面板 | 0 ms |
| 导入一个 101 事件的会话 | 110 KB 日志，2 个 zstd 帧 |

## 安装

### 方式一：作为 DSH 插件（获得面板）

要求 **DeepSeek Harness** + Node **22.0+**（应用自带运行时即可）。

```bash
git clone https://github.com/SUNLee-1/dsh-session-bridge.git
```

然后在 DSH 里：**插件 → 添加插件 → 本地目录**，选中克隆下来的文件夹。
或者让 agent 执行：

```
plugin_manager  action: install_bundle
target: /绝对路径/dsh-session-bridge
```

重启 DSH 一次，侧边栏底部会出现 **会话互通 / Session bridge** 图标。

### 方式二：命令行（不装 DSH 也能用）

```bash
node bin/asb.mjs doctor          # 看这台机器能做什么
node bin/asb.mjs list            # 列出全部会话（按项目分组）
node bin/asb.mjs migrate --from codex --id <会话id> --to dsh --workspace "/目标/路径"
node bin/asb.mjs verify <session.v4.jsonl.zstd>
```

读写 DSH 日志需要 zstd：要么在 DSH 内运行（自带），要么 Node ≥ 22.15。
更老的 Node 上 CLI 会自动借用已安装的 DSH 二进制，`doctor` 会告诉你走的是哪条路。

### 方式三：MCP 服务器（给 Codex / Claude Code 等用）

```json
{
  "mcpServers": {
    "session-bridge": {
      "command": "node",
      "args": ["/绝对路径/dsh-session-bridge/mcp/server.mjs"]
    }
  }
}
```

工具：`session_bridge_list`、`session_bridge_migrate`、`session_bridge_verify`、`session_bridge_drift`。

## 互通收件箱

首次启用时，插件会创建**一个文件夹，它同时是 DSH 工作区和 Codex 项目**，让迁移有固定落点：

| | |
|---|---|
| 文件夹 | `~/Session Bridge`（两端同一真实路径） |
| DSH 侧 | 名为 *Session Bridge* 的工作区 |
| Codex 侧 | 名为 *Session Bridge* 的项目，排在侧边栏第一位 |

每次导入默认落到这里，面板里标为 **互通收件箱**。创建是幂等的，会先备份 Codex 索引与 UI 状态，
不碰任何已有项目。

在 `cordis.patch.yml` 里改：

```yaml
config:
  bridge:
    enabled: true
    path: '~/Documents/我的收件箱'   # 留空 = "<用户目录>/Session Bridge"
    name: '我的收件箱'
```

## 迁移时到底写了什么

| 方向 | 新建 | 绝不改动 |
|---|---|---|
| Codex → DSH | 一个新 `session.v4.jsonl.zstd` | 任何已有会话 |
| DSH → Codex | 一个 rollout 文件 + `state_N.sqlite` 一行 + `.codex-global-state.json` 一条归属 | 任何已有行、rollout、项目 |

Codex 侧写入前会把 `state_N.sqlite` 和 `.codex-global-state.json` 复制成
`*.asb-backup-<时间戳>`，只保留最新三份，并且只用 `INSERT`。
每次导入记入 `~/.dsh/session-bridge/migrations.json`，重复导入会提示 `duplicate` 而不是复制两份。

## DSH 不会接受什么

格式正确 ≠ 能被打开。DSH 在加载时会校验跨事件关系，写入端逐条满足：

- `tool/call` 必须先在**同一步**的 `assistant/message` 里以 `tool-call` 内容块被"广告"
- 一步结束前不能有已广告但**未解决**的工具调用（源会话没结果时补一条明确的 isError 结果）
- turn 从 1 连续，turn 内 step 从 1 连续（丢弃源编号，重新编号）

`asb verify` 直接调用 DSH 自己的 `assertReleasedV4Relationships`，导入完可以先验再开。

## 平台支持

| | Linux | macOS | Windows |
|---|---|---|---|
| 插件（Host + 面板） | ✅ | ✅ | ✅ |
| CLI | ✅ | ✅ | ✅ |
| MCP | ✅ | ✅ | ✅ |

路径全部运行时发现，从不写死。可用环境变量覆盖：
`DSH_HOME`、`CODEX_HOME`、`DSH_INSTALL_DIR`、`ASB_NODE`。

## 常见问题

**导入后侧边栏看不到？**
DSH 侧边栏读的是启动时的注册表快照。重启 DSH 一次即可。另外 DSH 目标**必须是已注册的工作区**
（面板里用下拉选择，默认就是收件箱），指向普通文件夹会产生一个永远显示不出来的会话。

**提示 `has no advertised tool lifecycle` / `stored log is corrupt`？**
说明是旧版本写的日志。升级后重新导入即可（`asb verify` 会给出具体原因）。

**Codex 里看不到导入的对话？**
重启 Codex。同时确认列 `source`/`model_provider` 是 Codex 自己认识的值——这两个字段是
`NOT NULL` 且只接受 Codex 写过的值，所以导入行固定为 `vscode`/`openai`，不影响对话内容。

**`asb doctor` 说 native zstd 不可用？**
在 DSH 内运行，或升级到 Node ≥ 22.15。只要装了 DSH，CLI 会自动借用它的二进制。

**导入会重复占空间吗？**
不会复制两份：写入目标后记进台账，同一对话再次导入会被判定 `duplicate`。

## 扩展一个新的 agent

往 `lib/adapters/local/` 放一个模块即可，见
[lib/adapters/local/README.md](lib/adapters/local/README.md)。启动时自动发现，不需要改核心、不需要构建。

## 开发

```bash
node --test          # 10 项测试，零依赖
node bin/asb.mjs doctor
```

## 许可

MIT，见 [LICENSE](LICENSE)。
