# 微信 + Telegram 双通道接入 Pi 完整教程

> 在微信和 Telegram 里直接跟你的 AI 助手聊天：发文字、发图片，也可以让它生成图片。
> 本文记录一套真实跑通的方案，包含实施过程中遇到的主要问题与解决办法。

---

## 1. 效果展示

搭建完成后，你会得到这样一套系统：

- **微信**：使用一个微信小号与 Pi 聊天。发送文字后，通常约 10～20 秒收到回复；发送照片后，Pi 可以理解图片内容。
- **Telegram**：使用专属 bot（`@你的_pi_bot`）与 Pi 聊天，也可以让 Pi 生成图片并发送回来。
- **记忆**：微信和 Telegram 使用独立的会话记忆，互不干扰。发送“新会话”即可清空当前会话。
- **自愈**：在本文使用的云 VM 环境中观察到周期性重置。通过看门狗机制，服务通常可以在 5 分钟内自动恢复，无需手动处理。

![第一章配图](images/chapter-01.png)

---

## 2. 整体架构

![第2章配图](images/chapter-02.png)

```
你（微信小号） → iLink 官方通道 → wx-bot → 桥接服务 → SQLite → Pi → 发回微信
你（Telegram） → Bot API 轮询 → telegram-bridge → SQLite → Pi → 发回 TG
                                                        ↓
                                              看门狗 cron（每 5 分钟自愈）
```

核心设计决策如下：

| 决策 | 选择 | 原因 |
|------|------|------|
| 微信通道 | 官方 iLink / Bot 通道 | 使用微信官方开放能力，避免依赖逆向协议 |
| 响应模型 | Pi（不是 Muse） | Pi 支持安装 skills 和配置私有模型；Muse 只在 App 中使用 |
| 会话 | 微信/TG 隔离 | 两端使用场景不同，分开管理更清晰 |
| 数据 | SQLite 本地存储 | 用于去重、防止重复发送和断点续传 |
| 自愈 | cron 定时检查 | 在本文使用的云 VM 环境中观察到周期性重置，因此服务必须具备自动恢复能力 |

---

## 3. 准备工作

![第3章配图](images/chapter-03.png)

### 3.1 一台云服务器（或本地常开机的机器）

需要一台能够运行 Node.js 和 SQLite、并保持 7×24 小时在线的机器。本文使用的是 Muse 的云 VM；在该环境中观察到 VM 会周期性重置，后文会介绍相应的恢复方案。

### 3.2 Pi coding agent

Pi 是一个 AI 编程/助手 agent，支持：

- 配置私有模型（本文使用 sub2api 中转站）
- 安装 skills（专项技能包）
- 使用 `--print` 非交互模式，适合被程序调用
- 使用 `--session-id` 持久化会话

安装命令：

```bash
# 持久化安装（不要装 /usr/bin，VM 重置会丢）
npm install --prefix ~/workspace/tools/pi --ignore-scripts
```

### 3.3 Telegram bot

1. 找到 @BotFather 创建 bot，并获取 token。
2. 记录自己的 Telegram user ID，用于配置白名单，只允许自己使用。

### 3.4 微信小号

准备一个微信小号（**不要使用大号**），用于扫码登录 iLink Bot 通道。

官方限制（实测）：

- 只支持一对一私聊，不支持群聊。
- 不能主动发起对话，必须由你先发送消息。
- 连续发送约 10 条消息而没有收到回复时，可能会被限流。

---

## 4. Pi 配置（关键）

### 4.1 模型配置

编辑 `~/.pi/agent/models.json`：

```json
{
  "providers": {
    "sub2api": {
      "api": "openai-completions",
      "apiKey": "!cat /home/你的用户名/.pi/agent/.sub2api_key",
      "baseUrl": "https://你的中转站/v1",
      "models": [
        { "id": "gpt-6.1-sol", "input": ["text", "image"] }
      ]
    }
  }
}
```

编辑 `~/.pi/agent/settings.json`：

```json
{
  "defaultModel": "sub2api/gpt-6.1-sol",
  "defaultThinkingLevel": "xhigh"
}
```

### 4.2 最大坑：`input` 声明

**这是本文最有价值的一个发现。**

Pi 的 `--print` 模式本身支持看图，可以通过 `@图片路径` 参数传入图片。但如果 `models.json` 没有为模型声明 `"input": ["text", "image"]`，Pi 会默认把它当作纯文本模型，**静默丢弃传入的图片**，随后一本正经地回复“我看不见图”。

我们排查了整整一轮：先查 Pi 源码确认图片确实进入了会话，再发现模型配置缺少 `input` 字段。补上该字段后，图片理解立即恢复正常。

![第四章配图](images/chapter-04.png)

### 4.3 生图模型

单独配置一个图片生成 provider（本文使用 `sub2api-img`）：

```json
"sub2api-img": {
  "api": "openai-images",
  "baseUrl": "https://你的中转站/v1",
  "models": [{ "id": "gpt-image-2.5-sunburst" }]
}
```

文本对话使用 `gpt-6.1-sol`，图片生成使用 `gpt-image-2.5-sunburst`，两者职责分离。

### 4.4 Skills

Pi 支持安装可复用的 skills（技能包）。本文安装了三个图片类 skill：

- `punk-cover`：封面和海报生成
- `punk-avatar`：头像生成
- `punk-ip-video-cover`：人物视频封面生成

Pi 会根据上下文自主判断是否调用 skill，不需要在每次提示词中写死。

### 4.5 调用方式

桥接服务可以这样调用 Pi：

```bash
# 文字对话（持久会话）
pi --print --session-id pi-sean < /dev/null

# 带图片
pi --print --session-id pi-sean @/path/to/image.jpg < /dev/null
```

**注意**：从程序中调用 `pi --print` 时，必须重定向 stdin（`< /dev/null`），否则 Pi 会挂起并等待输入。

---

## 5. Telegram 通道搭建

![第五章配图](images/chapter-05.png)

### 5.1 配置

编辑 `config/telegram.json`，并将文件权限设置为 600。token 绝不能提交到代码仓库：

```json
{
  "telegram": {
    "pi_bot_token": "你的bot token",
    "allowed_user_ids": ["你的TG user ID"],
    "api_base": "https://api.telegram.org",
    "debounce_ms": 2500
  }
}
```

### 5.2 桥接服务

`telegram-bridge.mjs` 在单个进程中完成三项工作：

1. **poll loop**：通过 `getUpdates` 长轮询接收消息。
2. **dispatch loop**：执行 debounce，将消息打包后调用 Pi，再把结果发回 Telegram。
3. **图片处理**：自动下载收到的照片，并通过 `sendPhoto` 发送图片。

消息流程如下：

```
getUpdates → 白名单校验 → SQLite inbox → debounce 2.5s →
打包 → Pi (--session-id telegram-pi-sean) → sendMessage / sendPhoto
```

debounce 的作用是：当你连续发送 3 条消息时，2.5 秒内的消息会被合并为一批，再交给 Pi 处理，避免频繁触发调用。

### 5.3 systemd 服务

```ini
[Service]
# 代理（Node 24 fetch 需要）
Environment=HTTPS_PROXY=...
Environment=NODE_USE_ENV_PROXY=1
# Pi 按 HOME 找配置
Environment=HOME=/home/你的用户名
# 内存上限
ExecStart=/usr/bin/node --max-old-space-size=128 app/telegram-bridge.mjs
```

**常见坑**：代理环境变量必须写在 `[Service]` 段中。若写到 `[Install]` 段，systemd 会静默忽略它，随后就会看到大量 `fetch failed`。

---

## 6. 微信通道搭建

![第六章配图](images/chapter-06.png)

### 6.1 iLink 扫码登录

使用微信官方 iLink Bot 通道：

1. 调用 `get_qrcode` 接口获取二维码。
2. 使用手机微信扫码确认。
3. 保存返回的 `bot_token`。

token 失效时的信号是 `errcode=-14`。iLink 没有 refresh 机制，失效后需要重新扫码登录。

### 6.2 wx-bot

使用社区开源的 `wx-bot`（iLink 协议客户端）：

- `wx-bot run`：长轮询接收消息，并转发到本地 webhook。
- `wx-bot send`：发送文字；使用 `--image` 参数发送图片。

### 6.3 桥接服务

`wechat-bridge.service` 运行 `server.mjs`，主要负责：

- 接收 wx-bot 的 webhook。
- 将消息写入 SQLite，并执行 debounce 打包。
- 调用 Pi，使用 `pi-sean` 会话。
- 通过 `wx-bot send` 将文字发回微信。
- 通过 `wx-bot send --image` 将图片发回微信。

接收图片时，wx-bot 会将图片保存到 `state/wx-pi/media/`。桥接服务查询到文件路径后，通过 `@file` 参数将图片传给 Pi。

### 6.4 语音消息

目前已验证的是**微信通道**的语音转写能力，Telegram 语音未在本文方案中覆盖验证。

微信语音消息会自动转写成文字，实现要点如下：

1. **微信服务端直接提供转写**：转写内容位于 `voice_item.text`，不需要 Whisper 或本地 ASR。
2. **合并文字与转写结果**：当一条消息同时包含普通文字和语音转写内容时，需要合并展示，不能丢弃转写文本。

```js
const body = [text, voiceText ? `[语音转写]${voiceText}` : ''].filter(Boolean).join('\n');
```

---

## 7. 看门狗：应对云 VM 重置

![第七章配图](images/chapter-07.png)

### 7.1 为什么需要

在本文使用的云 VM 环境中观察到 VM 会周期性重置。重置后可能出现：

- `/etc/` 下的 systemd unit 全部丢失。
- 所有正在运行的进程被终止。
- `~/` 下的数据仍然保留，SQLite 数据库和配置文件不受影响。

典型表现是：bot 突然不再回复消息。

### 7.2 方案

准备一个幂等恢复脚本 `bin/ensure-services`：

- unit 缺失时，从 workspace 模板复制恢复。
- 服务未处于 active 状态时，启动服务。

再配置一个每 5 分钟运行一次的 cron 定时任务。使用平台托管的 cron，可以让该检查任务在 VM 重置后继续存在：

```
每 5 分钟 → ensure-services → 三个服务自愈
```

正常运行时保持静默，只有连续拉起失败时才发送通知。实测在该环境中，VM 重置后服务可以在 5 分钟内自动恢复；重置期间遗漏的消息则依靠数据库游标补收。

> 这是社区实践中常见的一种恢复思路；例如 CxxVen 的微信接入配方也采用了类似的第 5 步方案。

---

## 8. 测试验证清单

![第8章配图](images/chapter-08.png)

建议按以下顺序测试，全部通过后再视为基本跑通：

- [ ] 微信发送“你好”，Pi 返回文字回复
- [ ] Telegram 发送“你好”，Pi 返回文字回复
- [ ] 微信发送照片并询问“这是什么”，Pi 能描述图片内容
- [ ] Telegram 发送照片并询问“这是什么”，Pi 能看到图片并进行描述
- [ ] Telegram 发送“生成一张国庆海报”，Pi 生成图片并自动发回
- [ ] 微信发送“新会话”，再继续聊天，确认记忆已清空
- [ ] 先在微信聊 A 话题，再切换到 Telegram 聊 B 话题，确认两边记忆不串
- [ ] 手动终止服务，等待 5 分钟，确认看门狗能够将其重新拉起

---

## 9. 常见坑汇总

![第9章配图](images/chapter-09.png)

| 坑 | 现象 | 根因 | 解法 |
|----|------|------|------|
| Pi 看不见图 | “我无法查看这张图片” | `models.json` 缺少 `input` 声明 | 添加 `"input": ["text", "image"]` |
| Pi 调用挂起 | 命令卡死、无输出 | `--print` 等待 stdin | 添加 `< /dev/null` |
| TG 收不到消息 | poll 报 `fetch failed` | systemd 的干净环境缺少代理 | 将代理写在 `[Service]` 段，并设置 `NODE_USE_ENV_PROXY=1` |
| Pi 找不到配置 | 报配置错误 | systemd 中的 HOME 配置不正确 | 添加 `Environment=HOME=/home/你的用户名` |
| 微信发不出去 | 没有报错，但对方收不到 | iLink 参数细节不正确 | 检查 `from_user_id=""`、`message_type=2` 等参数 |
| Token 失效 | 所有消息突然都没有回复 | iLink 返回 `errcode=-14` | 重新扫码登录，iLink 没有 refresh 机制 |
| 服务突然全部停止 | bot 不再回复消息 | VM 被平台重置 | 使用看门狗进行 5 分钟周期性自愈 |
| 内存偏高 | VM 出现内存告警 | 多进程运行且没有设置上限 | 尽量使用单进程，并设置 `--max-old-space-size=128` |

---

## 10. 架构取舍

![第10章配图](images/chapter-10.png)

**为什么不用 CxxVen 的 Python 版？**

CxxVen 的方案是在 X 上获得 4 万浏览、并有多人在评论区反馈跑通的 Python 手写 iLink 协议方案，简单直接。但本文选择了 Node + 社区 wx-bot 的路线，主要原因如下：

- wx-bot 已经封装了 iLink 协议细节，不需要自行拼接 header。
- SQLite 可以同时承担去重、防止重复发送、debounce 和会话持久化。
- 图片双向传输和“新会话”命令可以较方便地扩展到桥接服务中。

简单来说：**CxxVen 的方案适合“半小时搭起来玩玩”，本文方案更适合长期运行和持续扩展**。两条路线使用的 iLink 通道和看门狗思路是相通的。

---

*教程版本：2026-10-11 · 基于真实跑通的系统整理*  
*官方限制：微信小号、一对一私聊、不能主动发起对话；iLink 返回 `-14` 时需要重新扫码*
