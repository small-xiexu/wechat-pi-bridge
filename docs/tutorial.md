# Muse 负责托付、Pi 负责干活：我把微信和 TG 外包给了 AI

ChatGPT 适合查询，Muse 适合托付——事情交出去，不必全程盯着。我把这句话落到了实处：让 Muse 做架构师和指挥官，把微信和 Telegram 的日常聊天全部托付给 Pi。现在我在微信/TG 里直接跟 AI 助手聊天：发文字秒回，发照片它能看懂，发微信或 Telegram 语音自动转文字，还能按要求生图。本文记录这套系统的完整搭建过程，全部代码已开源，照着做就能复刻。

---

> **全网首发**：第一个讲透「Muse 负责架构运维、Pi 负责一线执行」分工模式的微信 / Telegram 双通道实战教程——全链路真机实测，代码全部开源。

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
- **语音转写**：微信语音走微信服务端转写；Telegram 语音由桥在本地用 whisper.cpp 转写，两条通道机制不同。
- **自愈**：在本文使用的云 VM 环境中观察到周期性重置。Muse 设计并部署看门狗机制后，服务通常可以在 5 分钟内自动恢复，无需手动处理。

**演示视频**（真机录屏，2026-10-13）：

- [微信通道演示（68 秒）](https://github.com/small-xiexu/wechat-pi-bridge/releases/download/demo-2026-10-13/wechat-demo.mp4)：微信小号与 Pi 对话——文字让 Pi 写秋天朋友圈文案、语音问天气。
- [Telegram 通道演示（25 秒）](https://github.com/small-xiexu/wechat-pi-bridge/releases/download/demo-2026-10-13/tg-demo.mp4)：发语音让 Pi 生成潮汕英歌舞插画（本地 whisper 转写）、发猫照片问品种。

**实测矩阵**（每一项均为真机实测，不是只跑了 demo）：

| 能力 | 微信 | Telegram | 备注 |
| --- | --- | --- | --- |
| 文字对话 | ✅ | ✅ | |
| 图片理解 | ✅ | ✅ | 发照片，Pi 能看懂内容 |
| 图片发送 | ✅ | ✅ | 微信走 wx-bot，TG 走 sendPhoto |
| 语音转写 | ✅ | ✅ | 微信走服务端转写；TG 本地 whisper.cpp 转写 |
| AI 生图 | — | ✅ | 微信端暂未打通 |
| 会话记忆 | ✅ 独立 | ✅ 独立 | 双通道互不干扰 |
| 断线自愈 | ✅ | ✅ | 看门狗 5 分钟拉起，亲历多次 VM 重置 |

![第一章配图](images/chapter-01.png)

---

## 2. 整体架构：Muse 搭台，Pi 执行

![第2章配图](images/chapter-02.png)

Muse 先把消息入口、持久化层、执行层和恢复机制拆开，再让 Pi 作为统一的 AI 执行者接入两条通道：

```text
你（微信小号） → 微信侧 iLink 接口（社区 wx-bot 第三方客户端） → 微信桥接服务 → SQLite → Pi → 发回微信
你（Telegram） → Bot API 轮询 → telegram-bridge → SQLite → Pi → 发回 TG
                                                                  ↓
                                                        看门狗 cron（每 5 分钟自愈）
```

在这套分工里：

- Muse 负责设计和维护 `wx-bot`、`telegram-bridge`、SQLite 以及看门狗。
- Pi 不直接管理微信或 Telegram 的网络协议。
- Pi 专注于被桥接服务调用，完成对话、看图和生图。
- 微信和 Telegram 使用不同的 Pi 会话 ID，因此上下文互不串线。

核心设计决策如下：

| 决策 | 选择 | 原因 |
|------|------|------|
| 微信通道 | 社区 wx-bot 的第三方 iLink 协议接入 | 非官方实现，存在风控/封禁风险，请用小号 |
| 响应模型 | Pi，而不是 Muse | Pi 支持私有模型、skills 和非交互调用 |
| 会话 | 微信/TG 隔离 | 两端使用场景不同，分开管理更清晰 |
| 数据 | SQLite 本地存储 | 用于去重、防止重复发送、debounce 和断点续传 |
| 自愈 | cron 定时检查 | 在本文使用的云 VM 环境中观察到周期性重置 |

Muse 的关键判断是：**入口和基础设施由自己控制，智能执行交给 Pi**。

---

## 3. 准备工作：Muse 先准备执行环境

![第3章配图](images/chapter-03.png)

以下命令默认项目目录为：

```text
/home/__USER__/workspace/wechat-pi-bridge
```

如果你的用户名或目录不同，请先统一替换 `__USER__` 和 `__PROJECT_DIR__`。

### 3.1 系统要求

需要一台能够长期在线的 Linux 云服务器或本地机器：

- Node.js **22 或更高版本**。项目 `package.json` 声明的运行要求是 `>=22`。
- SQLite。
- systemd。
- cron 或平台托管的定时任务。
- 能访问 Telegram Bot API、Pi 模型中转站和 iLink 服务。
- 建议至少 1 GB 内存；Pi 和桥接服务会同时运行。

检查 Node.js：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
node --version
npm --version
```

如果 Node.js 版本低于 22，先升级 Node.js，再继续部署。

### 3.2 克隆并初始化目录

```bash
sudo mkdir -p /home/__USER__/workspace
sudo git clone __REPOSITORY_URL__ /home/__USER__/workspace/wechat-pi-bridge
sudo chown -R __USER__:__USER__ /home/__USER__/workspace/wechat-pi-bridge
cd /home/__USER__/workspace/wechat-pi-bridge
sudo mkdir -p config state state/wx-pi state/wx-pi/media sandbox/pi-work sandbox/pi-work-tg vendor/wx-bot
sudo chown -R __USER__:__USER__ config state sandbox vendor
sudo chmod 700 config state
```

初始化后的目录至少应当包含：

```text
wechat-pi-bridge/
├── app/
│   ├── db.mjs
│   ├── dispatch.mjs
│   ├── server.mjs
│   ├── telegram-bridge.mjs
│   └── ...
├── bin/
│   ├── ensure-services
│   ├── telegram-bridge
│   └── wechat-bridge
├── config/
│   ├── bindings.example.json
│   ├── telegram.example.json
│   └── wx-bot-pi.example.json
├── systemd/
│   ├── telegram-bridge.service
│   ├── wechat-bridge.service
│   └── wx-bot-pi.service
├── state/
├── vendor/
│   └── wx-bot/
└── docs/
```

### 3.3 安装 Pi coding agent

Pi 的持久化安装位置建议使用：

```text
/home/__USER__/workspace/tools/pi
```

不要把 Pi 装在 `/usr/bin` 或 `/tmp`。在本文使用的云 VM 环境中观察到 VM 重置后，系统目录中的安装内容可能丢失，而 workspace 下的数据通常仍然保留。

执行：

```bash
sudo mkdir -p /home/__USER__/workspace/tools/pi
sudo chown -R __USER__:__USER__ /home/__USER__/workspace/tools
cd /home/__USER__/workspace/tools/pi
sudo -u __USER__ npm install --prefix /home/__USER__/workspace/tools/pi --ignore-scripts
sudo chmod 755 /home/__USER__/workspace/tools/pi/bin/pi
```

验证：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ /home/__USER__/workspace/tools/pi/bin/pi --list-models < /dev/null
```

如果你的 Pi 安装方式生成的可执行文件路径不同，需要同步修改 `config/bindings.json` 中的 `pi_bin` 和 systemd 服务中的路径。

### 3.4 下载并安装 wx-bot

`wx-bot` 是负责 iLink 协议通信的独立二进制程序。本文桥接代码不实现微信协议，而是通过它接收和发送消息。

项目参考地址：

```text
https://github.com/lawrencewzen/wx-bot
```

请在该项目的 Releases 页面下载与你的系统和架构匹配的版本，例如 Linux x86_64。不要把源码压缩包直接当成可执行文件使用。

下载后的文件假设名为 `wx-bot-linux-amd64`：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo install -d -m 755 /home/__USER__/workspace/wechat-pi-bridge/vendor/wx-bot
sudo install -m 755 /tmp/wx-bot-linux-amd64 /home/__USER__/workspace/wechat-pi-bridge/vendor/wx-bot/wx-bot
sudo /home/__USER__/workspace/wechat-pi-bridge/vendor/wx-bot/wx-bot --help
```

如果下载的是压缩包：

```bash
cd /tmp
sudo tar -xzf wx-bot-__VERSION__-linux-amd64.tar.gz
sudo install -m 755 wx-bot /home/__USER__/workspace/wechat-pi-bridge/vendor/wx-bot/wx-bot
cd /home/__USER__/workspace/wechat-pi-bridge
sudo /home/__USER__/workspace/wechat-pi-bridge/vendor/wx-bot/wx-bot --help
```

确认二进制架构：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
file vendor/wx-bot/wx-bot
```

### 3.5 创建 Telegram bot

1. 在 Telegram 中打开 `@BotFather`。
2. 执行 `/newbot`。
3. 保存 bot token。
4. 获取自己的 Telegram user ID。
5. 将 token 和 user ID 写入 `config/telegram.json`。

Telegram 语音由桥在入队前使用本地 whisper.cpp 转写，模块为 `app/telegram-transcribe.mjs`；微信语音走微信服务端转写，两条通道机制不同。Telegram 语音的依赖和降级行为见 3.6 节。

### 3.6 Telegram 语音转写依赖

Telegram 语音由 `app/telegram-transcribe.mjs` 在入队前用本地 whisper.cpp 转写。需要 `ffmpeg` 在 `PATH` 中；从 whisper.cpp 源码编译出 `whisper-cli`，放到 `~/workspace/tools/whisper.cpp/build/bin/whisper-cli`，或用 `WB_WHISPER_BIN` 指定。**编译时务必带 `-DGGML_NATIVE=OFF`（便携模式）**：默认的原生指令优化会把编译机的 CPU 指令集刻进二进制，云 VM 换宿主机后可能直接以 Illegal instruction（SIGILL）崩溃、语音转写全滅且日志里只留一句 Command failed；便携版略慢但不挑机器。将约 60 MB 的 `ggml-base-q5_1.bin` 放到仓库外，或项目内的 `models/whisper/` 目录（不要提交模型二进制），或用 `WB_WHISPER_MODEL` 指定。

转写单并发执行，只有 `MemAvailable` ≥ 300 MB 才会启动（`WB_ASR_MIN_AVAILABLE_MB` 可调），语音上限 120 秒。失败会自动降级为文字占位，不丢消息；转写结果用 sidecar 缓存，避免重复转写。

### 3.7 准备微信小号

准备一个微信小号，不要使用大号，用于通过社区 wx-bot 登录微信侧 iLink 接入。

当前实现的实测限制与风险边界：

> 风险提示：本文使用社区 wx-bot 对微信侧 iLink 协议进行第三方实现。本项目不代表微信官方 SDK、官方授权或官方背书。协议变化、风控、限流、登录失效和账号封禁风险由使用者自行承担，请使用专用小号。

- 只支持一对一私聊，不支持群聊。
- 不能主动发起对话，必须先由你发送消息。
- 连续发送约 10 条消息而没有收到回复时，可能会被限流。
- iLink 返回 `errcode=-14` 时，需要重新扫码登录。
- iLink 没有 refresh 机制。

---

## 4. Pi 配置（关键）：Muse 为执行者接通能力

Muse 设计桥接架构之后，还要把 Pi 配置成一个真正能看图、能生图、能调用 skills 的执行者。

![第四章配图](images/chapter-04.png)

### 4.1 创建 Pi 配置目录和密钥

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo mkdir -p /home/__USER__/.pi/agent /home/__USER__/.pi/agent/extensions
sudo chown -R __USER__:__USER__ /home/__USER__/.pi
sudo touch /home/__USER__/.pi/agent/.sub2api_key
sudo chmod 600 /home/__USER__/.pi/agent/.sub2api_key
sudo sh -c 'printf "%s\n" "__SUB2API_API_KEY__" > /home/__USER__/.pi/agent/.sub2api_key'
sudo chown __USER__:__USER__ /home/__USER__/.pi/agent/.sub2api_key
```

密钥文件只能由运行 Pi 的用户读取。

### 4.2 `~/.pi/agent/models.json` 完整示例

创建 `/home/__USER__/.pi/agent/models.json`：

```json
{
  "providers": {
    "sub2api": {
      "api": "openai-completions",
      "apiKey": "!cat /home/__USER__/.pi/agent/.sub2api_key",
      "baseUrl": "https://__YOUR_SUB2API_HOST__/v1",
      "models": [
        {
          "id": "gpt-6.1-sol",
          "name": "GPT 6.1 Sol",
          "input": [
            "text",
            "image"
          ],
          "reasoning": true,
          "thinkingLevelMap": {
            "xhigh": "xhigh"
          },
          "contextWindow": 200000,
          "maxTokens": 32768
        }
      ]
    },
    "sub2api-img": {
      "api": "openai-images",
      "apiKey": "!cat /home/__USER__/.pi/agent/.sub2api_key",
      "baseUrl": "https://__YOUR_SUB2API_HOST__/v1",
      "models": [
        {
          "id": "gpt-image-1",
          "name": "GPT Image 1",
          "input": [
            "text",
            "image"
          ],
          "reasoning": true,
          "thinkingLevelMap": {
            "xhigh": "xhigh"
          },
          "output": [
            "image"
          ]
        },
        {
          "id": "gpt-image-1.5",
          "name": "GPT Image 1.5",
          "input": [
            "text",
            "image"
          ],
          "reasoning": true,
          "thinkingLevelMap": {
            "xhigh": "xhigh"
          },
          "output": [
            "image"
          ]
        },
        {
          "id": "gpt-image-2",
          "name": "GPT Image 2",
          "input": [
            "text",
            "image"
          ],
          "reasoning": true,
          "thinkingLevelMap": {
            "xhigh": "xhigh"
          },
          "output": [
            "image"
          ]
        },
        {
          "id": "gpt-image-2.5-flare",
          "name": "GPT Image 2.5 Flare",
          "input": [
            "text",
            "image"
          ],
          "reasoning": true,
          "thinkingLevelMap": {
            "xhigh": "xhigh"
          },
          "output": [
            "image"
          ]
        },
        {
          "id": "gpt-image-2.5-sunburst",
          "name": "GPT Image 2.5 Sunburst",
          "input": [
            "text",
            "image"
          ],
          "reasoning": true,
          "thinkingLevelMap": {
            "xhigh": "xhigh"
          },
          "output": [
            "image"
          ]
        }
      ]
    }
  }
}
```

> **必须保留这些字段：** `models.json` 中每个模型都要声明 `"input": ["text", "image"]`、`"reasoning": true` 和 `"thinkingLevelMap": {"xhigh": "xhigh"}`。否则 `xhigh` 会静默不生效（Pi 不会发送 `reasoning_effort`），图片也会被当作纯文本丢弃。不同 Pi 版本对图片 provider 的注册方式可能不同。本文使用的图片 provider 还需要通过 Pi extension 注册；上面的 `sub2api-img` 部分用于完整表达图片模型和输入输出能力，实际运行时请同时安装项目配套的 `sub2api-images` provider extension。

校验 JSON：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ node -e 'JSON.parse(require("fs").readFileSync("/home/__USER__/.pi/agent/models.json")); console.log("models.json OK")'
```

### 4.3 `~/.pi/agent/settings.json` 完整示例

创建 `/home/__USER__/.pi/agent/settings.json`：

```json
{
  "defaultModel": "sub2api/gpt-6.1-sol",
  "defaultThinkingLevel": "xhigh",
  "defaultProvider": "sub2api",
  "sessionDir": "/home/__USER__/.pi/agent/sessions",
  "extensions": [
    "/home/__USER__/.pi/agent/extensions/sub2api-images.ts"
  ]
}
```

创建会话目录：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo mkdir -p /home/__USER__/.pi/agent/sessions
sudo chown -R __USER__:__USER__ /home/__USER__/.pi/agent/sessions
```

### 4.4 图片 provider extension

将项目中或 Pi 环境中的图片 provider extension 放到：

```text
/home/__USER__/.pi/agent/extensions/sub2api-images.ts
```

该 extension 需要：

- 注册 provider `sub2api-img`。
- 注册 `gpt-image-1`、`gpt-image-1.5`、`gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。
- 调用 OpenAI 兼容的 `/images/generations` 接口。
- 将图片结果转换成 Pi 可发送的图片输出。

本文默认使用：

```text
sub2api-img/gpt-image-2.5-sunburst
```

### 4.5 最大坑：`input` 声明

Pi 的 `--print` 模式支持通过 `@图片路径` 传入图片。但如果 `models.json` 没有为文本模型声明：

```json
"input": ["text", "image"]
```

Pi 可能会把模型当成纯文本模型，静默丢弃图片，随后回复“我看不见图”。

验证模型能力：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ /home/__USER__/workspace/tools/pi/bin/pi --list-models < /dev/null
```

验证图片输入：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ /home/__USER__/workspace/tools/pi/bin/pi \
  --print \
  --model sub2api/gpt-6.1-sol \
  --session-id verify-image \
  @/home/__USER__/path/to/test-image.jpg \
  "请描述这张图片。" \
  < /dev/null
```

### 4.6 调用方式

文字对话：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ /home/__USER__/workspace/tools/pi/bin/pi \
  --print \
  --session-id pi-sean \
  "你好，请回复已收到。" \
  < /dev/null
```

带图片：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ /home/__USER__/workspace/tools/pi/bin/pi \
  --print \
  --session-id pi-sean \
  @/home/__USER__/path/to/image.jpg \
  "请描述这张图片。" \
  < /dev/null
```

**必须保留 `< /dev/null`**。如果不重定向 stdin，Pi 可能挂起等待输入。

### 4.7 Skills

本文使用的图片类 skills：

- `punk-cover`：封面和海报生成。
- `punk-avatar`：头像生成。
- `punk-ip-video-cover`：人物视频封面生成。

安装 skills 后，检查目录：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo find /home/__USER__/.pi/agent/skills -maxdepth 2 -name SKILL.md -print
```

Muse 负责搭建能力库，Pi 负责在收到请求时判断是否调用对应 skill。

---

## 5. Telegram 通道搭建：Muse 派 Pi 接管第二个入口

![第五章配图](images/chapter-05.png)

### 5.1 创建 `config/telegram.json`

复制示例配置：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo cp config/telegram.example.json config/telegram.json
sudo chown __USER__:__USER__ config/telegram.json
sudo chmod 600 config/telegram.json
```

`config/telegram.json` 完整示例：

```json
{
  "_comment": "敏感值请替换为真实值；代理和密钥按你自己的环境填。不要提交到 Git。",
  "telegram": {
    "allowed_user_ids": [
      "__YOUR_TELEGRAM_USER_ID__"
    ],
    "api_base": "https://api.telegram.org",
    "debounce_ms": 2500,
    "muse_bot_token": "__YOUR_MUSE_BOT_TOKEN__",
    "pi_bot_token": "__YOUR_PI_BOT_TOKEN__",
    "poll_timeout_secs": 30
  }
}
```

本项目当前的 Pi Telegram bridge 至少需要：

- `pi_bot_token`
- `allowed_user_ids`
- `api_base`
- `debounce_ms`
- `poll_timeout_secs`

`muse_bot_token` 为双 bot 架构预留；如果当前版本不启用 Muse bot，也不要删除字段。

校验：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ node -e 'const x=require("./config/telegram.json"); if(!x.telegram.pi_bot_token || x.telegram.pi_bot_token.includes("__")) process.exit(1); console.log("telegram.json OK")'
```

### 5.2 消息流程

```text
getUpdates → 白名单校验 → SQLite inbox → debounce 2.5 秒
→ Pi（--session-id telegram-pi-sean）→ sendMessage / sendPhoto
```

`telegram-bridge.mjs` 在单个 Node 进程中完成：

1. Telegram `getUpdates` 长轮询。
2. 白名单检查。
3. 消息写入 SQLite。
4. debounce 合并连续消息。
5. 调用 Pi。
6. 发送文字或图片结果。
7. 定期清理过期记录。

### 5.3 Telegram systemd 服务完整内容

保存为：

```text
/home/__USER__/workspace/wechat-pi-bridge/systemd/telegram-bridge.service
```

```ini
[Unit]
Description=Telegram bridge - Pi bot poller and dispatcher
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/home/__USER__/workspace/wechat-pi-bridge

# Pi 按 HOME 查找 ~/.pi/agent 配置
Environment=HOME=/home/__USER__
Environment=WB_HOME=/home/__USER__/workspace/wechat-pi-bridge
Environment=WB_TG_CONFIG=/home/__USER__/workspace/wechat-pi-bridge/config/telegram.json

# Node.js 22+ 代理支持
Environment=NODE_USE_ENV_PROXY=1
Environment=NODE_OPTIONS=--max-old-space-size=128

# 代理/密钥按你自己的环境填
Environment=HTTPS_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=HTTP_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=ALL_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=https_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=http_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=all_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__

Environment=NO_PROXY=localhost,127.0.0.1,::1
Environment=no_proxy=localhost,127.0.0.1,::1

# 如果你的环境提供 CA 文件，填入实际路径；没有则删除下面两行
Environment=NODE_EXTRA_CA_CERTS=__NODE_EXTRA_CA_CERTS_PATH__
Environment=SSL_CERT_FILE=__SSL_CERT_FILE_PATH__

ExecStart=/usr/bin/node --max-old-space-size=128 /home/__USER__/workspace/wechat-pi-bridge/app/telegram-bridge.mjs
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
MemoryMax=512M
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

如果 `node` 不在 `/usr/bin/node`，先执行：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo command -v node
```

再将 `ExecStart` 中的路径改为实际路径。

> **关于运行用户**：本文三个服务的 unit 示例都以 `User=root` 运行，与生产部署一致。原设计是专用低权限用户，但本文使用的云 VM 将 `/home` 挂载为受限 overlay：`chown` 被拒绝、非 root 用户连家目录都无法进入，而只有家目录能跨 VM 重置保留，服务换成非 root 用户会直接全灭。如果你的平台允许专用用户访问部署目录，建议把 `User=`/`Group=` 改回该用户。
>
> 另注意：`StartLimitIntervalSec` / `StartLimitBurst` 属于 `[Unit]` 段，写进 `[Service]` 段会被 systemd 忽略并输出警告，本文示例已放在 `[Unit]` 段。

---

## 6. 微信通道搭建：Muse 接入第三方 wx-bot 通道，Pi 执行消息任务

![第六章配图](images/chapter-06.png)

### 6.1 创建 `config/wx-bot-pi.json`

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo cp config/wx-bot-pi.example.json config/wx-bot-pi.json
sudo chown __USER__:__USER__ config/wx-bot-pi.json
sudo chmod 600 config/wx-bot-pi.json
```

完整示例：

```json
{
  "bindings": [
    {
      "allow_wxids": [
        "__YOUR_WECHAT_WXID__"
      ],
      "delivery": "webhook",
      "name": "pi",
      "webhook": {
        "key": "env:WXBOT_PI_WEBHOOK_KEY",
        "key_header": "Authorization",
        "key_prefix": "Bearer ",
        "url": "http://127.0.0.1:18791/webhook/pi"
      }
    }
  ],
  "local_api": {
    "listen": "127.0.0.1:18792",
    "token": "__LOCAL_API_TOKEN__"
  },
  "media_dir": "/home/__USER__/workspace/wechat-pi-bridge/state/wx-pi/media",
  "state_dir": "/home/__USER__/workspace/wechat-pi-bridge/state/wx-pi"
}
```

如果扫码后才知道微信 ID，可以先将 `allow_wxids` 留空数组：

```json
"allow_wxids": []
```

然后在第一次登录和收到消息后，根据日志补填白名单。

### 6.2 创建 `config/bindings.json`

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo cp config/bindings.example.json config/bindings.json
sudo chown __USER__:__USER__ config/bindings.json
sudo chmod 600 config/bindings.json
```

完整示例：

```json
{
  "_comment": "微信桥接绑定配置。敏感值请替换；代理/密钥按你自己的环境填。",
  "bindings": {
    "pi": {
      "authorized_principal": "__YOUR_NAME__",
      "channel": "wechat",
      "chat_kind": "self_chat",
      "conversation_id": "__WECHAT_CONVERSATION_ID__",
      "delivery": "webhook",
      "listen": "127.0.0.1:18791",
      "pi_bin": "/home/__USER__/workspace/tools/pi/bin/pi",
      "pi_timeout_ms": 600000,
      "pi_workdir": "/home/__USER__/workspace/wechat-pi-bridge/sandbox/pi-work",
      "recipient_id": "__WECHAT_RECIPIENT_ID__",
      "sender_id": "__WECHAT_SENDER_ID__",
      "webhook_secret": "__OPTIONAL_RANDOM_32_BYTE_HEX__",
      "webhook_token": "__RANDOM_32_BYTE_HEX__",
      "wxbot_config": "/home/__USER__/workspace/wechat-pi-bridge/config/wx-bot-pi.json"
    }
  },
  "debounce_ms": 2500,
  "max_batch_bytes": 200000,
  "max_batch_messages": 20,
  "webhook_body_limit_bytes": 1048576
}
```

> ⚠️ **webhook 密钥三处必须一致（最容易踩的坑）**：先用 `openssl rand -hex 32` 生成一个值，然后原样填到三处：
>
> 1. 本节 `config/bindings.json` 的 `bindings.pi.webhook_token`
> 2. 6.4 的 `wechat-bridge.service` 中 `Environment=WXBOT_PI_WEBHOOK_KEY=`
> 3. 6.5 的 `wx-bot-pi.service` 中 `Environment=WXBOT_PI_WEBHOOK_KEY=`（wx-bot 通过 `wx-bot-pi.json` 里的 `"key": "env:WXBOT_PI_WEBHOOK_KEY"` 读取）
>
> 任意一处不一致，wx-bot 的 webhook 投递会被桥以 401 拒绝，微信消息会静默堆积在 wx-bot 的重试队列里。首次部署和每次恢复（看门狗重装 unit）时都要核对。

### 6.3 iLink 扫码登录

使用社区 wx-bot 接入微信侧 iLink 接口：

1. 运行 wx-bot 的登录命令。
2. 终端显示二维码。
3. 使用微信小号扫码确认。
4. 保存 wx-bot 生成的状态文件和 token。
5. 将收到的微信 ID 填入 `wx-bot-pi.json` 的 `allow_wxids`。
6. 将会话信息填入 `bindings.json`。

实际登录命令以你下载的 wx-bot 版本帮助为准：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo /home/__USER__/workspace/wechat-pi-bridge/vendor/wx-bot/wx-bot --help
```

常见形式为：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo /home/__USER__/workspace/wechat-pi-bridge/vendor/wx-bot/wx-bot login --config /home/__USER__/workspace/wechat-pi-bridge/config/wx-bot-pi.json
```

如果当前版本不支持 `login` 子命令，请以该版本 `--help` 输出为准。登录时请确保状态目录对运行服务的用户可读写。

### 6.4 微信桥接 systemd 服务完整内容

保存为：

```text
/home/__USER__/workspace/wechat-pi-bridge/systemd/wechat-bridge.service
```

```ini
[Unit]
Description=WeChat bridge - Pi webhook and dispatcher
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/home/__USER__/workspace/wechat-pi-bridge

Environment=HOME=/home/__USER__
Environment=WB_HOME=/home/__USER__/workspace/wechat-pi-bridge
Environment=NODE_USE_ENV_PROXY=1
Environment=NODE_OPTIONS=--max-old-space-size=128

# 代理/密钥按你自己的环境填
Environment=WXBOT_PI_WEBHOOK_KEY=__RANDOM_32_BYTE_HEX__
Environment=HTTPS_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=HTTP_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=ALL_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=https_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=http_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=all_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__

Environment=NO_PROXY=localhost,127.0.0.1,::1
Environment=no_proxy=localhost,127.0.0.1,::1

# 如果你的环境提供 CA 文件，填入实际路径；没有则删除下面两行
Environment=NODE_EXTRA_CA_CERTS=__NODE_EXTRA_CA_CERTS_PATH__
Environment=SSL_CERT_FILE=__SSL_CERT_FILE_PATH__

ExecStart=/home/__USER__/workspace/wechat-pi-bridge/bin/wechat-bridge
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

### 6.5 wx-bot systemd 服务完整内容

保存为：

```text
/home/__USER__/workspace/wechat-pi-bridge/systemd/wx-bot-pi.service
```

```ini
[Unit]
Description=wx-bot iLink bridge - Pi binding
After=network-online.target wechat-bridge.service
Wants=network-online.target
BindsTo=wechat-bridge.service
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/home/__USER__/workspace/wechat-pi-bridge

Environment=HOME=/home/__USER__
Environment=WB_HOME=/home/__USER__/workspace/wechat-pi-bridge
Environment=NODE_USE_ENV_PROXY=1
Environment=NODE_OPTIONS=--max-old-space-size=128
Environment=WXBOT_PI_WEBHOOK_KEY=__RANDOM_32_BYTE_HEX__

# 代理/密钥按你自己的环境填
Environment=HTTPS_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=HTTP_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=ALL_PROXY=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=https_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=http_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__
Environment=all_proxy=http://__PROXY_USER__:__PROXY_PASSWORD__@__PROXY_HOST__:__PROXY_PORT__

Environment=NO_PROXY=localhost,127.0.0.1,::1
Environment=no_proxy=localhost,127.0.0.1,::1

# 如果你的环境提供 CA 文件，填入实际路径；没有则删除下面两行
Environment=NODE_EXTRA_CA_CERTS=__NODE_EXTRA_CA_CERTS_PATH__
Environment=SSL_CERT_FILE=__SSL_CERT_FILE_PATH__

ExecStart=/home/__USER__/workspace/wechat-pi-bridge/vendor/wx-bot/wx-bot \
  --config /home/__USER__/workspace/wechat-pi-bridge/config/wx-bot-pi.json \
  run
Restart=always
RestartSec=5
TimeoutStopSec=15
KillMode=control-group
MemoryMax=256M

[Install]
WantedBy=multi-user.target
```

### 6.6 语音消息

两条通道的语音机制不同：Telegram 由 `app/telegram-transcribe.mjs` 在本地用 whisper.cpp 转写，微信由微信服务端转写。Telegram 的安装、内存门槛、时长上限和失败降级见 3.6 节。

微信服务端会将转写内容放在：

```text
voice_item.text
```

桥接层需要把普通文字和语音转写合并：

```js
const body = [
  text,
  voiceText ? `[语音转写]${voiceText}` : ''
].filter(Boolean).join('\n');
```

微信通道不需要额外安装 Whisper 或本地 ASR；Telegram 通道需要按 3.6 节准备 whisper.cpp 和模型。

---

## 7. 看门狗：Muse 为 Pi 的执行环境兜底

![第七章配图](images/chapter-07.png)

### 7.1 为什么需要看门狗

在本文使用的云 VM 环境中观察到 VM 会周期性重置。重置后可能出现：

- `/etc/` 下的 systemd unit 丢失。
- 所有正在运行的进程被终止。
- workspace 下的 SQLite、配置和媒体文件仍然保留。

看门狗的职责是重新安装并启动：

- `wechat-bridge.service`
- `telegram-bridge.service`
- `wx-bot-pi.service`

会话本身也需要体积治理：Pi 会话里的图片会在每轮对话被重发并被模型重看，图片积累后请求会膨胀到被中转以 503 拒绝；实测 24 MB 请求带着 5 张图，约 38 秒后返回 503。本桥每轮结束后把旧轮次图片在会话文件中降清为 512px 缩略图，最新一轮保留原图，Pi 仍能认出图片内容；会话文件超过 10 MB 自动轮换新会话，旧文件留档。聊天里发送“新会话”也可以手动轮换。

### 7.2 验证恢复脚本

脚本位置：

```text
/home/__USER__/workspace/wechat-pi-bridge/bin/ensure-services
```

如果脚本中写死了其他用户名或目录，先修改：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo vi bin/ensure-services
```

确保：

```bash
sudo chmod 755 /home/__USER__/workspace/wechat-pi-bridge/bin/ensure-services
```

手动执行：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo /home/__USER__/workspace/wechat-pi-bridge/bin/ensure-services
```

检查服务：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo systemctl is-active wechat-bridge.service
sudo systemctl is-active telegram-bridge.service
sudo systemctl is-active wx-bot-pi.service
```

### 7.3 cron 完整配置

编辑当前用户的 cron：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ crontab -e
```

加入：

```cron
*/5 * * * * cd /home/__USER__/workspace/wechat-pi-bridge && /usr/bin/sudo /home/__USER__/workspace/wechat-pi-bridge/bin/ensure-services >> /home/__USER__/workspace/wechat-pi-bridge/state/watchdog.log 2>&1
```

如果平台托管 cron 已经以 root 身份执行，则使用：

```cron
*/5 * * * * cd /home/__USER__/workspace/wechat-pi-bridge && /home/__USER__/workspace/wechat-pi-bridge/bin/ensure-services >> /home/__USER__/workspace/wechat-pi-bridge/state/watchdog.log 2>&1
```

验证 cron：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo -u __USER__ crontab -l
sudo tail -n 50 /home/__USER__/workspace/wechat-pi-bridge/state/watchdog.log
```

### 7.4 恢复逻辑

```text
每 5 分钟
    ↓
检查 /etc/systemd/system/*.service 是否存在
    ↓
缺失则从 workspace/systemd/ 复制
    ↓
systemctl daemon-reload
    ↓
检查三个服务是否 active
    ↓
未运行则 enable --now
```

在本文使用的云 VM 环境中观察到，服务通常可以在 5 分钟内自动恢复。重置期间遗漏的消息则依靠数据库游标补收。

---

## 8. 测试验证清单：Muse 验收，Pi 执行

![第8章配图](images/chapter-08.png)

### 8.1 安装和配置验收

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo node --version
sudo test -x vendor/wx-bot/wx-bot
sudo test -x /home/__USER__/workspace/tools/pi/bin/pi
sudo test -r config/telegram.json
sudo test -r config/bindings.json
sudo test -r config/wx-bot-pi.json
sudo systemctl daemon-reload
```

### 8.2 首次运行顺序

首次部署必须按以下顺序执行：

1. 安装 Node.js 22+。
2. 初始化项目目录。
3. 下载并放置 `wx-bot` 二进制。
4. 安装 Pi。
5. 创建 Pi 的 `models.json` 和 `settings.json`。
6. 创建三个项目配置文件。
7. 创建 state、media 和 Pi work 目录。
8. 配置代理、API key 和 systemd 环境变量。
9. 运行 wx-bot 登录命令并扫码。
10. 将微信 ID 和会话信息填入配置。
11. 手动启动 `wx-bot-pi`。
12. 手动启动 `wechat-bridge`。
13. 手动启动 `telegram-bridge`。
14. 先测试文字，再测试图片，最后测试生图。
15. 启用 cron 看门狗。

### 8.3 安装 systemd units

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo cp systemd/wechat-bridge.service /etc/systemd/system/wechat-bridge.service
sudo cp systemd/telegram-bridge.service /etc/systemd/system/telegram-bridge.service
sudo cp systemd/wx-bot-pi.service /etc/systemd/system/wx-bot-pi.service
sudo chmod 644 /etc/systemd/system/wechat-bridge.service
sudo chmod 644 /etc/systemd/system/telegram-bridge.service
sudo chmod 644 /etc/systemd/system/wx-bot-pi.service
sudo systemctl daemon-reload
```

### 8.4 启动顺序

先启动 wx-bot，再启动微信桥接，最后启动 Telegram：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo systemctl enable --now wx-bot-pi.service
sudo systemctl enable --now wechat-bridge.service
sudo systemctl enable --now telegram-bridge.service
```

检查状态：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo systemctl status wx-bot-pi.service --no-pager
sudo systemctl status wechat-bridge.service --no-pager
sudo systemctl status telegram-bridge.service --no-pager
```

查看日志：

```bash
cd /home/__USER__/workspace/wechat-pi-bridge
sudo journalctl -u wx-bot-pi.service -n 100 --no-pager
sudo journalctl -u wechat-bridge.service -n 100 --no-pager
sudo journalctl -u telegram-bridge.service -n 100 --no-pager
```

### 8.5 功能验收清单

- [ ] 微信发送“你好”，Pi 返回文字回复。
- [ ] Telegram 发送“你好”，Pi 返回文字回复。
- [ ] 微信发送照片并询问“这是什么”，Pi 能描述图片内容。
- [ ] Telegram 发送照片并询问“这是什么”，Pi 能描述图片内容。
- [ ] Telegram 发送“生成一张海报”，Pi 生成图片并自动发回。
- [ ] 微信发送“新会话”，再继续聊天，确认记忆已清空。
- [ ] 先在微信聊 A 话题，再切换到 Telegram 聊 B 话题，确认记忆不串。
- [ ] 手动终止服务，等待最多 5 分钟，确认看门狗将其重新拉起。
- [ ] 查看 SQLite 和日志，确认没有重复消费同一条消息。

Telegram 语音转写按 3.6 节准备依赖后纳入验收；微信语音仍由微信服务端转写。

---

## 9. 常见坑汇总：Muse 的审稿与排障清单

![第9章配图](images/chapter-09.png)

| 坑 | 现象 | 根因 | 解法 | 怎么确认踩坑了 | 怎么确认修好了 |
|----|------|------|------|----------------|----------------|
| Pi 看不见图 | Pi 回复“我无法查看这张图片” | `models.json` 缺少 `"input": ["text", "image"]` | 给文本模型补上图片输入声明 | 用 `--print @图片路径` 测试，日志中没有有效图片输入 | Pi 能描述测试图片，且日志显示图片参数被传入 |
| Pi 调用挂起 | 命令卡死、无输出 | `--print` 仍在等待 stdin | 命令末尾加入 `< /dev/null` | `ps` 中 Pi 进程持续存在，手动输入后才继续 | 同一命令在无交互终端中正常退出 |
| TG 收不到消息 | 日志出现 `fetch failed` | systemd 环境没有代理 | 将代理和 `NODE_USE_ENV_PROXY=1` 写进 `[Service]` | 交互式 shell 能访问 API，但 `systemctl` 服务失败 | `journalctl` 不再出现代理连接错误，bot 能收到消息 |
| Pi 找不到配置 | 报模型或配置文件错误 | systemd 的 `HOME` 不正确 | 设置 `Environment=HOME=/home/__USER__` | `systemctl show telegram-bridge -p Environment` 中没有正确 HOME | 服务日志能列出正确模型并成功调用 Pi |
| 微信发不出去 | 没有明显报错，但对方收不到 | iLink 参数或 wx-bot 状态不正确 | 检查 `from_user_id`、`message_type=2`、wx-bot token 和 recipient ID | 日志出现发送请求但微信无消息 | wx-bot 日志显示发送成功，微信收到回复 |
| 微信 token 失效 | 所有微信消息突然没有回复 | iLink 返回 `errcode=-14` | 重新扫码登录；iLink 没有 refresh 机制 | 日志中出现 `errcode=-14` | 重新扫码后收到新消息，日志恢复正常 |
| wx-bot 找不到 | systemd 启动失败，提示 No such file | 二进制未下载、路径错误或无执行权限 | 放到 `vendor/wx-bot/wx-bot` 并执行 `chmod 755` | `test -x vendor/wx-bot/wx-bot` 失败 | `wx-bot --help` 正常输出，systemd 为 active |
| Node 版本过低 | 语法错误、fetch 或依赖异常 | Node.js 低于项目要求 | 升级到 Node.js 22+ | `node --version` 小于 22 | `node --version` 为 22 或更高，服务正常启动 |
| 配置 JSON 错误 | 服务启动即退出 | 逗号、引号或占位值错误 | 使用 Node.js 解析 JSON | `node -e 'JSON.parse(...)'` 返回错误 | 三个 JSON 文件均输出 OK |
| 服务突然全部停止 | bot 不再回复消息 | 在本文使用的云 VM 环境中观察到 VM 被平台重置 | 使用看门狗每 5 分钟恢复 | `systemctl` unit 消失或服务为 inactive | cron 日志出现恢复记录，服务重新 active |
| 图片生成失败 | Pi 能聊天，但无法生成图片 | 图片 provider 未安装或 API endpoint 错误 | 安装 provider extension，检查 `/images/generations` 和 API key | Pi 日志显示 provider not found 或 images API 4xx/5xx | 通过 Telegram 请求生图并收到图片 |
| 内存偏高 | VM 出现内存告警 | 多进程运行且没有限制 | 使用单进程 bridge，并设置 Node heap 和 `MemoryMax` | `systemctl status` 或监控显示内存持续上涨 | 三个 unit 的内存稳定在限制内 |
| 重复回复 | 同一条消息被回复多次 | SQLite 游标、消息 ID 或服务重复运行异常 | 检查数据库去重和是否启动了多个 bridge 实例 | 日志中同一 update/message ID 多次 dispatch | 同一消息 ID 只产生一次出站记录 |
| 图片文件找不到 | Pi 收不到微信图片 | media 目录不存在或权限不对 | 创建 `state/wx-pi/media` 并让服务用户可读写 | 日志出现 ENOENT/EACCES | 图片落盘后 Pi 能读取并描述 |

排障时按以下层次定位：

1. **通道层**：微信 iLink、Telegram Bot API、token、代理。
2. **桥接层**：SQLite、debounce、媒体文件和回传逻辑。
3. **Pi 执行层**：模型输入声明、会话配置、skills、stdin。
4. **运维层**：systemd、内存限制、VM 重置和 cron。

---

## 10. 架构取舍：Muse 选择路线，Pi 承担执行

![第10章配图](images/chapter-10.png)

**为什么不用 CxxVen 的 Python 版？**

CxxVen 的方案是在 X 上获得 4 万浏览、并有多人在评论区反馈跑通的 Python 手写 iLink 协议方案，简单直接。但本文选择了 Node + 社区 wx-bot 的路线，主要原因如下：

- wx-bot 已经封装了 iLink 协议细节，不需要自行拼接 header。
- SQLite 可以同时承担去重、防止重复发送、debounce 和会话持久化。
- 图片双向传输和“新会话”命令可以较方便地扩展到桥接服务中。
- systemd 和 cron 适合将桥接服务作为长期运行的基础设施。

简单来说：**CxxVen 的方案适合快速搭起来验证，本文方案更适合长期运行和持续扩展**。两条路线使用的 iLink 通道和看门狗思路是相通的。

更重要的是，这个项目展示的并不只是某个微信接入技巧，而是一种可以复用的协作范式：

- Muse 负责动脑：明确目标、设计架构、写桥接代码、部署服务、处理故障、建立恢复机制，并对最终结果审稿。
- Pi 负责干活：处理日常对话、看图、生成图片，并按上下文自主调取 skills。
- 桥接层负责传令：把微信和 Telegram 的消息转换成 Pi 能执行的任务，再把结果送回用户。
- 看门狗负责兜底：即使运行环境出现重置，也尽量让整个协作系统自动恢复。

这套“**Muse 动脑、Pi 干活**”的分工模式并不局限于微信和 Telegram。换一个入口和业务逻辑，就可以扩展到：

- **代购监控**：Muse 设计价格追踪、库存检测和通知架构，Pi 负责读取页面信息、判断商品变化并生成提醒。
- **内容生成**：Muse 设计选题、审核和发布流程，Pi 负责根据素材生成标题、摘要、配图和不同平台版本。
- **数据分析**：Muse 负责定义指标、搭建数据管道和验证结果，Pi 负责整理数据、解释趋势并生成报告。
- **客服与工单**：Muse 设计渠道接入、权限、记忆和升级规则，Pi 负责一线问答和工单分类。
- **个人自动化**：Muse 把复杂任务拆成可恢复的工作流，Pi 负责在每个节点执行具体操作。

最终，Muse × Pi 的价值不在于“让一个 AI 包办所有事情”，而在于让不同 AI 的优势形成清晰分工：

> **Muse 负责把问题变成系统，Pi 负责把系统变成行动。**

---

*教程版本：2026-10-11 · 基于真实跑通的系统整理*  
*实测限制：微信小号、一对一私聊、不能主动发起对话；iLink 返回 `-14` 时需要重新扫码*  
*事实边界：微信语音由微信服务端转写，Telegram 语音由本地 whisper.cpp 转写；两条通道机制不同。VM 重置描述为“在本文使用的云 VM 环境中观察到”。*
