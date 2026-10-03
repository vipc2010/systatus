import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Button as PanelMenuButton } from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { PopupMenuItem, PopupSeparatorMenuItem } from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 2;
const NVIDIA_SMI = '/usr/bin/nvidia-smi';
const RAPL_PKG = '/sys/class/powercap/intel-rapl:0/energy_uj';
const RAPL_MAX = '/sys/class/powercap/intel-rapl:0/max_energy_range_uj';
const PORTS_OPACITY = 150; // 端口指示器顶栏不透明度（0 全透明 ~ 255 不透明）

const COLORS = {
    cpu: '#42a5f5',
    mem: '#66bb6a',
    gpu: '#ffa726',
    vram: '#26c6da',
    pwr: '#ef5350',
    ports: '#ab47bc',
};

function readText(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

function fmtPct(v) {
    return v == null ? '–' : `${Math.round(v)}%`;
}

function fmtW(v) {
    return v == null ? '–' : `${v.toFixed(1)}W`;
}

function fmtGb(mib) {
    return (mib / 1024).toFixed(1);
}

// 读取监听端口：TCP 只取 st=0A（LISTEN），UDP 取所有已绑定套接字。
// 返回 [{proto: 'tcp'|'udp', port, inode}]
function readListeningSockets() {
    const sockets = [];
    const sources = [
        ['/proc/net/tcp', 'tcp', true],
        ['/proc/net/tcp6', 'tcp', true],
        ['/proc/net/udp', 'udp', false],
        ['/proc/net/udp6', 'udp', false],
    ];
    for (const [path, proto, listenOnly] of sources) {
        const txt = readText(path);
        if (!txt)
            continue;
        const lines = txt.split('\n');
        for (let i = 1; i < lines.length; i++) {
            const f = lines[i].trim().split(/\s+/);
            if (f.length < 10)
                continue;
            if (listenOnly && f[3] !== '0A')
                continue;
            const port = parseInt(f[1].split(':').pop(), 16);
            if (port > 0)
                sockets.push({ proto, port, inode: f[9] });
        }
    }
    return sockets;
}

// 通过 /proc/<pid>/fd 的 socket:[inode] 符号链接反查进程名（仅当前用户可见的进程）。
// 返回 Map<inode, comm>
function findSocketOwners(inodes) {
    const owners = new Map();
    if (inodes.size === 0)
        return owners;
    const procEnum = GLib.file_enumerate_directory(GLib.file_new_for_path('/proc'), GLib.PRIORITY_DEFAULT, null);
    if (!procEnum)
        return owners;
    outer:
    while (true) {
        const entry = procEnum.next_file(procEnum);
        if (!entry)
            break;
        const pid = entry.get_name();
        if (!/^\d+$/.test(pid))
            continue;
        const fdEnum = GLib.file_enumerate_directory(GLib.file_new_for_path(`/proc/${pid}/fd`), GLib.PRIORITY_DEFAULT, null);
        if (!fdEnum)
            continue;
        while (true) {
            const fdEntry = fdEnum.next_file(fdEnum);
            if (!fdEntry)
                break;
            let target = null;
            try {
                target = Gio.File.new_for_path(`/proc/${pid}/fd/${fdEntry.get_name()}`).read_symlink();
            } catch (e) {
                continue;
            }
            if (!target || !target.startsWith('socket:['))
                continue;
            const inode = target.slice(8, -1);
            if (inodes.has(inode) && !owners.has(inode)) {
                const comm = readText(`/proc/${pid}/comm`);
                owners.set(inode, comm ? comm.trim().split('\n')[0] : pid);
                if (owners.size === inodes.size) {
                    fdEnum.close();
                    procEnum.close();
                    break outer;
                }
            }
        }
        fdEnum.close();
    }
    procEnum.close();
    return owners;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenuButton {
    _init() {
        super._init(0.0, '系统状态监控', false);

        this._prevCpu = null;
        this._prevEnergy = null;
        this._prevStamp = null;
        this._maxEnergy = null;
        this._raplDenied = false;
        this._gpu = null;
        this._gpuName = null;
        this._gpuBusy = false;
        this._hasSmi = GLib.file_test(NVIDIA_SMI, GLib.FileTest.EXISTS);

        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        this._labels = {};
        for (const [key, name] of [['cpu', 'CPU'], ['mem', 'RAM'], ['vram', 'VRAM'], ['gpu', 'GPU'], ['pwr', 'POWER']]) {
            if (key !== 'cpu')
                box.add_child(new St.Label({ text: '  ', y_align: Clutter.ActorAlign.CENTER }));
            const dot = new St.Label({ text: '● ', y_align: Clutter.ActorAlign.CENTER });
            dot.set_style(`color: ${COLORS[key]};`);
            const label = new St.Label({ text: `${name} –`, y_align: Clutter.ActorAlign.CENTER });
            box.add_child(dot);
            box.add_child(label);
            this._labels[key] = label;
        }
        this.add_child(box);

        const itemParams = { reactive: false, can_focus: false };
        this._menuCpu = new PopupMenuItem('CPU', itemParams);
        this._menuMem = new PopupMenuItem('RAM', itemParams);
        this._menuGpu = new PopupMenuItem('GPU', itemParams);
        this._menuPwr = new PopupMenuItem('POWER', itemParams);
        this._menuHint = new PopupMenuItem('', itemParams);
        this.menu.addMenuItem(new PopupSeparatorMenuItem());
        for (const item of [this._menuCpu, this._menuMem, this._menuGpu, this._menuPwr])
            this.menu.addMenuItem(item);
        this.menu.addMenuItem(new PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._menuHint);

        this._updateGpuName();

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._tick();
    }

    destroy() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
        super.destroy();
    }

    _tick() {
        this._cpuPct = this._readCpuPct();
        this._mem = this._readMem();
        this._cpuPowerW = this._readRaplW();
        this._queryGpu();
        this._render();
    }

    _readCpuPct() {
        const txt = readText('/proc/stat');
        if (!txt)
            return null;
        const m = txt.match(/^cpu\s+(.*)/m);
        if (!m)
            return null;
        const nums = m[1].trim().split(/\s+/).map(Number);
        const idle = nums[3] + (nums[4] ?? 0);
        const total = nums.reduce((a, b) => a + b, 0);
        let pct = null;
        if (this._prevCpu) {
            const dt = total - this._prevCpu.total;
            const di = idle - this._prevCpu.idle;
            if (dt > 0)
                pct = (1 - di / dt) * 100;
        }
        this._prevCpu = { total, idle };
        return pct;
    }

    _readMem() {
        const txt = readText('/proc/meminfo');
        if (!txt)
            return null;
        const total = txt.match(/MemTotal:\s+(\d+)/);
        const avail = txt.match(/MemAvailable:\s+(\d+)/);
        if (!total || !avail)
            return null;
        const totalKb = Number(total[1]);
        const usedKb = totalKb - Number(avail[1]);
        return { usedKb, totalKb, pct: (usedKb / totalKb) * 100 };
    }

    _readRaplW() {
        const raw = readText(RAPL_PKG);
        if (raw === null) {
            this._raplDenied = true;
            return null;
        }
        this._raplDenied = false;
        const energy = parseFloat(raw.trim());
        if (this._maxEnergy === null) {
            const max = parseFloat(readText(RAPL_MAX) ?? '0');
            this._maxEnergy = max > 0 ? max : Number.MAX_SAFE_INTEGER;
        }
        const now = GLib.get_monotonic_time();
        let watts = null;
        if (this._prevEnergy !== null && this._prevStamp !== null) {
            let dUj = energy - this._prevEnergy;
            if (dUj < 0)
                dUj += this._maxEnergy;
            const dSec = (now - this._prevStamp) / 1e6;
            if (dSec > 0)
                watts = dUj / 1e6 / dSec;
        }
        this._prevEnergy = energy;
        this._prevStamp = now;
        return watts;
    }

    _runSmi(query) {
        return new Promise(resolve => {
            const proc = new Gio.Subprocess({
                argv: [NVIDIA_SMI, `--query-gpu=${query}`, '--format=csv,noheader,nounits'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            proc.communicate_async(null, null, (obj, res) => {
                try {
                    const [, out] = obj.communicate_finish(res);
                    resolve(out ? new TextDecoder().decode(out.get_data()).trim() : null);
                } catch (e) {
                    resolve(null);
                }
            });
        });
    }

    _updateGpuName() {
        if (!this._hasSmi)
            return;
        this._runSmi('name').then(name => {
            if (name)
                this._gpuName = name.split('\n')[0].trim();
        });
    }

    _queryGpu() {
        if (!this._hasSmi || this._gpuBusy)
            return;
        this._gpuBusy = true;
        this._runSmi('utilization.gpu,memory.used,memory.total,power.draw')
            .then(text => {
                this._gpuBusy = false;
                if (!text) {
                    this._gpu = null;
                    this._render();
                    return;
                }
                const p = text.split('\n')[0].split(',').map(s => s.trim());
                const num = s => {
                    const v = parseFloat(s);
                    return Number.isNaN(v) ? null : v;
                };
                this._gpu = {
                    util: num(p[0]),
                    memUsed: num(p[1]),
                    memTotal: num(p[2]),
                    powerW: num(p[3]),
                };
                this._render();
            });
    }

    _render() {
        this._labels.cpu.set_text(`CPU ${fmtPct(this._cpuPct)}`);
        this._labels.mem.set_text(`RAM ${fmtPct(this._mem?.pct)}`);
        this._labels.gpu.set_text(`GPU ${this._hasSmi ? fmtPct(this._gpu?.util) : '无'}`);
        const vramPct = this._gpu?.memTotal ? (this._gpu.memUsed / this._gpu.memTotal) * 100 : null;
        this._labels.vram.set_text(`VRAM ${this._hasSmi ? fmtPct(vramPct) : '无'}`);
        const totalW = (this._cpuPowerW ?? 0) + (this._gpu?.powerW ?? 0) ||
            (this._cpuPowerW ?? this._gpu?.powerW ?? null);
        this._labels.pwr.set_text(`POWER ${fmtW(totalW)}`);

        this._menuCpu.label_actor.text = `CPU　使用率 ${fmtPct(this._cpuPct)}`;
        if (this._mem) {
            this._menuMem.label_actor.text =
                `RAM　${fmtGb(this._mem.usedKb / 1024)} / ${fmtGb(this._mem.totalKb / 1024)} GB (${fmtPct(this._mem.pct)})`;
        }
        if (this._hasSmi) {
            const g = this._gpu;
            const name = this._gpuName ? `${this._gpuName.replace(/^NVIDIA\s+/i, '')}　` : '';
            this._menuGpu.label_actor.text = g
                ? `GPU　${name}${fmtPct(g.util)} · VRAM ${fmtGb(g.memUsed)} / ${fmtGb(g.memTotal)} GB · ${fmtW(g.powerW)}`
                : `GPU　${name}读取中…`;
        } else {
            this._menuGpu.label_actor.text = 'GPU　未检测到 nvidia-smi';
        }
        const parts = [];
        parts.push(`CPU 封装 ${fmtW(this._cpuPowerW)}`);
        parts.push(`GPU ${fmtW(this._gpu?.powerW)}`);
        this._menuPwr.label_actor.text = `POWER　${parts.join(' · ')}`;

        if (this._raplDenied) {
            this._menuHint.visible = true;
            this._menuHint.label_actor.text = 'CPU 功耗不可用：以 sudo 运行 ~/systatus/setup-powercap.sh 开放 RAPL 读取';
        } else {
            this._menuHint.visible = false;
        }
    }
});

// 面板右侧的监听端口指示器：顶栏半透明显示端口数量，点击展开端口/进程列表。
const PortsIndicator = GObject.registerClass(
class PortsIndicator extends PanelMenuButton {
    _init() {
        super._init(0.0, '监听端口', false);

        this._ports = [];
        this._items = [];

        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        const dot = new St.Label({ text: '● ', y_align: Clutter.ActorAlign.CENTER });
        dot.set_style(`color: ${COLORS.ports};`);
        this._label = new St.Label({ text: 'PORTS –', y_align: Clutter.ActorAlign.CENTER });
        box.add_child(dot);
        box.add_child(this._label);
        box.set_opacity(PORTS_OPACITY);
        this.add_child(box);

        const itemParams = { reactive: false, can_focus: false };
        this._header = new PopupMenuItem('', itemParams);
        this._sep = new PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._sep);
        this.menu.addMenuItem(this._header);

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._tick();
    }

    destroy() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
        super.destroy();
    }

    _tick() {
        const sockets = readListeningSockets();
        // 同一 proto:port 可能在 v4/v6 各出现一次，去重
        const byKey = new Map();
        for (const s of sockets) {
            const key = `${s.proto}:${s.port}`;
            if (!byKey.has(key))
                byKey.set(key, s);
        }
        const inodes = new Set();
        for (const s of byKey.values())
            if (s.inode && s.inode !== '0')
                inodes.add(s.inode);
        const owners = findSocketOwners(inodes);
        const list = [...byKey.values()].map(s => ({
            proto: s.proto.toUpperCase(),
            port: s.port,
            name: s.inode && s.inode !== '0' ? owners.get(s.inode) : null,
        }));
        list.sort((a, b) => a.proto === b.proto ? a.port - b.port : (a.proto < b.proto ? -1 : 1));
        this._ports = list;
        this._render();
    }

    _render() {
        const n = this._ports.length;
        this._label.set_text(`PORTS ${n}`);
        const visible = Math.min(n, 100);
        while (this._items.length < visible)
            this._items.push(new PopupMenuItem('', { reactive: false, can_focus: false }));
        for (let i = 0; i < visible; i++) {
            const p = this._ports[i];
            this._items[i].label_actor.text = `${p.proto}　${p.port}${p.name ? `　${p.name}` : ''}`;
        }
        this._header.label_actor.text = n ? `PORTS　${n} 个监听端口` : 'PORTS　无监听端口';
        this.menu.removeAll();
        this.menu.addMenuItem(this._sep);
        this.menu.addMenuItem(this._header);
        for (let i = 0; i < visible; i++)
            this.menu.addMenuItem(this._items[i]);
    }
});

export default class SystatusExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        this._portsIndicator = new PortsIndicator();
        // 挂到面板左侧（Activities 之后），避开居中的日期时间。
        // 必须走 addToStatusArea：它插入的是 indicator.container，
        // 直接 add_child(button) 会宽度塌陷、什么都不显示。
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'left');
        // 端口指示器挂面板右侧，半透明显示。
        Main.panel.addToStatusArea(this.uuid + '-ports', this._portsIndicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._portsIndicator?.destroy();
        this._portsIndicator = null;
    }
}
