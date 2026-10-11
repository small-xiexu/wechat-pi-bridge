# systemd units - templates, NOT installed

These three units are templates. Installing and enabling them is a deploy-time
step owned by the main agent + user (requires QR scan first).

| unit | what | needs |
|---|---|---|
| `wechat-bridge.service` | Node webhook server (pi binding) + dispatcher | `config/bindings.json` (600), QR-scanned wx-bot-pi state |
| `wx-bot-muse.service` | wx-bot process, binding `muse` (pull) | `config/wx-bot-muse.json` (600), QR scan with 小号A |
| `wx-bot-pi.service` | wx-bot process, binding `pi` (webhook) | `config/wx-bot-pi.json` (600), QR scan with 小号B, webhook key env |

Security: `User=hatch` here is a migration placeholder (TECH_PLAN v3.1 §2.4).
Production must use dedicated low-privilege users for bridge vs agent workers,
plus `ProtectSystem=strict`, `ReadWritePaths` allowlists, and cgroup limits.
Do not widen these units without re-running the security gates.

Install sketch (deploy time, main agent):
```
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wechat-bridge.service wx-bot-muse.service wx-bot-pi.service
```
