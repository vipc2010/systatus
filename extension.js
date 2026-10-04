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
const PORTS_BG_OPACITY = 140; // 端口面板背景不透明度（0 全透明 ~ 255 不透明）
const PORTS_WIDTH = 280; // 端口面板宽度（px）
const PORTS_REFRESH_SECONDS = 5; // 端口列表刷新间隔（每秒 fork 一次 ss，没必要跟主指标同频）
// 手工别名：自动认出来的单元名/进程名不够直观时用它覆盖。键 = "proto:port"（proto 小写）。
// 从 ~/.config/systatus/aliases.json 读取，形如 {"tcp:3000": "myservice"}。
// 文件只存在于本机、不进仓库；每次刷新端口列表时重读，改完即生效。
const ALIASES_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'systatus', 'aliases.json']);
function loadAliases() {
    const map = new Map();
    const txt = readText(ALIASES_FILE);
    if (!txt)
        return map;
    try {
        for (const [k, v] of Object.entries(JSON.parse(txt)))
            map.set(k, String(v));
    } catch (e) {
        log(`解析 ${ALIASES_FILE} 失败：${e.message}`);
    }
    return map;
}
const SS_BIN = '/usr/bin/ss'; // iproute2，端口与进程名的数据来源

const COLORS = {
    cpu: '#42a5f5',
    mem: '#66bb6a',
    gpu: '#ffa726',
    vram: '#26c6da',
    pwr: '#ef5350',
    ports: '#ab47bc',
    text: '#f2f3f5', // 端口面板正文色：背景是近黑半透明，必须显式覆盖主题的深色字
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

// ss -tulnpe 的一行 = 一个 socket：
//   Netid State Recv-Q Send-Q Local:Port Peer:Port [users:(..)] [uid:..] ino:.. sk:.. cgroup:.. ...
// users: 只对同 uid 的进程可见，但 cgroup: 对所有 socket 都可见，因此别人的端口可以用
// systemd 单元名来认（/system.slice/redis-server.service → redis-server）。
let _uidNames = null;
function uidName(uid) {
    if (_uidNames === null) {
        _uidNames = new Map();
        const txt = readText('/etc/passwd');
        if (txt) {
            for (const line of txt.split('\n')) {
                const f = line.split(':');
                if (f.length > 2 && f[2])
                    _uidNames.set(f[2], f[0]);
            }
        }
    }
    return _uidNames.get(uid) ?? null;
}

// cgroup 路径 → 单元名；认不出（user@1000.service、init.scope 这类容器路径）返回 null。
function unitNameFromCgroup(cg) {
    const last = cg.split('/').filter(Boolean).pop() || '';
    // 图形程序：.../app.slice/app-qoder-1218855.scope → qoder
    let m = last.match(/^app-([a-zA-Z0-9._+-]+)-[0-9a-f]{7,}\.(scope|slice)$/);
    if (m)
        return m[1];
    m = last.match(/^(.+?)\.(service|socket|scope|mount|slice)$/);
    if (!m)
        return null;
    if (/^(user@\d+|init|app|session|system)$/.test(m[1]))
        return null;
    return m[1];
}

// 返回 [显示名, 可信度]：进程名(自己) > systemd 单元名 > uid 用户名 > 无名
function socketLabel(line) {
    const m = line.match(/users:\(\("([^"]+)"/);
    if (m)
        return [m[1], 3];
    const cg = line.match(/\bcgroup:(\S+)/);
    if (cg) {
        const unit = unitNameFromCgroup(cg[1]);
        if (unit)
            return [unit, 2];
    }
    const uid = line.match(/\buid:(\d+)/);
    if (uid) {
        const name = uidName(uid[1]);
        if (name)
            return [name, 1];
    }
    return [null, 0];
}

function parseSocketList(text, aliases) {
    const byKey = new Map();
    if (!text)
        return byKey;
    for (const line of text.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 6)
            continue;
        const [proto, state, , , local] = f;
        if (proto !== 'tcp' && proto !== 'udp')
            continue;
        if (proto === 'tcp' && state !== 'LISTEN')
            continue;
        const port = parseInt(local.slice(local.lastIndexOf(':') + 1), 10);
        if (!port)
            continue;
        const [name, rank] = socketLabel(line);
        const key = `${proto}:${port}`;
        const alias = aliases.get(key);
        const shown = alias ?? name;
        const reliability = alias ? 4 : rank;
        const prev = byKey.get(key);
        // 同一端口 v4/v6 各一行：取可信度高的那个名字
        if (!prev || reliability > prev.rank)
            byKey.set(key, {proto: proto.toUpperCase(), port, name: shown, rank: reliability});
    }
    return byKey;
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
        this._dead = false;
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
        this._dead = true;
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
        // nvidia-smi 回调回来时扩展可能已被禁用，别再碰已销毁的 actor
        if (this._dead)
            return;
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

// 桌面右侧的监听端口面板：半透明背景，列出所有监听端口（协议/端口/进程名）。
// 贴在桌面层（global.window_group 里壁纸组之上、所有应用窗口之下）：
// 窗口一挡就看不见，只有露出桌面壁纸时才看得到，不遮挡任何应用。
// 根节点透明且不拦截事件，面板之外的区域照常点击。
class PortsOverlay {
    constructor() {
        this._rows = [];
        this._busy = false;
        this._dead = false;

        // 根节点用约束铺满 uiGroup（chrome 父节点 set_no_layout，不会自动分配子节点）。
        // 布局用 FixedLayout + 显式坐标：BinLayout 的 x_align 语义在这里不奏效（实测面板会居中）。
        this._root = new St.Widget({
            name: 'systatus-ports',
            layout_manager: new Clutter.FixedLayout(),
            constraints: new Clutter.BindConstraint({
                source: Main.layoutManager.uiGroup,
                coordinate: Clutter.BindCoordinate.ALL,
            }),
        });
        const alpha = (PORTS_BG_OPACITY / 255).toFixed(3);
        this._panel = new St.BoxLayout({vertical: true});
        this._panel.set_width(PORTS_WIDTH);
        this._panel.set_style(
            `background-color: rgba(15, 17, 21, ${alpha});` +
            ' border: 1px solid rgba(255, 255, 255, 0.12);' +
            ' border-radius: 10px;' +
            ' padding: 10px 12px;',
        );
        this._root.add_child(this._panel);

        this._header = new St.Label({ text: 'PORTS', x_align: Clutter.ActorAlign.START });
        this._header.set_style(`font-weight: bold; color: ${COLORS.ports};`);
        this._panel.add_child(this._header);

        this._list = new St.BoxLayout({ vertical: true });
        this._panel.add_child(this._list);

        this._more = new St.Label({ text: '', x_align: Clutter.ActorAlign.START });
        this._more.set_style(`font-family: monospace; color: ${COLORS.text};`);
        this._panel.add_child(this._more);

        this._place();
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._pinToDesktopLayer();

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PORTS_REFRESH_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        this._tick();
    }

    // 右上角定位：顶栏下方 48px，右边留 16px
    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._panel.set_position(monitor.width - PORTS_WIDTH - 16, monitor.y + 48);
    }

    // 钉在壁纸之上、窗口之下。mutter 每次重排窗口栈都可能把别的 actor 插到我们前面，
    // 所以每次刷新检查一次；已在位时什么都不做。
    // _backgroundGroup 是 GNOME 50 实测存在的壁纸锚点（window_group 的第 0 个子节点）。
    _pinToDesktopLayer() {
        const wg = global.window_group;
        const kids = wg.get_children();
        if (kids[1] === this._root)
            return;
        const anchor = Main.layoutManager._backgroundGroup || kids[0];
        if (!anchor || anchor === this._root)
            return;
        if (!kids.includes(this._root))
            wg.add_child(this._root);
        wg.set_child_above_sibling(this._root, anchor);
    }

    destroy() {
        this._dead = true;
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = null;
        }
        this._root.destroy();
    }

    _tick() {
        this._pinToDesktopLayer();
        if (this._busy || !GLib.file_test(SS_BIN, GLib.FileTest.EXISTS))
            return;
        this._busy = true;
        this._runSs().then(text => {
            this._busy = false;
            // 查询回来时扩展可能已被禁用，别再碰已销毁的 actor
            if (this._dead)
                return;
            const list = [...parseSocketList(text, loadAliases()).values()];
            // 先按服务名分组，让同一个服务的一批端口挨在一起；同服务内先 TCP 后 UDP、端口由小到大
            list.sort((a, b) => {
                const an = a.name ?? '', bn = b.name ?? '';
                if (an !== bn) {
                    if (!an)
                        return 1;
                    if (!bn)
                        return -1;
                    return an.localeCompare(bn);
                }
                return a.proto === b.proto ? a.port - b.port : (a.proto < b.proto ? -1 : 1);
            });
            this._render(list);
        });
    }

    _runSs() {
        return new Promise(resolve => {
            const proc = new Gio.Subprocess({
                argv: [SS_BIN, '-tulnpe'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            proc.communicate_async(null, null, (obj, res) => {
                try {
                    const [, out] = obj.communicate_finish(res);
                    resolve(out ? new TextDecoder().decode(out.get_data()) : null);
                } catch (e) {
                    resolve(null);
                }
            });
        });
    }

    _render(list) {
        const n = list.length;
        this._header.set_text(n ? `PORTS　${n} 个监听端口` : 'PORTS　无监听端口');
        // 按屏幕高度限制可见行数，超出部分折叠为一行提示
        const maxRows = Math.max(10, Math.floor((global.screen_height - 160) / 22));
        const visible = Math.min(n, maxRows);
        while (this._rows.length < visible) {
            const row = new St.Label({ x_align: Clutter.ActorAlign.START });
            row.set_style(`font-family: monospace; color: ${COLORS.text};`);
            this._list.add_child(row);
            this._rows.push(row);
        }
        for (let i = this._rows.length - 1; i >= visible; i--) {
            this._list.remove_child(this._rows[i]);
            this._rows[i].destroy();
            this._rows.pop();
        }
        for (let i = 0; i < visible; i++) {
            const p = list[i];
            this._rows[i].set_text(`${p.proto}　${p.port}${p.name ? `　${p.name}` : ''}`);
        }
        this._more.visible = n > visible;
        if (n > visible)
            this._more.set_text(`… 还有 ${n - visible} 个`);
    }
}

export default class SystatusExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        // 挂到面板左侧（Activities 之后），避开居中的日期时间。
        // 必须走 addToStatusArea：它插入的是 indicator.container，
        // 直接 add_child(button) 会宽度塌陷、什么都不显示。
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'left');
        // 端口面板：自己挂到桌面层（见 PortsOverlay._pinToDesktopLayer）
        this._portsOverlay = new PortsOverlay();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._portsOverlay?.destroy();
        this._portsOverlay = null;
    }
}
