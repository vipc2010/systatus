#!/usr/bin/env bash
# systatus 守护脚本：扩展非 ACTIVE 时自动重启它
UUID="systatus@fanliaowu.local"
state=$(gnome-extensions info "$UUID" 2>/dev/null | grep -Eo 'ACTIVE|OUT OF DATE|ERROR|INITIALIZED|NEEDS_SETUP|DISABLED|INACTIVE' | tail -1)

if [ "$state" = "ACTIVE" ]; then
    exit 0
fi

if [ "$state" = "OUT OF DATE" ]; then
    # 版本门：disable/enable 修不好，只会白刷。
    major=$(gnome-shell --version | grep -Eo '[0-9]+' | head -1)
    logger -t systatus-watchdog \
        "扩展声明不支持 GNOME $major。修法和详细步骤见 README『系统升级后扩展不启动』一节：把 \"$major\" 加进 metadata.json 的 shell-version，再切换 disable-extension-version-validation 触发重载。"
    exit 0
fi

logger -t systatus-watchdog "扩展状态=$state，尝试重新启用"
gnome-extensions disable "$UUID" 2>/dev/null
sleep 1
gnome-extensions enable "$UUID" 2>/dev/null
