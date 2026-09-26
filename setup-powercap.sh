#!/usr/bin/env bash
# 开放 RAPL energy_uj 只读权限，使扩展能显示 CPU 封装功耗（需 sudo）
# 原理：Ubuntu 24.04 内核将 /sys/class/powercap/*/energy_uj 设为 root 0400，
# 通过 systemd-tmpfiles 在每次开机时将其调整为 0644（只影响读取权限）。
set -euo pipefail
RULE=/etc/tmpfiles.d/systatus-powercap.conf

sudo tee "$RULE" >/dev/null <<'EOF'
z /sys/class/powercap/intel-rapl*/energy_uj 0644 - -
z /sys/class/powercap/intel-rapl*:*:*/energy_uj 0644 - -
EOF
sudo systemd-tmpfiles --create "$RULE"

if cat /sys/class/powercap/intel-rapl:0/energy_uj >/dev/null 2>&1; then
    echo "OK：RAPL 已可读，重启扩展后即可显示 CPU 功耗"
else
    echo "警告：仍不可读，请检查内核是否启用 powercap" >&2
    exit 1
fi
