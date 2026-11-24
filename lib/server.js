// 目录共享服务：FTP + WebDAV，把一个或多个本地目录转发到局域网 / 本机。
// MT 管理器「添加网络存储 → FTP / WebDAV」就能直接读写。
//
// 结构：
//   resolve()  虚拟路径 → 真实路径（多根目录时用 /workspace、/sdcard 当顶层）
//   createFtp()  FTP 服务（PASV/EPSV、LIST/MLSD、RETR/STOR、删除改名建目录）
//   createDav()  WebDAV 服务（PROPFIND/GET/PUT/DELETE/MKCOL/MOVE/COPY）
//   createShare() 两套一起起停

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'

export const WORKSPACE = process.env.DSH_WORKSPACE || '/root/workspace'
export const HOME_ROOT = '/root'
export const SDCARD = '/sdcard'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function rootsFor(mode) {
  if (mode === 'sdcard') return [{ name: '', real: SDCARD, label: '手机存储' }]
  // 整个 /root：workspace、.dsh 配置、别的目录都在里面
  if (mode === 'root') return [{ name: '', real: HOME_ROOT, label: '根目录 (/root)' }]
  if (mode === 'both') {
    return [
      { name: 'workspace', real: WORKSPACE, label: '工作区' },
      { name: 'sdcard', real: SDCARD, label: '手机存储' },
    ]
  }
  return [{ name: '', real: WORKSPACE, label: '工作区' }]
}

/** 虚拟路径（posix，以 / 开头）→ { synthetic } 或 { real, isRoot } 或 null。 */
export function resolvePath(mode, vpath) {
  const clean = path.posix.normalize('/' + String(vpath || '/').replace(/\\/g, '/'))
  const parts = clean.split('/').filter(Boolean)
  if (parts.some((p) => p === '..')) return null
  const roots = rootsFor(mode)
  if (roots[0].name === '') {
    return { real: path.join(roots[0].real, ...parts), root: roots[0].real, parts }
  }
  if (parts.length === 0) return { synthetic: roots }
  const top = roots.find((r) => r.name === parts[0])
  if (!top) return null
  return { real: path.join(top.real, ...parts.slice(1)), root: top.real, parts: parts.slice(1) }
}

function inside(root, target) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  return t === r || t.startsWith(r + path.sep)
}

function lsLine(name, st, isDir) {
  const d = new Date(st.mtime)
  const perm = isDir ? 'drwxr-xr-x' : '-rw-r--r--'
  const size = isDir ? 4096 : st.size
  const when = Date.now() - d.getTime() > 180 * 864e5
    ? `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')}  ${d.getFullYear()}`
    : `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${perm} 1 root root ${String(size).padStart(12, ' ')} ${when} ${name}`
}

function mlsdLine(name, st, isDir) {
  const d = new Date(st.mtime)
  const modify = d.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `type=${isDir ? 'dir' : 'file'};size=${isDir ? 0 : st.size};modify=${modify}; ${name}`
}

function safeName(name) {
  return !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')
}

// ─────────────────────────────────────────────────────────────── FTP
class FtpSession {
  constructor(share, socket) {
    this.share = share
    this.sock = socket
    this.buf = ''
    this.cwd = '/'
    this.user = null
    this.authed = false
    this.binary = true
    this.renameFrom = null
    this.rest = 0
    this.dataServer = null
    this.dataSock = null
    this.busy = false
    socket.setTimeout(0)
    socket.on('data', (d) => this.onData(d))
    socket.on('error', () => this.close())
    socket.on('close', () => this.close())
    this.reply(220, 'dir-share FTP ready')
  }

  close() {
    try { this.dataServer?.close() } catch {}
    try { this.dataSock?.destroy() } catch {}
    try { this.sock.destroy() } catch {}
  }

  reply(code, text) {
    const lines = String(text).split('\n')
    this.sock.write(lines.map((l, i) => `${i === lines.length - 1 ? code : code + '-'} ${l}`).join('\r\n') + '\r\n')
  }

  onData(chunk) {
    this.buf += chunk.toString('utf8')
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '')
      this.buf = this.buf.slice(idx + 1)
      this.handle(line).catch((err) => this.reply(550, msg(err)))
    }
  }

  async handle(line) {
    const sp = line.indexOf(' ')
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase()
    const arg = sp < 0 ? '' : line.slice(sp + 1)
    const S = this.share

    if (cmd === 'USER') {
      if (S.cfg.user === arg) { this.user = arg; return this.reply(331, 'Password required') }
      if (S.cfg.anonymous && arg === 'anonymous') { this.user = arg; this.authed = true; S.hit(`FTP ${arg} 登录`); return this.reply(230, 'Anonymous login ok') }
      this.user = null
      return this.reply(331, 'Password required')
    }
    if (cmd === 'PASS') {
      if (!this.user) return this.reply(503, 'Send USER first')
      if (this.user === 'anonymous' && S.cfg.anonymous) this.authed = true
      else if (this.user === S.cfg.user && arg === S.cfg.pass) this.authed = true
      if (!this.authed) { S.hit('FTP 密码错误'); return this.reply(530, 'Login incorrect') }
      S.hit(`FTP ${this.user} 登录`)
      return this.reply(230, 'Login ok')
    }
    if (cmd === 'QUIT') { this.reply(221, 'Bye'); return this.close() }
    if (cmd === 'NOOP') return this.reply(200, 'OK')
    if (!this.authed) return this.reply(530, 'Please login')

    switch (cmd) {
      case 'SYST': return this.reply(215, 'UNIX Type: L8')
      case 'FEAT':
        return this.reply(211, 'Features:\nUTF8\nMLST type*;size*;modify*;\nMLSD\nSIZE\nMDTM\nREST STREAM\nEPSV\nPASV\n211 End')
      case 'OPTS': return this.reply(200, 'OK')
      case 'TYPE': this.binary = !/^A/i.test(arg); return this.reply(200, 'OK')
      case 'PWD': return this.reply(257, `"${this.cwd}"`)
      case 'CWD': {
        const t = this.target(arg)
        if (!t) return this.reply(550, 'No such directory')
        try {
          const st = await fsp.stat(t)
          if (!st.isDirectory()) return this.reply(550, 'Not a directory')
          this.cwd = this.vpath(arg)
          return this.reply(250, 'OK')
        } catch { return this.reply(550, 'No such directory') }
      }
      case 'CDUP': this.cwd = path.posix.dirname(this.cwd); return this.reply(250, 'OK')
      case 'MKD': return this.doMkd(arg)
      case 'RMD': return this.doRmd(arg)
      case 'DELE': return this.doDele(arg)
      case 'RNFR': {
        const t = this.target(arg)
        if (!t) return this.reply(550, 'Not found')
        try { await fsp.stat(t) } catch { return this.reply(550, 'Not found') }
        this.renameFrom = t
        return this.reply(350, 'Ready for RNTO')
      }
      case 'RNTO': {
        if (!this.renameFrom) return this.reply(503, 'RNFR first')
        if (S.cfg.readOnly) return this.reply(550, 'Read only')
        const t = this.target(arg)
        if (!t) return this.reply(550, 'Bad target')
        try { await fsp.rename(this.renameFrom, t); this.renameFrom = null; S.hit('FTP 改名'); return this.reply(250, 'OK') }
        catch (e) { return this.reply(550, msg(e)) }
      }
      case 'SIZE': {
        const t = this.target(arg)
        if (!t) return this.reply(550, 'Not found')
        try { const st = await fsp.stat(t); if (st.isDirectory()) return this.reply(550, 'Is a directory'); return this.reply(213, String(st.size)) }
        catch { return this.reply(550, 'Not found') }
      }
      case 'MDTM': {
        const t = this.target(arg)
        if (!t) return this.reply(550, 'Not found')
        try { const st = await fsp.stat(t); return this.reply(213, new Date(st.mtime).toISOString().replace(/[-:T]/g, '').slice(0, 14)) }
        catch { return this.reply(550, 'Not found') }
      }
      case 'REST': this.rest = Number(arg) || 0; return this.reply(350, 'Restarting at ' + this.rest)
      case 'PASV': return this.doPasv(false)
      case 'EPSV': return this.doPasv(true)
      case 'PORT': case 'EPRT': return this.reply(502, 'Use PASV')
      case 'LIST': case 'NLST': case 'MLSD': return this.doList(cmd, arg)
      case 'RETR': return this.doRetr(arg)
      case 'STOR': case 'APPE': return this.doStor(cmd, arg)
      case 'ABOR': return this.reply(226, 'Aborted')
      case 'MLST': {
        const t = this.target(arg || this.cwd)
        if (!t) return this.reply(550, 'Not found')
        try {
          const st = await fsp.stat(t)
          const name = path.posix.basename(this.vpath(arg || this.cwd)) || '/'
          return this.reply(250, `Listing ${this.vpath(arg || this.cwd)}\n ${mlsdLine(name, st, st.isDirectory())}`)
        } catch { return this.reply(550, 'Not found') }
      }
      default: return this.reply(502, 'Command not implemented: ' + cmd)
    }
  }

  // 虚拟 / 真实路径
  vpath(arg) {
    const a = String(arg || '').trim()
    if (a === '') return this.cwd
    const base = a.startsWith('/') ? '/' : this.cwd
    return path.posix.normalize(path.posix.join(base, a))
  }

  target(arg) {
    const r = resolvePath(this.share.cfg.mode, this.vpath(arg))
    if (!r || r.synthetic || !r.real) return null
    if (!inside(r.root, r.real)) return null
    return r.real
  }

  async doMkd(arg) {
    if (this.share.cfg.readOnly) return this.reply(550, 'Read only')
    const t = this.target(arg)
    if (!t) return this.reply(550, 'Bad path')
    try { await fsp.mkdir(t); this.share.hit('FTP 新建目录'); return this.reply(257, `"${this.vpath(arg)}" created`) }
    catch (e) { return this.reply(550, msg(e)) }
  }

  async doRmd(arg) {
    if (this.share.cfg.readOnly) return this.reply(550, 'Read only')
    const t = this.target(arg)
    if (!t) return this.reply(550, 'Bad path')
    try { await fsp.rmdir(t); this.share.hit('FTP 删除目录'); return this.reply(250, 'OK') }
    catch (e) { return this.reply(550, msg(e)) }
  }

  async doDele(arg) {
    if (this.share.cfg.readOnly) return this.reply(550, 'Read only')
    const t = this.target(arg)
    if (!t) return this.reply(550, 'Bad path')
    try { await fsp.unlink(t); this.share.hit('FTP 删除文件'); return this.reply(250, 'OK') }
    catch (e) { return this.reply(550, msg(e)) }
  }

  async doPasv(epsv) {
    this.dataServer?.close()
    const server = net.createServer()
    this.dataServer = server
    await new Promise((res) => server.listen(0, '0.0.0.0', res))
    const port = server.address().port
    server.once('connection', (s) => { this.dataSock = s; s.on('error', () => {}) })
    server.once('error', () => {})
    server.unref()
    const local = String(this.sock.localAddress || '127.0.0.1').replace('::ffff:', '')
    if (epsv) return this.reply(229, `Entering Extended Passive Mode (|||${port}|)`)
    const oct = local.split('.').map((n) => Number(n) || 0)
    this.reply(227, `Entering Passive Mode (${oct.join(',')},${port >> 8},${port & 255})`)
  }

  async openData() {
    if (!this.dataSock) {
      if (!this.dataServer) throw new Error('先发 PASV')
      let timer
      this.dataSock = await Promise.race([
        new Promise((res, rej) => { this.dataServer.once('connection', res); this.dataServer.once('error', rej) }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('数据连接超时')), 15000) }),
      ]).finally(() => clearTimeout(timer))
      this.dataServer.close()
    }
    return this.dataSock
  }

  async doList(cmd, arg) {
    const vp = this.vpath(arg.replace(/^-\S+\s*/, '') || this.cwd)
    const r = resolvePath(this.share.cfg.mode, vp)
    if (!r) return this.reply(550, 'No such directory')
    let entries = []
    try {
      if (r.synthetic) {
        for (const root of r.synthetic) {
          try { entries.push({ name: root.name, st: await fsp.stat(root.real), dir: true }) } catch {}
        }
      } else {
        const st = await fsp.stat(r.real)
        if (st.isFile()) entries = [{ name: path.basename(r.real), st, dir: false }]
        else {
          for (const ent of await fsp.readdir(r.real, { withFileTypes: true })) {
            try {
              const s = await fsp.stat(path.join(r.real, ent.name))
              entries.push({ name: ent.name, st: s, dir: s.isDirectory() })
            } catch {}
          }
        }
      }
    } catch (e) { return this.reply(550, msg(e)) }

    this.reply(150, 'Opening data connection')
    let data
    if (cmd === 'NLST') data = entries.map((e) => e.name + '\r\n').join('')
    else if (cmd === 'MLSD') data = entries.map((e) => mlsdLine(e.name, e.st, e.dir) + '\r\n').join('')
    else data = entries.map((e) => lsLine(e.name, e.st, e.dir) + '\r\n').join('')
    try {
      const ds = await this.openData()
      ds.end(data, () => this.reply(226, 'Transfer complete'))
      this.dataSock = null
    } catch (e) { this.reply(426, msg(e)) }
  }

  async doRetr(arg) {
    const t = this.target(arg)
    if (!t) return this.reply(550, 'Bad path')
    let st
    try { st = await fsp.stat(t); if (st.isDirectory()) return this.reply(550, 'Is a directory') }
    catch (e) { return this.reply(550, msg(e)) }
    this.reply(150, 'Opening data connection')
    try {
      const ds = await this.openData()
      this.dataSock = null
      const rs = fs.createReadStream(t, { start: this.rest || 0 })
      this.rest = 0
      rs.on('error', (e) => { ds.destroy(); this.reply(550, msg(e)) })
      ds.on('error', () => rs.destroy())
      ds.on('close', () => { if (!ds.writableEnded) rs.destroy() })
      rs.pipe(ds)
      ds.on('finish', () => { this.share.addBytes(st.size); this.share.hit(`FTP 下载 ${path.basename(t)}`); this.reply(226, 'Transfer complete') })
    } catch (e) { this.reply(426, msg(e)) }
  }

  async doStor(cmd, arg) {
    if (this.share.cfg.readOnly) return this.reply(550, 'Read only')
    const t = this.target(arg)
    if (!t) return this.reply(550, 'Bad path')
    this.reply(150, 'Opening data connection')
    try {
      const ds = await this.openData()
      this.dataSock = null
      await fsp.mkdir(path.dirname(t), { recursive: true })
      const opts = cmd === 'APPE' ? { flags: 'a' } : this.rest ? { flags: 'r+', start: this.rest } : { flags: 'w' }
      this.rest = 0
      const ws = fs.createWriteStream(t, opts)
      ds.on('error', () => ws.destroy())
      ds.pipe(ws)
      ws.on('error', (e) => { ds.destroy(); this.reply(550, msg(e)) })
      ws.on('finish', () => {
        try { this.share.addBytes(fs.statSync(t).size) } catch {}
        this.share.hit(`FTP 上传 ${path.basename(t)}`)
        this.reply(226, 'Transfer complete')
      })
    } catch (e) { this.reply(426, msg(e)) }
  }
}

function msg(e) {
  const s = String(e?.code || e?.message || e)
  const map = {
    ENOENT: '文件不存在', EACCES: '没有权限', EPERM: '没有权限', EEXIST: '已存在',
    ENOTEMPTY: '目录不是空的', EISDIR: '这是目录', ENOTDIR: '不是目录', EROFS: '只读文件系统',
    ENAMETOOLONG: '名字太长', EXDEV: '不能跨分区移动',
  }
  return map[s] || '操作失败：' + s
}

// ─────────────────────────────────────────────────────────────── WebDAV
const DAV_HEADERS = {
  DAV: '1, 2',
  'MS-Author-Via': 'DAV',
  Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, PROPPATCH, MOVE, COPY, LOCK, UNLOCK',
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])
}

function davEntry(href, name, st, isDir) {
  return `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>`
    + `<D:displayname>${xmlEscape(name)}</D:displayname>`
    + `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>`
    + (isDir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength><D:getcontenttype>${mime(name)}</D:getcontenttype>`)
    + `<D:getlastmodified>${new Date(st.mtime).toUTCString()}</D:getlastmodified>`
    + `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
}

function mime(name) {
  const ext = path.extname(name).toLowerCase()
  const table = {
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json',
    '.js': 'application/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.apk': 'application/vnd.android.package-archive', '.zip': 'application/zip',
    '.pdf': 'application/pdf',
  }
  return table[ext] || 'application/octet-stream'
}

// 探一下这个端口上是不是已经有一个 dir-share 在跑（引擎重启、旧实例没退干净时常见）
export function probeShare(port, timeout = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    let buf = ''
    const done = (v) => { try { sock.destroy() } catch {} ; resolve(v) }
    const timer = setTimeout(() => done(false), timeout)
    sock.once('connect', () => {})
    sock.on('data', (d) => {
      buf += d.toString()
      if (buf.includes('dir-share')) { clearTimeout(timer); done(true) }
      else if (buf.length > 120) { clearTimeout(timer); done(false) }
    })
    sock.on('error', () => { clearTimeout(timer); done(false) })
    sock.on('close', () => { clearTimeout(timer); done(false) })
  })
}

// ─────────────────────────────────────────────────────────────── 共享实例
export function createShare(cfg) {
  const state = {
    cfg,
    ftpServer: null,
    davServer: null,
    sessions: new Set(),
    bytes: 0,
    hits: 0,
    log: [],
    startedAt: 0,
    external: false,
  }

  const api = {
    cfg,
    get bytes() { return state.bytes },
    get hits() { return state.hits },
    get log() { return state.log },
    get startedAt() { return state.startedAt },
    addBytes(n) { state.bytes += Number(n) || 0 },
    hit(text) {
      state.hits++
      state.log.unshift({ t: Date.now(), text: String(text).slice(0, 80) })
      if (state.log.length > 30) state.log.length = 30
    },
    get running() { return state.external || Boolean(state.ftpServer || state.davServer) },
    get external() { return state.external },
  }

  function authOk(header) {
    if (!header || !header.startsWith('Basic ')) return false
    let raw = ''
    try { raw = Buffer.from(header.slice(6), 'base64').toString('utf8') } catch { return false }
    const i = raw.indexOf(':')
    if (i < 0) return false
    const u = raw.slice(0, i)
    const p = raw.slice(i + 1)
    if (cfg.anonymous && u === 'anonymous') return true
    return u === cfg.user && p === cfg.pass
  }

  async function startFtp() {
    if (state.ftpServer) return
    const server = net.createServer((sock) => {
      const sess = new FtpSession(api, sock)
      state.sessions.add(sess)
      sock.on('close', () => state.sessions.delete(sess))
    })
    server.on('error', (e) => { api.hit('FTP 启动失败：' + msg(e)) })
    await new Promise((res, rej) => {
      server.once('error', rej)
      server.listen(cfg.ftpPort, '0.0.0.0', () => { server.removeListener('error', rej); res() })
    })
    server.unref()
    state.ftpServer = server
  }

  async function startDav() {
    if (state.davServer) return
    const server = http.createServer((req, res) => handleDav(req, res))
    server.on('error', (e) => api.hit('WebDAV 启动失败：' + msg(e)))
    await new Promise((res, rej) => {
      server.once('error', rej)
      server.listen(cfg.davPort, '0.0.0.0', () => { server.removeListener('error', rej); res() })
    })
    server.unref()
    state.davServer = server
  }

  async function handleDav(req, res) {
    if (cfg.anonymous && !req.headers.authorization) {
      // 允许匿名，不拦
    } else if (!authOk(req.headers.authorization)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dir-share"', ...DAV_HEADERS })
      return res.end('需要登录')
    }
    let url
    try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch { url = '/' }
    const r = resolvePath(cfg.mode, url)
    if (!r) { res.writeHead(404, DAV_HEADERS); return res.end() }
    const method = req.method

    if (method === 'OPTIONS') { res.writeHead(200, DAV_HEADERS); return res.end() }
    if (method === 'LOCK' || method === 'UNLOCK') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', ...DAV_HEADERS })
      if (method === 'LOCK') {
        return res.end('<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>opaquelocktoken:' + Date.now().toString(16) + '</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>')
      }
      return res.end('')
    }

    if (method === 'PROPFIND') {
      const depth = String(req.headers.depth || '1')
      let body = ''
      if (r.synthetic) {
        body += davEntry(url.endsWith('/') ? url : url + '/', '/', { mtime: Date.now(), size: 0 }, true)
        for (const root of r.synthetic) {
          try {
            const st = await fsp.stat(root.real)
            body += davEntry(`${url.replace(/\/$/, '')}${url === '/' ? '' : '/'}${root.name}/`, root.name, st, true)
          } catch {}
        }
      } else {
        let st
        try { st = await fsp.stat(r.real) } catch { res.writeHead(404, DAV_HEADERS); return res.end() }
        const href = url.endsWith('/') ? url : url + (st.isDirectory() ? '/' : '')
        body += davEntry(href, path.basename(r.real) || '/', st, st.isDirectory())
        if (st.isDirectory() && depth !== '0') {
          try {
            for (const ent of await fsp.readdir(r.real, { withFileTypes: true })) {
              try {
                const s = await fsp.stat(path.join(r.real, ent.name))
                body += davEntry(`${href}${encodeURIComponent(ent.name)}${s.isDirectory() ? '/' : ''}`, ent.name, s, s.isDirectory())
              } catch {}
            }
          } catch {}
        }
      }
      const xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', ...DAV_HEADERS })
      return res.end(xml)
    }

    if (r.synthetic && method !== 'GET') { res.writeHead(405, DAV_HEADERS); return res.end() }

    if (method === 'GET' || method === 'HEAD') {
      let st
      try { st = await fsp.stat(r.real) } catch { res.writeHead(404, DAV_HEADERS); return res.end() }
      if (st.isDirectory()) {
        try {
          const items = await fsp.readdir(r.real, { withFileTypes: true })
          const rows = items.map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${xmlEscape(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`).join('')
          const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${xmlEscape(url)}</title><style>body{font:16px -apple-system,sans-serif;padding:16px;background:#111;color:#eee}a{color:#7cc4ff;text-decoration:none;display:block;padding:6px 0}li{list-style:none}</style><h3>${xmlEscape(url)}</h3><ul>${rows}</ul>`
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...DAV_HEADERS })
          return res.end(method === 'HEAD' ? '' : html)
        } catch (e) { res.writeHead(500, DAV_HEADERS); return res.end(msg(e)) }
      }
      api.addBytes(st.size)
      api.hit(`DAV 下载 ${path.basename(r.real)}`)
      res.writeHead(200, { 'Content-Type': mime(r.real), 'Content-Length': st.size, ...DAV_HEADERS })
      if (method === 'HEAD') return res.end()
      return fs.createReadStream(r.real).on('error', () => res.destroy()).pipe(res)
    }

    if (method === 'PUT') {
      if (cfg.readOnly) { res.writeHead(403, DAV_HEADERS); return res.end('只读') }
      await fsp.mkdir(path.dirname(r.real), { recursive: true }).catch(() => {})
      const ws = fs.createWriteStream(r.real)
      let size = 0
      req.on('data', (c) => { size += c.length })
      req.pipe(ws)
      ws.on('error', (e) => { res.writeHead(500, DAV_HEADERS); res.end(msg(e)) })
      ws.on('finish', () => {
        api.addBytes(size)
        api.hit(`DAV 上传 ${path.basename(r.real)}`)
        res.writeHead(201, DAV_HEADERS)
        res.end()
      })
      return
    }

    if (method === 'MKCOL') {
      if (cfg.readOnly) { res.writeHead(403, DAV_HEADERS); return res.end('只读') }
      try { await fsp.mkdir(r.real); api.hit('DAV 新建目录'); res.writeHead(201, DAV_HEADERS); return res.end() }
      catch (e) { res.writeHead(409, DAV_HEADERS); return res.end(msg(e)) }
    }

    if (method === 'DELETE') {
      if (cfg.readOnly) { res.writeHead(403, DAV_HEADERS); return res.end('只读') }
      try { await fsp.rm(r.real, { recursive: true }); api.hit('DAV 删除'); res.writeHead(204, DAV_HEADERS); return res.end() }
      catch (e) { res.writeHead(500, DAV_HEADERS); return res.end(msg(e)) }
    }

    if (method === 'MOVE' || method === 'COPY') {
      if (cfg.readOnly) { res.writeHead(403, DAV_HEADERS); return res.end('只读') }
      let dest = ''
      try { dest = decodeURIComponent(new URL(req.headers.destination || '', 'http://x').pathname) } catch {}
      const d = resolvePath(cfg.mode, dest)
      if (!d || d.synthetic) { res.writeHead(400, DAV_HEADERS); return res.end('目标无效') }
      try {
        if (method === 'MOVE') await fsp.rename(r.real, d.real)
        else await fsp.cp(r.real, d.real, { recursive: true })
        api.hit(`DAV ${method === 'MOVE' ? '移动' : '复制'}`)
        res.writeHead(201, DAV_HEADERS)
        return res.end()
      } catch (e) { res.writeHead(500, DAV_HEADERS); return res.end(msg(e)) }
    }

    if (method === 'PROPPATCH') { res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', ...DAV_HEADERS }); return res.end('<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>' + xmlEscape(url) + '</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>') }

    res.writeHead(405, DAV_HEADERS)
    return res.end('不支持的方法')
  }

  // 注意：不能用 { ...api } —— 展开会把 bytes/hits/log/startedAt/running
  // 这几个 getter 当场求值成快照，之后面板永远读到「已停止」。
  const share = Object.create(Object.getPrototypeOf(api), Object.getOwnPropertyDescriptors(api))
  Object.assign(share, {
    async start() {
      if (api.running) return []
      const errors = []
      try { await startFtp() } catch (e) {
        if (msg(e).includes('EADDRINUSE') && await probeShare(cfg.ftpPort)) { state.external = true }
        else errors.push('FTP ' + msg(e))
      }
      try { await startDav() } catch (e) {
        if (msg(e).includes('EADDRINUSE') && state.external) { /* 旧实例同一套，忽略 */ }
        else errors.push('WebDAV ' + msg(e))
      }
      if (errors.length) api.hit(errors.join(' / '))
      state.startedAt = Date.now()
      return errors
    },
    async stop() {
      for (const s of state.sessions) s.close()
      state.sessions.clear()
      const close = (srv) => new Promise((res) => (srv ? srv.close(() => res()) : res()))
      await close(state.ftpServer); state.ftpServer = null
      await close(state.davServer); state.davServer = null
      state.external = false
      state.startedAt = 0
    },
  })
  return share
}

export function lanAddresses() {
  const out = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address })
    }
  }
  return out
}
