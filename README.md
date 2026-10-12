# wechat-pi-bridge

**Muse 负责托付、Pi 负责干活：我把微信和 TG 外包给了 AI。**

微信 + Telegram 双通道接入 Pi AI 助手。在微信和 Telegram 里直接跟你的 AI 助手聊天：发文字、发图片、语音转写、AI 生图，全都行。Muse 做架构师（设计、搭桥、部署、自愈），Pi 做执行者（聊天、看图、生图）。

## 功能

- **微信通道**：基于社区 wx-bot 的第三方 iLink 协议接入，文字/图片/语音双向
- **Telegram 通道**：Bot API，文字/图片双向
- **Pi 集成**：持久会话、skills 自主调用、私有模型
- **语音转写**：微信语音由微信服务端转写；Telegram 语音由桥在本地用 whisper.cpp 转写
- **AI 生图**：Pi 生成图片自动发回
- **会话隔离**：微信/TG 记忆独立，"新会话"一键清空
- **会话治理**：历史轮次图片自动降为 512px 缩略图，最新一轮保留原图；会话文件超过 10MB 自动轮换，旧文件留档。图片会在每轮重发并被模型重看，实测 24MB 请求带 5 张图会在约 38 秒后被中转以 503 拒绝。
- **看门狗**：云 VM 重置后 5 分钟内自动恢复

## 架构

```
微信 → iLink → wx-bot → bridge → SQLite → Pi → 发回微信
TG   → BotAPI → bridge → SQLite → Pi → 发回 TG
                                    ↓
                          看门狗 cron（自愈）
```

详见 [完整教程](docs/tutorial.md)。

## 快速开始

### 1. 准备

- Node.js 22+
- Pi coding agent（https://github.com/... ）
- 微信小号（不要用大号）
- Telegram bot（@BotFather 创建）

### 2. 准备 Telegram 语音转写依赖

Telegram 语音由 `app/telegram-transcribe.mjs` 在入队前用本地 whisper.cpp 转写；微信语音走微信服务端转写，两条通道机制不同。需要准备：

- `ffmpeg` 必须在 `PATH` 中。
- 从 whisper.cpp 源码编译出 `whisper-cli`，放到 `~/workspace/tools/whisper.cpp/build/bin/whisper-cli`；也可用 `WB_WHISPER_BIN` 指定路径。
- 下载 `ggml-base-q5_1.bin`（约 60 MB），放到仓库外，或放在项目的 `models/whisper/` 目录（模型二进制不会提交）；也可用 `WB_WHISPER_MODEL` 指定路径。

转写在消息入队前执行，单并发运行；仅在 `MemAvailable` ≥ 300 MB 时启动（可用 `WB_ASR_MIN_AVAILABLE_MB` 调整），语音上限为 120 秒。转写失败会自动降级为文字占位，不丢消息；结果通过 sidecar 文本缓存，避免同一语音重复转写。

### 3. 安装 wx-bot

```bash
# 按 vendor/wx-bot/manifest.json 固定版本下载并校验 SHA256 后安装
./bin/install-wx-bot
# 可用 ./bin/check-deps 检查依赖是否齐全
```

### 4. 配置

```bash
cp config/telegram.example.json config/telegram.json
cp config/wx-bot-pi.example.json config/wx-bot-pi.json
cp config/bindings.example.json config/bindings.json
# 填入你的 token 和 ID（这些文件已在 .gitignore 中，不会提交）
```

### 5. 微信扫码登录

```bash
./bin/wechat-bridge login    # 终端显示二维码，微信扫码
```

### 6. 启动服务

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl enable --now telegram-bridge wechat-bridge wx-bot-pi
```

### 7. 看门狗（推荐）

```bash
# 每 5 分钟检查服务，挂了自动拉起
# 用你平台的 cron 或 systemd timer 运行：
sudo ./bin/ensure-services
```

## 配置说明

| 文件 | 说明 |
|------|------|
| `config/telegram.json` | TG bot token、白名单 user ID |
| `config/wx-bot-pi.json` | wx-bot 配置 |
| `config/bindings.json` | 通道绑定配置 |
| `~/.pi/agent/models.json` | Pi 模型配置（每个模型**必须**声明 `"input": ["text", "image"]`、`"reasoning": true`、`"thinkingLevelMap": {"xhigh": "xhigh"}`；否则图片会丢弃且 xhigh 静默不生效） |

## 常见问题

**Pi 看不见图或 xhigh 不生效？**
检查 `~/.pi/agent/models.json` 中每个模型是否声明了 `"input": ["text", "image"]`、`"reasoning": true` 和 `"thinkingLevelMap": {"xhigh": "xhigh"}`。缺少 `input` 会让图片被当作纯文本丢弃；缺少后两个字段则 Pi 不会发送 `reasoning_effort`，xhigh 会静默不生效。

**服务突然不回消息？**
云 VM 可能被平台重置。看门狗会在 5 分钟内自动恢复。

**微信 token 失效或账号被限制？**
本项目使用社区 wx-bot 的第三方 iLink 协议实现。当前实测 `errcode=-14` 表示登录态失效，需要重新扫码（该协议无 refresh 机制）；除此之外账号还可能受到微信风控、限流或封禁影响。请使用专用小号，不要使用主账号。

## 微信通道风险说明

微信接入依赖社区项目 wx-bot 对 iLink 协议的第三方实现。本项目不声称拥有微信官方 SDK、开放平台授权或官方背书。协议、接口和账号策略可能随时变化；账号可能出现限流、登录失效、风控或封禁。请使用专用微信小号，并自行确认相关服务条款与合规要求。

## 开源协议

MIT License。详见 [LICENSE](LICENSE)。

## 致谢

- iLink 接入：通过社区 wx-bot 使用第三方协议实现；不代表微信官方 SDK、官方授权或官方背书
- wx-bot：https://github.com/lawrencewzen/wx-bot
- 实现思路参考：[@CxxVen](https://x.com/cxxven) 的微信接入配方
