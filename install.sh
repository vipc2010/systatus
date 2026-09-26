#!/usr/bin/env bash
# 安装并启用 systatus GNOME 扩展 + 守护定时器
set -euo pipefail
UUID="systatus@fanliaowu.local"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp "$SRC/metadata.json" "$SRC/extension.js" "$DEST/"
chmod +x "$SRC/watchdog.sh"
gnome-extensions enable "$UUID" || true

# 守护：每 2 分钟检查扩展状态，非 ACTIVE 自动拉起
mkdir -p "$HOME/.config/systemd/user"
cp "$SRC/systatus-watchdog.service" "$SRC/systatus-watchdog.timer" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now systatus-watchdog.timer

echo "已安装并启用 $UUID，守护定时器已启动"
echo "如顶栏未出现，可注销重登，或按 alt+F2 输入 r 再回车重启 GNOME Shell（X11 支持，不丢窗口）"
