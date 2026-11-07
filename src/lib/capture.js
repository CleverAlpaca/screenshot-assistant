// 截图引擎：抓屏 → 覆盖层窗口池（复用以保证二次触发秒开）→ 完成动作分发 → 贴图窗口管理
// 坐标约定：与渲染层通信一律用逻辑像素（DIP）；导出图片由渲染层按 dpr 裁剪成物理分辨率
const {
  desktopCapturer,
  BrowserWindow,
  screen,
  clipboard,
  nativeImage,
  dialog,
  app,
  Notification,
  Menu,
} = require('electron')
const path = require('path')
const fs = require('fs')

const OVERLAY_HTML = path.join(__dirname, '..', 'renderer', 'overlay.html')
const PIN_HTML = path.join(__dirname, '..', 'renderer', 'pin.html')

function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `截图_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function webPrefs() {
  return {
    preload: path.join(__dirname, '..', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
  }
}

class CaptureController {
  constructor({ getSettings, onSaved, onRecord, log }) {
    this.getSettings = getSettings // () => settings
    this.onSaved = onSaved // (filePath|null) => void  保存成功后通知
    this.onRecord = onRecord // (dataUrl) => void  完成的截图写入历史
    this.log = log || (() => {}) // 应用内文件日志
    this.overlays = new Map() // displayId -> { win, loaded, captureReady }
    this.poolKey = '' // 覆盖层池对应的显示器拓扑签名
    this.pins = new Map() // webContents.id -> { win, dataUrl, scale, opacity }
    this.session = null // { count, ready:Set } 进行中的截图会话
    this.finishing = false
  }

  isActive() {
    return !!this.session
  }

  // ---- 抓屏：逐屏按物理分辨率抓，混合 DPI 不发虚 ----
  async grabAll(displays) {
    const grabs = await Promise.all(
      displays.map(async (display) => {
        const phys = {
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor),
        }
        let sources
        try {
          sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: phys })
        } catch {
          return null
        }
        const src =
          sources.find((s) => s.display_id === String(display.id)) || sources.find((s) => !s.thumbnail.isEmpty())
        if (!src || src.thumbnail.isEmpty()) return null
        return { display, dataUrl: src.thumbnail.toDataURL() }
      })
    )
    const ok = grabs.filter(Boolean)
    if (!ok.length) throw new Error('屏幕抓取失败')
    return ok
  }

  // ---- 覆盖层窗口池 ----
  topologyKey(displays) {
    return displays
      .map((d) => `${d.id}:${d.size.width}x${d.size.height}@${d.scaleFactor}`)
      .sort()
      .join('|')
  }

  createOverlay(display) {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.size.width,
      height: display.size.height,
      frame: false,
      transparent: true, // 首帧渲染前透出桌面，避免闪黑/闪白
      thickFrame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: webPrefs(),
    })
    win.setAlwaysOnTop(true, 'screen-saver') // 盖住任务栏
    // 渲染层日志转发到主进程 stdout（开发排查用）
    win.webContents.on('console-message', (e) => {
      const msg = typeof e === 'object' && e.message !== undefined ? e.message : e
      this.log('[overlay]', msg)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      this.log('[overlay] RENDER GONE:', JSON.stringify(details))
    })
    win.webContents.on('preload-error', (_e, p, err) => {
      this.log('[overlay] preload-error:', p, err.message)
    })
    const loaded = new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve)
      setTimeout(resolve, 3000) // 兜底：加载异常时不卡死截图流程
    })
    const entry = { win, loaded, displayId: display.id }
    win.on('closed', () => {
      for (const [id, e] of this.overlays) if (e === entry) this.overlays.delete(id)
    })
    win.loadFile(OVERLAY_HTML)
    return entry
  }

  async ensurePool(displays) {
    const key = this.topologyKey(displays)
    if (key !== this.poolKey || this.overlays.size !== displays.length) {
      for (const [, e] of this.overlays) if (!e.win.isDestroyed()) e.win.destroy()
      this.overlays.clear()
      this.poolKey = key
      for (const d of displays) this.overlays.set(d.id, this.createOverlay(d))
    }
    await Promise.all([...this.overlays.values()].map((e) => e.loaded))
  }

  hideOverlays() {
    for (const [, e] of this.overlays) {
      if (!e.win.isDestroyed() && e.win.isVisible()) e.win.hide()
    }
  }

  // ---- 会话 ----
  async start() {
    if (this.session || this.finishing) return
    // 立即占位会话，防止快速连按 F1 时两次 start() 并发重入（session 此前在抓屏/建池后才赋值）
    this.session = { count: 0, ready: new Set(), shown: false, t0: Date.now() }
    const t0 = Date.now()
    const displays = screen.getAllDisplays()
    let grabs
    try {
      grabs = await this.grabAll(displays)
    } catch (err) {
      this.session = null // 释放占位会话，否则后续截图永远被阻断
      this.notifyError('截图失败', String(err.message || err))
      return
    }
    this.log('[perf] grabAll:', Date.now() - t0, 'ms')
    await this.ensurePool(displays)
    this.log('[perf] pool ready:', Date.now() - t0, 'ms')
    this.session.count = grabs.length
    for (const { display, dataUrl } of grabs) {
      const entry = this.overlays.get(display.id)
      if (!entry || entry.win.isDestroyed()) continue
      entry.win.webContents.send('capture:init', {
        displayId: display.id,
        dataUrl,
        dpr: display.scaleFactor,
        width: display.size.width,
        height: display.size.height,
        x: display.bounds.x,
        y: display.bounds.y,
        pinOpacity: this.getSettings().pinOpacity,
      })
    }
    // 兜底：个别渲染层未应答也强制显示
    setTimeout(() => this.showOverlays(), 900)
  }

  onCaptureReady(displayId) {
    if (!this.session) return
    this.session.ready.add(displayId)
    if (this.session.ready.size >= this.session.count) this.showOverlays()
  }

  showOverlays() {
    if (!this.session || this.session.shown) return
    this.session.shown = true
    this.log('[perf] capture:ready -> shown, since grab:', this.session.t0 ? Date.now() - this.session.t0 : '?', 'ms')
    const cursor = screen.getCursorScreenPoint()
    let focusWin = null
    for (const [, e] of this.overlays) {
      if (e.win.isDestroyed()) continue
      e.win.show()
      const b = e.win.getBounds()
      if (cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) focusWin = e.win
    }
    if (focusWin) focusWin.focus()
  }

  cancel() {
    if (!this.session) return
    this.session = null
    this.hideOverlays()
  }

  // ---- 完成动作 ----
  async finish(action, payload) {
    if (!this.session) return
    this.session = null
    this.finishing = true
    this.hideOverlays()
    // 覆盖层淡出瞬间桌面尚未恢复，延迟一帧再执行动作，避免把遮罩截进保存对话框
    await new Promise((r) => setTimeout(r, 80))
    this.finishing = false
    try {
      if (action === 'copy') {
        clipboard.writeImage(nativeImage.createFromDataURL(payload.dataUrl))
        if (this.onRecord) this.onRecord(payload.dataUrl)
      } else if (action === 'save') {
        const filePath = await this.saveImage(payload.dataUrl)
        if (filePath) {
          if (this.onSaved) this.onSaved(filePath)
          if (this.onRecord) this.onRecord(payload.dataUrl)
        }
      } else if (action === 'pin') {
        const display = screen.getDisplayNearestPoint({ x: payload.screenX, y: payload.screenY })
        const x = display.bounds.x + payload.rect.x
        const y = display.bounds.y + payload.rect.y
        this.createPin(payload.dataUrl, { x, y, width: payload.rect.w, height: payload.rect.h }, payload.opacity)
        if (this.onRecord) this.onRecord(payload.dataUrl)
      }
    } catch (err) {
      this.notifyError('操作失败', String(err.message || err))
    }
  }

  async saveImage(dataUrl, parentWin) {
    const s = this.getSettings()
    const dir = s.saveDir || path.join(app.getPath('pictures'), '截图助手')
    const filePath0 = path.join(dir, stampName() + '.png')
    if (s.saveMode === 'auto') {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filePath0, Buffer.from(dataUrl.split(',')[1], 'base64'))
      return filePath0
    }
    const { canceled, filePath } = await dialog.showSaveDialog(parentWin || null, {
      defaultPath: filePath0,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    if (canceled || !filePath) return null
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, Buffer.from(dataUrl.split(',')[1], 'base64'))
    return filePath
  }

  notifyError(title, body) {
    if (!Notification.isSupported()) return
    new Notification({ title, body, icon: path.join(__dirname, '..', '..', 'assets', 'tray.png') }).show()
  }

  // ---- 贴图窗口 ----
  createPin(dataUrl, rect, opacity) {
    const win = new BrowserWindow({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(24, Math.round(rect.width)),
      height: Math.max(24, Math.round(rect.height)),
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: webPrefs(),
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setContentProtection(true) // 贴图不进入下一次截图（对齐 Snipaste 行为）
    const wcId = win.webContents.id
    const meta = { win, dataUrl, scale: 1, opacity: Math.min(100, Math.max(20, opacity || 100)) }
    this.pins.set(wcId, meta)
    win.on('closed', () => this.pins.delete(wcId))
    win.loadFile(PIN_HTML).then(() => {
      win.webContents.send('pin:init', { dataUrl, opacity: meta.opacity })
      win.setOpacity(meta.opacity / 100)
      win.show()
    })
  }

  pinByEvent(e) {
    const meta = this.pins.get(e.sender.id)
    return meta && !meta.win.isDestroyed() ? meta : null
  }

  pinDrag(e, dx, dy) {
    const meta = this.pinByEvent(e)
    if (!meta) return
    const b = meta.win.getBounds()
    meta.win.setPosition(b.x + Math.round(dx), b.y + Math.round(dy))
  }

  pinZoom(e, info) {
    const meta = this.pinByEvent(e)
    if (!meta) return
    const factor = info.deltaY < 0 ? 1.1 : 1 / 1.1
    const next = Math.min(5, Math.max(0.15, meta.scale * factor))
    if (next === meta.scale) return
    const ratio = next / meta.scale
    const b = meta.win.getBounds()
    const newW = Math.round(b.width * ratio)
    const newH = Math.round(b.height * ratio)
    if (newW < 24 || newH < 24 || newW > 12000 || newH > 12000) return
    // 以光标为锚点缩放：光标下的图像点保持不动
    const ax = (info.screenX - b.x) / b.width
    const ay = (info.screenY - b.y) / b.height
    meta.win.setBounds({
      x: Math.round(info.screenX - ax * newW),
      y: Math.round(info.screenY - ay * newH),
      width: newW,
      height: newH,
    })
    meta.scale = next
  }

  pinMenu(e) {
    const meta = this.pinByEvent(e)
    if (!meta) return
    const { win, dataUrl, opacity } = meta
    Menu.popup({
      window: win,
      menu: Menu.buildFromTemplate([
        {
          label: '复制图片',
          click: () => clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)),
        },
        {
          label: '另存为…',
          click: async () => {
            const filePath = await this.saveImage(dataUrl, win)
            if (filePath && this.onSaved) this.onSaved(filePath)
          },
        },
        { type: 'separator' },
        {
          label: '不透明度',
          submenu: [100, 80, 60, 40].map((v) => ({
            label: `${v}%`,
            type: 'radio',
            checked: opacity === v,
            click: () => {
              meta.opacity = v
              win.setOpacity(v / 100)
            },
          })),
        },
        { type: 'separator' },
        { label: '关闭贴图', click: () => win.close() },
      ]),
    })
  }

  closeAllPins() {
    for (const [, m] of this.pins) if (!m.win.isDestroyed()) m.win.close()
  }
}

module.exports = { CaptureController }
