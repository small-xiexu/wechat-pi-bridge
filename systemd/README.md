# systemd units - templates, NOT installed

These four units are templates. Installing and enabling them is a deploy-time
step owned by the main agent + user (requires QR scan first).

| unit | what | needs |
|---|---|---|
| `wechat-bridge.service` | Node webhook server (pi binding) + dispatcher | `config/bindings.json` (600), QR-scanned wx-bot-pi state |
| `telegram-bridge.service` | Telegram channel supervisor + Pi dispatch | Telegram config/tokens and bridge state |
| `wx-bot-muse.service` | wx-bot process, binding `muse` (pull) | `config/wx-bot-muse.json` (600), QR scan with 小号A |
| `wx-bot-pi.service` | wx-bot process, binding `pi` (webhook) | `config/wx-bot-pi.json` (600), QR scan with 小号B, webhook key env |

Security: every unit runs as the dedicated low-privilege `wechat-bridge`
user, with `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
`ProtectHome=read-only`, `PrivateDevices`, and explicit `ReadWritePaths`
allowlists. Do not widen these units without re-running the security gates.

## Deployment user and writable directories

On the deployment host, create the service account once, then grant it
ownership of only the runtime state, logs, sandbox, and Pi home paths. The
units use `WB_HOME=/home/hatch/workspace/wechat-pi-bridge`; if deploying under
`/opt/wechat-pi-bridge`, update every matching absolute path in the unit files
and this snippet together.

```sh
WB_HOME=/home/hatch/workspace/wechat-pi-bridge
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin wechat-bridge
sudo install -d -m 0750 -o wechat-bridge -g wechat-bridge \
  "$WB_HOME/state" "$WB_HOME/logs" "$WB_HOME/sandbox" \
  /var/lib/wechat-pi-bridge/pi-home/sessions
sudo chown -R wechat-bridge:wechat-bridge \
  "$WB_HOME/state" "$WB_HOME/logs" "$WB_HOME/sandbox" \
  /var/lib/wechat-pi-bridge/pi-home
```

Keep the repository code and configuration read-only to this account; if the
`/home/hatch` path is not traversable by `wechat-bridge`, deploy to `/opt` or
grant read/execute traversal explicitly rather than chowning the whole repo.

Install sketch (deploy time, main agent; systemd is not tested on this machine):
```
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bridge.service wechat-bridge.service wx-bot-muse.service wx-bot-pi.service
```
