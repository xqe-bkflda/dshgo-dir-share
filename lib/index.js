// 目录共享：把工作区 / 手机存储通过 FTP + WebDAV 转发到局域网，
// MT 管理器「添加网络存储」直接挂载读写。
//
// 面板里：启动 / 停止、换端口、复制地址和密码、看最近操作。
// 清单见 package.json，服务实现在 lib/server.js。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createShare, lanAddresses, WORKSPACE, SDCARD } from './server.js'

export const name = 'dshgo-dir-share'

const CONFIG_FILE = process.env.DIR_SHARE_CONFIG
  || path.join(os.homedir(), '.dsh', 'dir-share.json')

const DEFAULTS = {
  mode: 'workspace',        // workspace | sdcard | both
  ftpPort: 2121,
  davPort: 8081,
  user: 'mt',
  pass: '',
  anonymous: false,
  readOnly: false,
  autoStart: false,
}

function loadConfig() {
  let disk = {}
  try { disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch {}
  const cfg = { ...DEFAULTS, ...disk }
  if (!cfg.pass) {
    cfg.pass = crypto.randomBytes(5).toString('hex')
    saveConfig(cfg)
  }
  return cfg
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  } catch {}
}

const MODE_LABEL = { workspace: '工作区', sdcard: '手机存储', both: '工作区 + 手机存储' }

function fmtBytes(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function addrFor(cfg) {
  const lan = lanAddresses()
  const host = lan[0]?.address || '127.0.0.1'
  return {
    host,
    // 同一台手机上用这个（MT 管理器直连回环，不用同 WiFi 也能挂）
    ftpLocal: `ftp://127.0.0.1:${cfg.ftpPort}`,
    davLocal: `http://127.0.0.1:${cfg.davPort}`,
    // 别的设备（电脑/另一台手机）用这个
    ftp: `ftp://${host}:${cfg.ftpPort}`,
    dav: `http://${host}:${cfg.davPort}`,
    all: lan,
  }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const cfg = loadConfig()

    // 引擎热重载插件时，旧模块起的监听还在同一个进程里活着。把它找回来复用，
    // 否则新模块 bind 同一个端口只会拿到 EADDRINUSE —— 面板就一直「已停止」。
    const HOLDER = Symbol.for('dsh.dir-share.instance')
    const holder = globalThis[HOLDER] || (globalThis[HOLDER] = { share: null })

    let share
    if (holder.share) {
      share = holder.share
      Object.assign(share.cfg, cfg)   // 端口、账号按新配置走，监听保持不动
      Object.assign(cfg, share.cfg)
    } else {
      share = createShare(cfg)
      holder.share = share
    }

    const zh = (event) => !String(event?.locale || '').startsWith('en')

    let pushData = () => {}

    function statusData() {
      const a = addrFor(cfg)
      const running = share.running
      return {
        running,
        external: share.external ? '是（旧实例）' : '否',
        headline: `${running ? '运行中' : '已停止'} · ${MODE_LABEL[cfg.mode] || cfg.mode}`,
        mode: MODE_LABEL[cfg.mode] || cfg.mode,
        host: a.host,
        ftpLocal: a.ftpLocal,
        davLocal: a.davLocal,
        ftp: a.ftp,
        dav: a.dav,
        ftpPort: String(cfg.ftpPort),
        davPort: String(cfg.davPort),
        user: cfg.user,
        pass: cfg.pass,
        readOnly: cfg.readOnly ? '只读' : '可读写',
        bytes: fmtBytes(share.bytes),
        hits: String(share.hits),
        uptime: running && share.startedAt
          ? `${Math.max(1, Math.round((Date.now() - share.startedAt) / 60000))} 分钟`
          : '—',
        log: share.log.slice(0, 6).map((e) => ({
          title: e.text,
          trailing: new Date(e.t).toTimeString().slice(0, 5),
        })),
        lan: a.all.map((x) => ({ title: x.address, subtitle: x.name })),
      }
    }

    // 换一个 share 实例时，把已有的操作日志搬过去，别丢
    function reseat() {
      const old = share.log.slice()
      share = createShare(cfg)
      holder.share = share
      for (const e of old.reverse()) share.hit(e.text)
      return share
    }

    // 端口被占就自动往后挪，最多试 20 次，成功后写回配置
    async function restart() {
      await share.stop()
      let errors = await share.start()
      for (let i = 0; i < 20 && errors.some((e) => e.includes('EADDRINUSE')); i++) {
        cfg.ftpPort = cfg.ftpPort >= 2199 ? 2121 : cfg.ftpPort + 1
        cfg.davPort = cfg.davPort >= 8099 ? 8081 : cfg.davPort + 1
        reseat()
        errors = await share.start()
      }
      if (errors.length) share.hit(errors.join(' / '))
      else saveConfig(cfg)
      pushData()
      return errors
    }

    // ── 面板
    ctx.dshGo.panel('share', {
      view: (scope, caps) => {
        const en = String(caps?.locale || '').startsWith('en')
        const t = (a, b) => (en ? b : a)
        return {
          v: 2,
          type: 'stack',
          title: t('目录共享', 'Dir Share'),
          accent: 'teal',
          children: [
            { type: 'text', text: { $: 'data.headline' }, style: { size: 'title', weight: 'bold' } },
            { type: 'keyValue', items: [
              [t('本机 FTP（MT 用这个）', 'Local FTP'), { $: 'data.ftpLocal' }],
              [t('本机 WebDAV', 'Local WebDAV'), { $: 'data.davLocal' }],
              [t('局域网 FTP', 'LAN FTP'), { $: 'data.ftp' }],
              [t('局域网 WebDAV', 'LAN WebDAV'), { $: 'data.dav' }],
              [t('账号', 'User'), { $: 'data.user' }],
              [t('密码', 'Password'), { $: 'data.pass' }],
              [t('权限', 'Access'), { $: 'data.readOnly' }],
              [t('实例', 'Instance'), { $: 'data.external' }],
              [t('已传输', 'Transferred'), { $: 'data.bytes' }],
              [t('运行', 'Uptime'), { $: 'data.uptime' }],
            ] },
            { type: 'actions', items: [
              { label: t('启动', 'Start'), action: 'start', icon: 'play' },
              { label: t('停止', 'Stop'), action: 'stop', icon: 'stop' },
              { label: t('换端口', 'New port'), action: 'port', icon: 'refresh' },
              { label: t('复制地址', 'Copy URL'), action: 'copy-url', icon: 'copy' },
            ] },
            { type: 'actions', items: [
              { label: t('复制密码', 'Copy pass'), action: 'copy-pass', icon: 'copy' },
              { label: t('可读写/只读', 'RW/RO'), action: 'toggle-ro', icon: 'edit' },
              { label: t('换目录', 'Switch dir'), action: 'cycle-mode', icon: 'folder' },
              { label: t('刷新', 'Refresh'), action: 'refresh', icon: 'refresh' },
            ] },
            { type: 'text', text: t('局域网地址', 'LAN addresses'), tone: 'muted' },
            { type: 'list', items: { $: 'data.lan' } },
            { type: 'text', text: t('最近操作', 'Recent activity'), tone: 'muted' },
            { type: 'list', items: { $: 'data.log' } },
            { type: 'callout', tone: 'info', text: t(
              'MT 管理器（同一台手机上）用「本机 FTP」127.0.0.1 就能挂，不需要电脑也不需要同一 WiFi。',
              'Use the Local FTP address (127.0.0.1) in MT Manager on this same phone - no PC or Wi-Fi needed.',
            ) },
          ],
        }
      },
      data: (scope, emit) => {
        const push = () => emit(statusData())
        pushData = push
        push()
        const timer = setInterval(push, 5000)
        return () => {
          clearInterval(timer)
          if (pushData === push) pushData = () => {}
        }
      },
      actions: {
        start: async () => {
          const errors = await restart()
          if (errors.length) return { toast: String(errors[0]).slice(0, 38), refresh: true }
          share.hit('服务已启动')
          return { toast: `已启动，端口 ${cfg.ftpPort}`, refresh: true }
        },
        stop: async () => {
          const wasExternal = share.external
          await share.stop()
          share.hit('服务已停止')
          pushData()
          return { toast: wasExternal ? '旧实例仍在监听，重启引擎后可控' : '已停止', refresh: true }
        },
        port: async () => {
          const wasRunning = share.running
          cfg.ftpPort = cfg.ftpPort >= 2199 ? 2121 : cfg.ftpPort + 1
          cfg.davPort = cfg.davPort >= 8099 ? 8081 : cfg.davPort + 1
          saveConfig(cfg)
          reseat()
          if (wasRunning) await share.start()
          share.hit(`端口改为 ${cfg.ftpPort}`)
          pushData()
          return { toast: `FTP ${cfg.ftpPort}`, refresh: true }
        },
        'copy-url': () => {
          const a = addrFor(cfg)
          return { copy: `${a.ftpLocal}\n用户 ${cfg.user}\n密码 ${cfg.pass}`, toast: '本机地址已复制' }
        },
        'copy-pass': () => ({ copy: cfg.pass, toast: '密码已复制' }),
        'toggle-ro': () => {
          cfg.readOnly = !cfg.readOnly
          saveConfig(cfg)
          share.hit(cfg.readOnly ? '改为只读' : '改为可读写')
          pushData()
          return { toast: cfg.readOnly ? '只读' : '可读写', refresh: true }
        },
        'cycle-mode': async () => {
          const order = ['workspace', 'sdcard', 'both']
          cfg.mode = order[(order.indexOf(cfg.mode) + 1) % order.length]
          saveConfig(cfg)
          const wasRunning = share.running
          await share.stop()
          reseat()
          if (wasRunning) await share.start()
          share.hit('共享目录改为 ' + MODE_LABEL[cfg.mode])
          pushData()
          return { toast: MODE_LABEL[cfg.mode], refresh: true }
        },
        refresh: () => { pushData(); return { refresh: true } },
      },
    })

    if (cfg.autoStart) {
      restart().then(() => share.hit('开机自动启动'))
    }
    ctx.logger?.info?.(`dir-share ready: ${WORKSPACE} / ${SDCARD}`)
  })
}
