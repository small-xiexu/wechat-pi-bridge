# X 发布文案（Thread）

> 配图建议：都在 images/ 目录
> 1/ 配视频：微信对话屏录（主视觉）images/wechat-demo-trimmed.mp4（18 秒剪辑版，原片 68 秒：打字加速、两段等待已掐掉、静音），不再用 AI 封面图
> 2/ 架构图 chapter-02.png
> 3/ Pi 配置图 chapter-04.png
> 5/ 微信流转图 chapter-06.png
> 6/ TG 流转图 chapter-05.png
> 7/ 看门狗图 chapter-07.png
> 仓库链接不放正文，发完 thread 后自己在评论区补（见文末）

---

**1/** 🧵 Muse 负责托付、Pi 负责干活：我把微信和 TG 外包给了 AI。

全网首发：第一个讲透「Muse 架构 + Pi 执行」分工的微信/TG 双通道实战，代码开源、真机录屏都在。

TL;DR：Muse 搭桥 + Pi 执行，微信/TG 双通道，文字/图片/语音/生图全通，代码开源可复刻。

"ChatGPT 适合查询，Muse 适合托付"——我把微信和 Telegram 的日常聊天整个托付出去：Muse 做架构师（设计、搭桥、部署、自愈），Pi 做执行者（聊天、看图、生图）。发文字秒回、发照片它能看懂、微信语音自动转文字。

[配视频：images/wechat-demo-trimmed.mp4]

---

**2/** 架构其实很简单（全部部署在 Muse 提供的云 VM 上）：

微信小号 → iLink 协议（社区 wx-bot 第三方客户端）→ 桥接服务 → Pi
TG bot → Bot API 轮询 → bridge → Pi

Muse 是建筑师，Pi 是住户。这套 bridge、看门狗和 SQLite 流程由 Muse 辅助搭建，Pi 负责模型调用、会话处理和生图。

消息先进 SQLite（去重、防双发），debounce 2.5s 打包后交给 Pi，Pi 回文字直接发、回图片走发图接口。

微信和 TG 各用独立会话，记忆隔离。

[配图：chapter-02.png]

---

**3/** 先说最大的坑：Pi 一开始"看不见图"。

`pi --print @图片` 传了图，Pi 却回"我看不见"。查源码发现图片确实进了会话，真正原因是 `models.json` 里没给模型声明 `"input": ["text", "image"]`。

在我用的 Pi 版本和这套模型配置下，缺了这个声明 Pi 会静默把图丢了。补上后立刻就能看图。

[配图：chapter-04.png]

---

**4/** 模型这边我是这么配的：

- 聊天/看图：gpt-6.1-sol，xhigh 推理
- 生图：gpt-image-2.5-sunburst
- Skills：punk-cover / punk-avatar / punk-ip-video-cover，Pi 自主调用

调用注意：`pi --print` 从程序调必须 `< /dev/null` 关 stdin，否则挂起等输入。这个坑了我半小时。

---

**5/** 微信这边，走的是 iLink 协议 + 社区 wx-bot 第三方客户端。

小号扫码登录，wx-bot 跑长轮询，webhook 转给桥接服务。图片 wx-bot 会落盘，桥查到路径以 @file 传 Pi。

实测限制：一对一私聊、不支持群、不能主动发起对话、token 失效（errcode=-14）要重新扫码。

[配图：chapter-06.png]

---

**6/** TG 这边就简单了，标准 Bot API。

`getUpdates` 长轮询 + 白名单（只允许自己）。照片自动下载，`sendPhoto` 发图。

之前还接了个 Muse 的 TG bot，后来发现用处不大，砍了——只留 Pi，一个 bot 就够。

[配图：chapter-05.png]

---

**7/** 再说个头疼的：这类云 VM 上观察到周期性重置（约每小时一次），/etc 的 systemd unit 全丢、进程全杀。

解法：每 5 分钟的 cron 看门狗，跑幂等恢复脚本，unit 缺失就补、服务挂了就拉。~/ 数据完好，漏掉的消息靠 DB 游标补收。

实测重置后 5 分钟内自愈。这也是 @CxxVen 配方里的标准做法。

[配图：chapter-07.png]

---

**8/** 剩下的坑，快速过一遍：

- systemd 代理必须写 [Service] 段，写 [Install] 下会被静默忽略 → fetch failed
- HOME 要显式设，Pi 按 HOME 找配置
- 内存：单进程 + --max-old-space-size=128，从 165MB 压到 84MB
- "新会话"命令：发这三个字清空当前通道记忆

另外，实现思路参考了 @CxxVen 的微信接入配方和 @Liu_zhongxisn 的开源项目，感谢两位的分享，帮我少走了不少弯路。

---

**9/** 最后看效果：微信发照片问"这是什么"，Pi 直接描述；TG 说"生成一张国庆海报"，图自动发回来；随手发张图让它看，它也能看懂了再跟你细聊。

完整教程 + 全部代码已开源，仓库链接我放评论区了 👇

你最想把什么事托付给 AI？欢迎交流，一起把 AI 接进日常聊天里 🚀

---

## 评论区首条（发完 thread 后自己回复）

仓库在这：https://github.com/small-xiexu/wechat-pi-bridge

完整教程在仓库 docs/tutorial.md，照着做能复刻，卡住评论区问我。
