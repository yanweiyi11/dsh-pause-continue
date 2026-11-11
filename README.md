# dsh-pause-continue

Codex 式暂停与继续：把 Codex、Cursor 那种随时打断、再接着写的手感，搬进 DeepSeek Harness。

Pause a running DeepSeek Harness answer and continue it from the break point, with a Codex-style control. The interaction is modelled on Codex and Cursor.

## 功能

- 生成时，发送按钮位置显示暂停按钮；点击后真正停止当前这轮生成。
- 暂停后可以继续生成，也可以直接输入新消息发送。输入框有内容时显示原生发送按钮，不再误触继续按钮。
- 模型请求重试耗尽而失败时，保留错误信息；点击继续后，等恢复轮产生新的助手内容，才收起错误行和失败轮的过程，只保留最终回答。
- 暂停和继续的视觉衔接通过 Chat DOM 规则完成，继续轮的中间状态行会隐藏，最终回答接在原位置。
- 状态按会话保存在 profile 目录的 `dsh-pause-continue-state.json`。

## 安装

通过 DSH 插件管理器安装：

```sh
dsh plugin --profile <profile> add github:yanweiyi11/dsh-pause-continue
```

也可以在 DSH 的插件页使用安装地址 `github:yanweiyi11/dsh-pause-continue`。

安装或更新后重启 DSH，使 Host 端插件代码生效。

## 使用

1. 正常发送消息，模型开始生成。
2. 点击输入框右侧的暂停按钮。
3. 输入框为空时点击继续按钮，从断点继续；输入新内容时点击原生发送按钮，发送新消息。
4. 如果模型请求以可重试错误结束，错误提示会保留；点击继续后，新回答出现时旧错误和失败轮过程才会收起。

## 限制

- 继续生成是重新采样模型，不是逐 token 续写；断点处的措辞可能与暂停前不同。
- 视觉合并只适用于 DSH Web UI 和 Desktop 的 Chat 界面。
- 认证、额度类错误不会进入自动继续状态。
- 依赖 DSH 0.2.2-rc.1 的 `sessionController.commands.prompt` 内部接口与 Chat DOM 结构；升级 DSH 后如接口变化需要适配。

## 开发

```sh
# 语法检查
node --check index.js
node --check client.js
```

## 许可证

MIT
