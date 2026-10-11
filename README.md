# wechat-pi-bridge

**微信 + Telegram 双通道接入 Pi AI 助手。**

在微信和 Telegram 里直接跟你的 AI 助手聊天：发文字、发图片、语音转写、AI 生图，全都行。Muse 负责搭桥，Pi 负责干活。

## 功能

- **微信通道**：官方 iLink Bot 通道，文字/图片/语音双向
- **Telegram 通道**：Bot API，文字/图片双向
- **Pi 集成**：持久会话、skills 自主调用、私有模型
- **语音转写**：微信语音自动转文字
- **AI 生图**：Pi 生成图片自动发回
- **会话隔离**：微信/TG 记忆独立，"新会话"一键清空
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

- Node.js 18+
- Pi coding agent（https://github.com/... ）
- 微信小号（不要用大号）
- Telegram bot（@BotFather 创建）

### 2. 安装 wx-bot

```bash
# 下载 wx-bot（iLink 协议客户端）
# https://github.com/lawrencewzen/wx-bot
cp wx-bot vendor/wx-bot/
```

### 3. 配置

```bash
cp config/telegram.example.json config/telegram.json
cp config/wx-bot-pi.example.json config/wx-bot-pi.json
cp config/bindings.example.json config/bindings.json
# 填入你的 token 和 ID（这些文件已在 .gitignore 中，不会提交）
```

### 4. 微信扫码登录

```bash
./bin/wechat-bridge login    # 终端显示二维码，微信扫码
```

### 5. 启动服务

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl enable --now telegram-bridge wechat-bridge wx-bot-pi
```

### 6. 看门狗（推荐）

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
| `~/.pi/agent/models.json` | Pi 模型配置（**必须**声明 `"input": ["text", "image"]` 才能看图） |

## 常见问题

**Pi 看不见图？**
检查 `~/.pi/agent/models.json` 是否声明了 `"input": ["text", "image"]`。不声明 Pi 会静默丢图。

**服务突然不回消息？**
云 VM 可能被平台重置。看门狗会在 5 分钟内自动恢复。

**微信 token 失效？**
iLink 返回 `errcode=-14` 时需要重新扫码（无 refresh 机制）。

## 开源协议

MIT License。详见 [LICENSE](LICENSE)。

## 致谢

- iLink 协议：微信官方开放能力
- wx-bot：https://github.com/lawrencewzen/wx-bot
- 实现思路参考：[@CxxVen](https://x.com/cxxven) 的微信接入配方
