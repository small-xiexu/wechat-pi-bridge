# Muse × Pi：微信 + Telegram 双通道 AI 助手协作实战

> 在微信和 Telegram 里直接跟你的 AI 助手聊天：发文字、发图片，也可以让它生成图片。
> 本文记录一套由 Muse 负责架构设计、代码实现、部署运维与审稿把关，再派遣 Pi 负责日常对话、图片理解和技能调用的真实跑通方案，包含实施过程中遇到的主要问题与解决办法。

---

## 1. 为什么是 Muse × Pi：效果展示

这套系统的核心，不是让 Pi 独立完成一个项目，而是让 **Muse 做架构师和指挥官，Pi 做被派出去的执行者**：

- Muse 负责动脑：设计微信与 Telegram 双通道架构、编写桥接代码、部署服务、设计数据库和看门狗机制。
- Pi 负责动手：在聊天中回复消息、理解图片、生成图片，并根据上下文自主调用 skills。
- Muse 负责运维与审稿：检查服务是否稳定、处理 VM 重置后的恢复、验证边界条件，并把最终方案整理成教程。
- Pi 负责一线交互：被桥接服务调用，使用持久会话响应来自微信和 Telegram 的日常请求。

这是一种很有代表性的 AI 协作模式：**Muse 把复杂问题拆成可执行的工程任务，再把适合对话和技能调用的工作派给 Pi**。Muse 不只是“使用 Pi”，而是围绕 Pi 设计一整套可以长期运行的基础设施。

搭建完成后，你会得到这样一套系统：

- **微信**：使用一个微信小号与 Pi 聊天。发送文字后，通常约 10～20 秒收到回复；发送照片后，Pi 可以理解图片内容。
- **Telegram**：使用专属 bot（`@你的_pi_bot`）与 Pi 聊天，也可以让 Pi 生成图片并发送回来。
- **记忆**：微信和 Telegram 使用独立的会话记忆，互不干扰。发送“新会话”即可清空当前会话。
- **自愈**：在本文使用的云 VM 环境中观察到周期性重置。Muse 设计并部署看门狗机制后，服务通常可以在 5 分钟内自动恢复，无需手动处理。

![第一章配图](images/chapter-01.png)

---

## 2. 整体架构：Muse 搭台，Pi 执行

![第2章配图](images/chapter-02.png)

Muse 先把消息入口、持久化层、执行层和恢复机制拆开，再让 Pi 作为统一的 AI 执行者接入两条通道：

```
你（微信小号） → iLink 官方通道 → wx-bot → 桥接服务 → SQLite → Pi → 发回微信
你（Telegram） → Bot API 轮询 → telegram-bridge → SQLite → Pi → 发回 TG
                                                        ↓
                                              看门狗 cron（每 5 分钟自愈）
```

在这套分工里，Muse 负责设计和维护 `wx-bot`、`telegram-bridge`、SQLite 以及看门狗；Pi 不直接管理微信或 Telegram 的网络协议，而是专注于被桥接服务调用，完成对话、看图和生图。

核心设计决策如下：

| 决策 | 选择 | 原因 |
|------|------|------|
| 微信通道 | 官方 iLink / Bot 通道 | 使用微信官方开放能力，避免依赖逆向协议 |
| 响应模型 | Pi（不是 Muse） | Pi 支持安装 skills 和配置私有模型；Muse 只在 App 中使用 |
| 会话 | 微信/TG 隔离 | 两端使用场景不同，分开管理更清晰 |
| 数据 | SQLite 本地存储 | 用于去重、防止重复发送和断点续传 |
| 自愈 | cron 定时检查 | 在本文使用的云 VM 环境中观察到周期性重置，因此服务必须具备自动恢复能力 |

Muse 的关键判断是：**入口和基础设施由自己控制，智能执行交给 Pi**。这样既能让 Pi 在不同渠道复用同一套能力，也不会把通道协议、重试逻辑和运维责任混进 Pi 的对话流程里。

---

## 3. 准备工作：Muse 先准备执行环境

![第3章配图](images/chapter-03.png)

这一章准备的是 Muse 的“指挥台”和 Pi 的“执行环境”。Muse 需要先准备稳定的运行机器、模型配置和外部通道，之后桥接服务才能把任务派给 Pi。

### 3.1 一台云服务器（或本地常开机的机器）

需要一台能够运行 Node.js 和 SQLite、并保持 7×24 小时在线的机器。本文使用的是 Muse 的云 VM；在该环境中观察到 VM 会周期性重置，后文会介绍相应的恢复方案。

这台机器主要承担 Muse 设计的基础设施：

- 运行微信和 Telegram 桥接服务。
- 保存 SQLite 数据库、会话状态和收到的媒体文件。
- 调用 Pi 的非交互命令。
- 执行 Muse 配置的看门狗和恢复脚本。

### 3.2 Pi coding agent

Pi 是 Muse 派出去执行 AI 任务的编程/助手 agent，支持：

- 配置私有模型（本文使用 sub2api 中转站）
- 安装 skills（专项技能包）
- 使用 `--print` 非交互模式，适合被程序调用
- 使用 `--session-id` 持久化会话

安装命令：

```bash
# 持久化安装（不要装 /usr/bin，VM 重置会丢）
npm install --prefix ~/workspace/tools/pi --ignore-scripts
```

Muse 负责决定 Pi 安装在哪里、如何被服务调用，以及如何避免 VM 重置导致执行环境丢失。Pi 则在这个环境里等待桥接服务派发对话任务。

### 3.3 Telegram bot

1. 找到 @BotFather 创建 bot，并获取 token。
2. 记录自己的 Telegram user ID，用于配置白名单，只允许自己使用。

Telegram 是 Muse 接入的第二个消息入口。Muse 负责 bot、白名单和轮询逻辑，Pi 负责收到消息后的理解和回复。

### 3.4 微信小号

准备一个微信小号（**不要使用大号**），用于扫码登录 iLink Bot 通道。

官方限制（实测）：

- 只支持一对一私聊，不支持群聊。
- 不能主动发起对话，必须由你先发送消息。
- 连续发送约 10 条消息而没有收到回复时，可能会被限流。

Muse 在这里负责选择通道、评估限制并把风险写进架构；Pi 不直接绕过这些平台约束，而是在消息进入桥接服务之后执行任务。

---

## 4. Pi 配置（关键）：Muse 为执行者接通能力

Muse 设计桥接架构之后，还要把 Pi 配置成一个真正能看图、能生图、能调用 skills 的执行者。这里的模型和会话配置，决定了 Pi 被派出去后能完成什么任务。

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

Muse 负责决定使用哪个模型、如何保护 API key，以及 Pi 的默认思考级别；Pi 在每次被桥接服务调用时读取这些配置并完成具体响应。

### 4.2 最大坑：`input` 声明

**这是本文最有价值的一个发现。**

Pi 的 `--print` 模式本身支持看图，可以通过 `@图片路径` 参数传入图片。但如果 `models.json` 没有为模型声明 `"input": ["text", "image"]`，Pi 会默认把它当作纯文本模型，**静默丢弃传入的图片**，随后一本正经地回复“我看不见图”。

Muse 在联调微信和 Telegram 图片链路时，排查了整整一轮：先查 Pi 源码确认图片确实进入了会话，再发现模型配置缺少 `input` 字段。补上该字段后，图片理解立即恢复正常。

![第四章配图](images/chapter-04.png)

这个问题说明了 Muse × Pi 协作中的一个关键边界：**Muse 负责验证数据是否正确到达，Pi 负责处理已经正确进入会话的数据**。如果模型能力声明不完整，Pi 即使收到了图片参数，也无法真正执行看图任务。

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

Muse 负责把文本推理和图片生成拆成两条能力链；Pi 根据上下文承担调用和编排，让用户只需要在聊天里提出需求。

### 4.4 Skills

Pi 支持安装可复用的 skills（技能包）。本文安装了三个图片类 skill：

- `punk-cover`：封面和海报生成
- `punk-avatar`：头像生成
- `punk-ip-video-cover`：人物视频封面生成

Pi 会根据上下文自主判断是否调用 skill，不需要在每次提示词中写死。

Muse 负责挑选、安装和配置这些技能包；Pi 被派出执行具体请求时，负责判断当前任务是否匹配某个 skill。也就是说，Muse 搭建能力库，Pi 在现场调用能力。

### 4.5 调用方式

桥接服务可以这样调用 Pi：

```bash
# 文字对话（持久会话）
pi --print --session-id pi-sean < /dev/null

# 带图片
pi --print --session-id pi-sean @/path/to/image.jpg < /dev/null
```

**注意**：从程序中调用 `pi --print` 时，必须重定向 stdin（`< /dev/null`），否则 Pi 会挂起并等待输入。

这里的调用命令是 Muse 写进桥接服务的“派工接口”。Pi 不需要知道消息来自微信还是 Telegram，只需要按照指定的会话 ID 和输入参数执行任务并返回结果。

---

## 5. Telegram 通道搭建：Muse 派 Pi 接管第二个入口

![第五章配图](images/chapter-05.png)

Telegram 通道由 Muse 负责接入和调度，Pi 负责处理已经通过白名单和消息队列校验的内容。

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

Muse 通过这个配置掌握 Telegram 的入口权限和调用节奏；Pi 不接触 bot token，也不负责判断谁有权使用 bot。

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

这里 Muse 负责写下完整的流水线：收消息、做权限控制、落 SQLite、合并消息、调用 Pi、发送结果。Pi 只承担中间的智能执行步骤，但这一步正是用户能感知到的核心能力。

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

Muse 负责把 Pi 的运行环境显式注入 systemd。否则 Pi 即使在交互式终端里能正常工作，被服务调用时也可能找不到配置、模型或网络代理。

---

## 6. 微信通道搭建：Muse 接入官方通道，Pi 执行消息任务

![第六章配图](images/chapter-06.png)

微信通道由 Muse 负责处理 iLink 登录、wx-bot 转发和服务部署，Pi 继续作为最终的对话与图片处理执行者。

### 6.1 iLink 扫码登录

使用微信官方 iLink Bot 通道：

1. 调用 `get_qrcode` 接口获取二维码。
2. 使用手机微信扫码确认。
3. 保存返回的 `bot_token`。

token 失效时的信号是 `errcode=-14`。iLink 没有 refresh 机制，失效后需要重新扫码登录。

Muse 负责保存和更新通道凭据，并在 token 失效时重新完成登录；Pi 不参与扫码和 token 刷新。

### 6.2 wx-bot

使用社区开源的 `wx-bot`（iLink 协议客户端）：

- `wx-bot run`：长轮询接收消息，并转发到本地 webhook。
- `wx-bot send`：发送文字；使用 `--image` 参数发送图片。

Muse 选择 `wx-bot` 来封装 iLink 协议细节，把微信协议层和 Pi 的智能层隔离开。

### 6.3 桥接服务

`wechat-bridge.service` 运行 `server.mjs`，主要负责：

- 接收 wx-bot 的 webhook。
- 将消息写入 SQLite，并执行 debounce 打包。
- 调用 Pi，使用 `pi-sean` 会话。
- 通过 `wx-bot send` 将文字发回微信。
- 通过 `wx-bot send --image` 将图片发回微信。

接收图片时，wx-bot 会将图片保存到 `state/wx-pi/media/`。桥接服务查询到文件路径后，通过 `@file` 参数将图片传给 Pi。

因此，微信用户看到的是“在和 Pi 聊天”，但背后真正完成通道接入、文件落盘、消息去重和结果回传的，是 Muse 设计并部署的桥接服务。

### 6.4 语音消息

目前已验证的是**微信通道**的语音转写能力，Telegram 语音未在本文方案中覆盖验证。

微信语音消息会自动转写成文字，实现要点如下：

1. **微信服务端直接提供转写**：转写内容位于 `voice_item.text`，不需要 Whisper 或本地 ASR。
2. **合并文字与转写结果**：当一条消息同时包含普通文字和语音转写内容时，需要合并展示，不能丢弃转写文本。

```js
const body = [text, voiceText ? `[语音转写]${voiceText}` : ''].filter(Boolean).join('\n');
```

Muse 负责在桥接层解析微信消息结构并组合文本，再把整理后的内容派给 Pi。需要特别强调：本文只覆盖微信通道的语音转写，Telegram 语音未覆盖验证。

---

## 7. 看门狗：Muse 为 Pi 的执行环境兜底

![第七章配图](images/chapter-07.png)

Pi 负责处理对话，但服务是否持续在线、VM 重置后能否恢复，属于 Muse 的架构和运维责任。

### 7.1 为什么需要

在本文使用的云 VM 环境中观察到 VM 会周期性重置。重置后可能出现：

- `/etc/` 下的 systemd unit 全部丢失。
- 所有正在运行的进程被终止。
- `~/` 下的数据仍然保留，SQLite 数据库和配置文件不受影响。

典型表现是：bot 突然不再回复消息。

如果没有看门狗，Pi 即使本身没有问题，也会因为桥接服务停止而无法接收任务。Muse 因此需要为整个执行链路设计自动恢复机制。

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

在这套模式中，Pi 是被恢复的执行者，Muse 的看门狗则负责确保“派工系统”重新上线。服务恢复之后，新的微信和 Telegram 消息仍会按照原来的流程交给 Pi。

---

## 8. 测试验证清单：Muse 验收，Pi 执行

![第8章配图](images/chapter-08.png)

建议由 Muse 按以下顺序测试，确认桥接、会话、媒体、skills 和自愈机制都符合预期。每项测试中，Pi 负责完成实际的对话或生成任务，Muse 负责检查链路是否完整、结果是否正确返回。

- [ ] 微信发送“你好”，Pi 返回文字回复
- [ ] Telegram 发送“你好”，Pi 返回文字回复
- [ ] 微信发送照片并询问“这是什么”，Pi 能描述图片内容
- [ ] Telegram 发送照片并询问“这是什么”，Pi 能看到图片并进行描述
- [ ] Telegram 发送“生成一张国庆海报”，Pi 生成图片并自动发回
- [ ] 微信发送“新会话”，再继续聊天，确认记忆已清空
- [ ] 先在微信聊 A 话题，再切换到 Telegram 聊 B 话题，确认两边记忆不串
- [ ] 手动终止服务，等待 5 分钟，确认看门狗能够将其重新拉起

这里的验收标准不是“Pi 能不能单独聊天”，而是 Muse 设计的整个系统能否稳定地把不同渠道的任务派给正确的 Pi 会话，并把结果送回原渠道。

---

## 9. 常见坑汇总：Muse 的审稿与排障清单

![第9章配图](images/chapter-09.png)

下表既是部署排障清单，也是 Muse 在审查 Pi 执行链路时需要重点确认的边界。

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

排障时，Muse 需要先判断问题属于哪一层：

- 通道层：微信 iLink、Telegram Bot API 或代理。
- 桥接层：SQLite、debounce、媒体文件和回传逻辑。
- Pi 执行层：模型输入声明、会话配置、skills 和 stdin。
- 运维层：systemd、内存限制、VM 重置和看门狗。

只有把这些层次分开，才能避免把基础设施问题误判成 Pi 的能力问题。

---

## 10. 架构取舍：Muse 选择路线，Pi 承担执行

![第10章配图](images/chapter-10.png)

**为什么不用 CxxVen 的 Python 版？**

CxxVen 的方案是在 X 上获得 4 万浏览、并有多人在评论区反馈跑通的 Python 手写 iLink 协议方案，简单直接。但本文选择了 Node + 社区 wx-bot 的路线，主要原因如下：

- wx-bot 已经封装了 iLink 协议细节，不需要自行拼接 header。
- SQLite 可以同时承担去重、防止重复发送、debounce 和会话持久化。
- 图片双向传输和“新会话”命令可以较方便地扩展到桥接服务中。

简单来说：**CxxVen 的方案适合“半小时搭起来玩玩”，本文方案更适合长期运行和持续扩展**。两条路线使用的 iLink 通道和看门狗思路是相通的。

更重要的是，这个项目展示的并不只是某个微信接入技巧，而是一种可以复用的协作范式：

- Muse 负责动脑：明确目标、设计架构、写桥接代码、部署服务、处理故障、建立恢复机制，并对最终结果审稿。
- Pi 负责干活：处理日常对话、看图、生成图片，并按上下文自主调取 skills。
- 桥接层负责传令：把微信和 Telegram 的消息转换成 Pi 能执行的任务，再把结果送回用户。
- 看门狗负责兜底：即使运行环境出现重置，也尽量让整个协作系统自动恢复。

这套“**Kavi 动脑、Pi 干脏活**”的分工模式并不局限于微信和 Telegram。换一个入口和业务逻辑，就可以扩展到：

- **代购监控**：Muse 设计价格追踪、库存检测和通知架构，Pi 负责读取页面信息、判断商品变化并生成提醒。
- **内容生成**：Muse 设计选题、审核和发布流程，Pi 负责根据素材生成标题、摘要、配图和不同平台版本。
- **数据分析**：Muse 负责定义指标、搭建数据管道和验证结果，Pi 负责整理数据、解释趋势并生成报告。
- **客服与工单**：Muse 设计渠道接入、权限、记忆和升级规则，Pi 负责一线问答和工单分类。
- **个人自动化**：Muse 把复杂任务拆成可恢复的工作流，Pi 负责在每个节点执行具体操作。

最终，Muse × Pi 的价值不在于“让一个 AI 包办所有事情”，而在于让不同 AI 的优势形成清晰分工：**Muse 负责把问题变成系统，Pi 负责把系统变成行动**。

---

*教程版本：2026-10-11 · 基于真实跑通的系统整理*  
*官方限制：微信小号、一对一私聊、不能主动发起对话；iLink 返回 `-14` 时需要重新扫码*
