#!/usr/bin/env bash
# systatus 守护脚本：扩展非 ACTIVE 时自动重启它
UUID="systatus@fanliaowu.local"
state=$(gnome-extensions info "$UUID" 2>/dev/null | grep -Eow 'ACTIVE|ERROR|INITIALIZED|NEEDS_SETUP|DISABLED|INACTIVE' | tail -1)
if [ "$state" != "ACTIVE" ]; then
    logger -t systatus-watchdog "扩展状态=$state，尝试重新启用"
    gnome-extensions disable "$UUID" 2>/dev/null
    sleep 1
    gnome-extensions enable "$UUID" 2>/dev/null
fi
