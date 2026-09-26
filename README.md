# systatus

一个轻量的 GNOME 顶栏系统监控扩展，在状态栏实时显示 **CPU / RAM / VRAM / GPU / POWER** 五项指标，点击可展开详情菜单。

A lightweight GNOME top-bar system monitor: CPU, RAM, VRAM, GPU utilization and power draw, with a click-to-expand detail menu.

## 效果

```
● CPU 11%  ● RAM 49%  ● VRAM 80%  ● GPU 5%  ● POWER 108.3W
```

点击顶栏区域展开详情：GPU 型号、显存绝对值（GB）、CPU 封装功耗与 GPU 功耗拆分。

## 数据来源

| 指标 | 来源 | 说明 |
|------|------|------|
| CPU | `/proc/stat` | 两次采样差值计算利用率 |
| RAM | `/proc/meminfo` | `MemTotal - MemAvailable` |
| GPU / VRAM | `nvidia-smi` | 异步子进程查询，不阻塞 Shell |
| POWER | RAPL + `nvidia-smi` | CPU 封装功耗（`/sys/class/powercap`）+ GPU 功耗之和 |

## 环境要求

- GNOME Shell 45 / 46（Ubuntu 24.04 默认可用），其他版本可自行修改 `metadata.json` 的 `shell-version`
- NVIDIA 显卡 + `nvidia-smi`（无 NVIDIA 显卡时 GPU/显存/功耗自动降级显示）
- CPU 封装功耗需要 Intel/AMD RAPL（可选，见下文）

## 安装

```bash
git clone https://github.com/vipc2010/systatus.git
cd systatus
bash install.sh
```

脚本会将扩展复制到 `~/.local/share/gnome-shell/extensions/`、启用扩展，并安装一个 systemd 用户级守护定时器（每 2 分钟检查扩展状态，异常时自动拉起）。

**Wayland 用户**需注销重登一次；**X11 用户**若顶栏未出现，按 `Alt+F2` 输入 `r` 回车重载 Shell。

## 启用 CPU 功耗显示（可选）

Ubuntu 24.04 将 RAPL 能耗文件锁定为 root 只读（0400）。运行以下命令通过 systemd-tmpfiles 开放只读权限（重启后依然生效）：

```bash
bash setup-powercap.sh
```

该脚本仅写入一条规则到 `/etc/tmpfiles.d/systatus-powercap.conf`，将 `/sys/class/powercap/intel-rapl*/energy_uj` 权限调整为 0644（只读，不含写权限）。如需回滚：

```bash
sudo rm /etc/tmpfiles.d/systatus-powercap.conf
```

未执行此步骤时，POWER 仅显示 GPU 功耗，详情菜单会给出提示。

## 文件说明

| 文件 | 用途 |
|------|------|
| `extension.js` | 扩展主体（GNOME 46 API：`PanelMenu.Button` + `GObject.registerClass`） |
| `metadata.json` | 扩展元信息 |
| `install.sh` | 一键安装扩展 + 守护定时器 |
| `watchdog.sh` | 守护脚本：扩展非 ACTIVE 时自动重新启用 |
| `systatus-watchdog.service` / `.timer` | systemd 用户单元（每 2 分钟触发守护检查） |
| `setup-powercap.sh` | 可选：开放 RAPL 只读权限以显示 CPU 封装功耗 |

## 定制

- 刷新间隔：`extension.js` 中 `REFRESH_SECONDS`（默认 2 秒）
- 指标顺序与颜色：`_init()` 中的段落数组与 `COLORS`
- 标签语言：`_render()` 中各 `set_text` 前缀

## 卸载

```bash
gnome-extensions uninstall systatus@fanliaowu.local
systemctl --user disable --now systatus-watchdog.timer
rm ~/.config/systemd/user/systatus-watchdog.{service,timer}
```

## License

[MIT](LICENSE)
