// 截图覆盖层交互：冻结背景 → 框选（可移动/重调）→ 标注 → 复制/保存/贴图
// 坐标约定：页面内一律逻辑像素；导出时按 dpr 放大到物理分辨率裁剪
(() => {
  const api = window.shotAPI
  window.addEventListener('error', (e) => console.error('[overlay] error:', e.message, e.filename, e.lineno))
  const $ = (s) => document.querySelector(s)

  const bgCanvas = $('#bg')
  const annotCanvas = $('#annot')
  const dim = $('#dim')
  const selBox = $('#selBox')
  const sizeLabel = $('#sizeLabel')
  const mag = $('#mag')
  const magHex = $('#magHex')
  const toolbar = $('#toolbar')
  const textInput = $('#textInput')
  const winHl = $('#winHl')
  const undoBtn = $('#undoBtn')
  const redoBtn = $('#redoBtn')
  const colorBtn = $('#colorBtn')
  const widthBtn = $('#widthBtn')
  const colorDot = $('#colorDot')
  const widthDot = $('#widthDot')
  const tbPop = $('#tbPop')
  const popSwatches = $('#popSwatches')
  const popWidths = $('#popWidths')
  const ocrBtn = $('#ocrBtn')
  const ocrPanel = $('#ocrPanel')
  const ocrTitle = $('#ocrTitle')
  const ocrLinesBox = $('#ocrLines')
  const toast = $('#toast')

  const MAG = 120
  const ZOOM = 8 // 放大镜倍数（同时是像素网格间距）
  const MOSAIC_BLOCK = 8 // 马赛克块大小（逻辑像素）
  const MIN_SEL = 4
  const TOOLS = ['rect', 'ellipse', 'arrow', 'pen', 'marker', 'text', 'mosaic']
  const COLORS = ['#e5484d', '#ef9f43', '#f5cf3a', '#27a875', '#3d8be9', '#9d7bea', '#1a2036', '#ffffff']

  let dpr = 1, W = 0, H = 0, originX = 0, originY = 0, displayId = null, pinOpacity = 100
  let bgCtx = null, annotCtx = null, magCtx = null
  let bgImg = null
  let mosaicCanvas = null
  let pixels = null // bgCanvas 的 ImageData（首次用放大镜时读一次，之后查表取色）

  let state = 'idle' // idle | dragging | selected | moving | resizing | drawing
  let sel = null // {x,y,w,h} 逻辑像素
  let shapes = []
  let redoShapes = []
  let tool = null
  let color = COLORS[0]
  let strokeW = 2

  let dragStart = null
  let moveOrig = null
  let resizeDir = ''
  let curShape = null
  let lastPt = null
  let textPos = null

  let ocrPanelOpen = false
  let ocrBusy = false
  let toastTimer = null

  let popOpen = false // 颜色/粗细弹层
  let tbOff = { x: 0, y: 0 } // 工具条手动拖拽偏移
  let tbDrag = null // { sx, sy, ox, oy }

  let winHlRect = null
  let winQueryBusy = false
  let winPending = null

  // ---------- 画布 ----------
  function setupCanvas(c, readFrequently) {
    c.width = Math.max(1, Math.round(W * dpr))
    c.height = Math.max(1, Math.round(H * dpr))
    c.style.width = W + 'px'
    c.style.height = H + 'px'
    const ctx = c.getContext('2d', readFrequently ? { willReadFrequently: true } : undefined)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
  }

  function buildMosaic() {
    mosaicCanvas = document.createElement('canvas')
    mosaicCanvas.width = Math.max(1, Math.round(W / MOSAIC_BLOCK))
    mosaicCanvas.height = Math.max(1, Math.round(H / MOSAIC_BLOCK))
    const c = mosaicCanvas.getContext('2d')
    c.imageSmoothingEnabled = true
    c.drawImage(bgImg, 0, 0, mosaicCanvas.width, mosaicCanvas.height)
  }

  // ---------- 选区 UI ----------
  function updateSelUI() {
    if (!sel) {
      selBox.style.display = 'none'
      sizeLabel.style.display = 'none'
      toolbar.style.display = 'none'
      dim.classList.remove('shade')
      dim.style.cssText = 'position:fixed;inset:0'
      return
    }
    dim.classList.add('shade')
    dim.style.cssText = 'position:fixed'
    dim.style.left = sel.x + 'px'
    dim.style.top = sel.y + 'px'
    dim.style.width = sel.w + 'px'
    dim.style.height = sel.h + 'px'
    selBox.style.display = 'block'
    selBox.style.left = sel.x + 'px'
    selBox.style.top = sel.y + 'px'
    selBox.style.width = sel.w + 'px'
    selBox.style.height = sel.h + 'px'
    // 贴屏幕边缘时给对应边的手柄做内移，避免被裁切
    selBox.classList.toggle('at-top', sel.y <= 1)
    selBox.classList.toggle('at-bottom', sel.y + sel.h >= H - 1)
    selBox.classList.toggle('at-left', sel.x <= 1)
    selBox.classList.toggle('at-right', sel.x + sel.w >= W - 1)
    sizeLabel.style.display = 'block'
    // 显示物理像素：与导出文件的实际尺寸一致（高 DPI 屏 logical ≠ physical）
    sizeLabel.textContent = `${Math.round(sel.w * dpr)} × ${Math.round(sel.h * dpr)}`
    const lx = Math.min(sel.x + sel.w, W) - 4
    const ly = Math.min(sel.y + sel.h, H) + 6
    sizeLabel.style.left = Math.max(4, lx - sizeLabel.offsetWidth) + 'px'
    sizeLabel.style.top = Math.min(H - 26, ly) + 'px'
    if (state === 'selected' && !ocrPanelOpen) positionToolbar()
  }

  function positionToolbar() {
    const wasHidden = toolbar.style.display !== 'flex'
    toolbar.style.display = 'flex'
    if (wasHidden) {
      // 入场动画只在「隐藏 → 显示」时播一次
      toolbar.classList.remove('tb-in')
      void toolbar.offsetWidth
      toolbar.classList.add('tb-in')
    }
    const tw = toolbar.offsetWidth
    const th = toolbar.offsetHeight
    // 候选位置：选区下方 → 选区上方 → 选区内底部；手动拖拽偏移叠加后整体夹紧，保证完整可见
    let y = sel.y + sel.h + 12 + tbOff.y
    if (y + th > H - 8) y = sel.y - th - 12 + tbOff.y
    if (y + th > H - 8 || y < 8) y = Math.max(8, Math.min(H - th - 8, sel.y + sel.h - th - 12 + tbOff.y))
    const x = Math.max(8, Math.min(W - tw - 8, sel.x + sel.w / 2 - tw / 2 + tbOff.x))
    toolbar.style.left = x + 'px'
    toolbar.style.top = y + 'px'
  }

  // ---------- 标注绘制 ----------
  function clipToSel(ctx) {
    if (!sel) return
    ctx.beginPath()
    ctx.rect(sel.x - 1, sel.y - 1, sel.w + 2, sel.h + 2)
    ctx.clip()
  }

  function fontSpec(size) {
    return `600 ${size}px -apple-system, "PingFang SC", "MiSans", "Microsoft YaHei UI", sans-serif`
  }

  function strokeSmoothPath(ctx, pts, width, strokeColor, alpha) {
    if (pts.length === 1) {
      ctx.beginPath()
      ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2)
      ctx.fillStyle = strokeColor
      ctx.globalAlpha = alpha
      ctx.fill()
      return
    }
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2
      const my = (pts[i].y + pts[i + 1].y) / 2
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last.x, last.y)
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = strokeColor
    ctx.globalAlpha = alpha
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  function drawMosaicSegment(ctx, from, to, brush) {
    // 沿线段按 brush/2 步长盖章：小图放大 8 倍回贴 → 块状马赛克
    ctx.save()
    clipToSel(ctx)
    ctx.imageSmoothingEnabled = false
    const dist = Math.hypot(to.x - from.x, to.y - from.y)
    const step = Math.max(brush / 2, 2)
    const n = Math.max(1, Math.ceil(dist / step))
    for (let i = 1; i <= n; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n }
      const sw = brush / MOSAIC_BLOCK
      ctx.drawImage(
        mosaicCanvas,
        p.x / MOSAIC_BLOCK - sw / 2,
        p.y / MOSAIC_BLOCK - sw / 2,
        sw,
        sw,
        p.x - brush / 2,
        p.y - brush / 2,
        brush,
        brush
      )
    }
    ctx.restore()
  }

  // incremental = { from, to }：绘制中的增量段（性能考虑，整笔完成后再全量重绘）
  function drawShape(ctx, s, incremental) {
    ctx.save()
    clipToSel(ctx)
    const width = s.width || 2
    if (s.type === 'pen' || s.type === 'marker') {
      const pts = incremental ? [incremental.from, incremental.to] : s.points
      strokeSmoothPath(ctx, pts, s.type === 'marker' ? width * 5 : width, s.color, s.type === 'marker' ? 0.35 : 1)
    } else if (s.type === 'rect') {
      ctx.lineWidth = width
      ctx.strokeStyle = s.color
      ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0)
    } else if (s.type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, Math.abs(s.x1 - s.x0) / 2, Math.abs(s.y1 - s.y0) / 2, 0, 0, Math.PI * 2)
      ctx.lineWidth = width
      ctx.strokeStyle = s.color
      ctx.stroke()
    } else if (s.type === 'arrow') {
      const dx = s.x1 - s.x0
      const dy = s.y1 - s.y0
      const ang = Math.atan2(dy, dx)
      const hl = Math.max(11, width * 3)
      ctx.beginPath()
      ctx.moveTo(s.x0, s.y0)
      ctx.lineTo(s.x1, s.y1)
      ctx.lineWidth = width
      ctx.lineCap = 'round'
      ctx.strokeStyle = s.color
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(s.x1, s.y1)
      ctx.lineTo(s.x1 - hl * Math.cos(ang - 0.42), s.y1 - hl * Math.sin(ang - 0.42))
      ctx.lineTo(s.x1 - hl * Math.cos(ang + 0.42), s.y1 - hl * Math.sin(ang + 0.42))
      ctx.closePath()
      ctx.fillStyle = s.color
      ctx.fill()
    } else if (s.type === 'mosaic') {
      if (incremental) {
        drawMosaicSegment(ctx, incremental.from, incremental.to, width * 5 + 8)
      } else {
        let prev = s.points[0]
        for (let i = 1; i < s.points.length; i++) {
          drawMosaicSegment(ctx, prev, s.points[i], width * 5 + 8)
          prev = s.points[i]
        }
      }
    } else if (s.type === 'text') {
      ctx.font = fontSpec(s.size)
      ctx.textBaseline = 'top'
      ctx.fillStyle = s.color
      ctx.fillText(s.text, s.x, s.y)
    }
    ctx.restore()
  }

  function redrawAll() {
    annotCtx.clearRect(0, 0, W, H)
    for (const s of shapes) drawShape(annotCtx, s)
    undoBtn.disabled = !shapes.length
    redoBtn.disabled = !redoShapes.length
  }

  // ---------- 放大镜 ----------
  function ensurePixels() {
    if (pixels || !bgImg) return
    pixels = bgCtx.getImageData(0, 0, bgCanvas.width, bgCanvas.height)
  }

  function pixelAt(lx, ly) {
    ensurePixels()
    if (!pixels) return [0, 0, 0]
    const px = Math.min(pixels.width - 1, Math.max(0, Math.round(lx * dpr)))
    const py = Math.min(pixels.height - 1, Math.max(0, Math.round(ly * dpr)))
    const i = (py * pixels.width + px) * 4
    return [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]]
  }

  const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase()

  function drawMagnifier(p) {
    if (!bgImg) {
      hideMagnifier()
      return
    }
    mag.style.display = 'block'
    magHex.style.display = 'block'
    let mx = p.x + 26
    let my = p.y + 26
    if (mx + MAG > W - 4) mx = p.x - MAG - 26
    if (my + MAG + 24 > H - 4) my = p.y - MAG - 26
    mag.style.left = Math.max(4, mx) + 'px'
    mag.style.top = Math.max(4, my) + 'px'
    magHex.style.left = Math.max(4, mx + MAG / 2 - 30) + 'px'
    magHex.style.top = Math.max(4, my) + MAG + 6 + 'px'

    magCtx.clearRect(0, 0, MAG, MAG)
    magCtx.save()
    magCtx.beginPath()
    magCtx.arc(MAG / 2, MAG / 2, MAG / 2 - 1, 0, Math.PI * 2)
    magCtx.clip()
    const srcL = MAG / ZOOM // 可见逻辑像素数
    magCtx.imageSmoothingEnabled = false
    magCtx.drawImage(
      bgImg,
      (p.x - srcL / 2) * dpr,
      (p.y - srcL / 2) * dpr,
      srcL * dpr,
      srcL * dpr,
      0,
      0,
      MAG,
      MAG
    )
    magCtx.imageSmoothingEnabled = true
    // 像素网格
    magCtx.strokeStyle = 'rgba(0,0,0,0.14)'
    magCtx.lineWidth = 1
    magCtx.beginPath()
    for (let g = ZOOM; g < MAG; g += ZOOM) {
      magCtx.moveTo(g, 0)
      magCtx.lineTo(g, MAG)
      magCtx.moveTo(0, g)
      magCtx.lineTo(MAG, g)
    }
    magCtx.stroke()
    // 中心十字
    magCtx.strokeStyle = 'rgba(255,255,255,0.95)'
    magCtx.beginPath()
    magCtx.moveTo(MAG / 2 - 7, MAG / 2)
    magCtx.lineTo(MAG / 2 + 7, MAG / 2)
    magCtx.moveTo(MAG / 2, MAG / 2 - 7)
    magCtx.lineTo(MAG / 2, MAG / 2 + 7)
    magCtx.stroke()
    magCtx.restore()

    const [r, g, b] = pixelAt(p.x, p.y)
    magHex.textContent = `#${hex2(r)}${hex2(g)}${hex2(b)} · ${Math.round(p.x * dpr)},${Math.round(p.y * dpr)}`
  }

  function hideMagnifier() {
    mag.style.display = 'none'
    magHex.style.display = 'none'
  }

  // ---------- 导出 ----------
  function exportSel() {
    const x = Math.max(0, Math.round(sel.x * dpr))
    const y = Math.max(0, Math.round(sel.y * dpr))
    const w = Math.min(bgCanvas.width - x, Math.round(sel.w * dpr))
    const h = Math.min(bgCanvas.height - y, Math.round(sel.h * dpr))
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const c = out.getContext('2d')
    c.drawImage(bgCanvas, x, y, w, h, 0, 0, w, h)
    c.drawImage(annotCanvas, x, y, w, h, 0, 0, w, h)
    return out.toDataURL('image/png')
  }

  function doAction(action) {
    if (!sel || sel.w < MIN_SEL || sel.h < MIN_SEL) return
    commitTextIfAny()
    const dataUrl = exportSel()
    api.overlay.finish(action, {
      dataUrl,
      rect: { x: Math.round(sel.x), y: Math.round(sel.y), w: Math.round(sel.w), h: Math.round(sel.h) },
      screenX: Math.round(originX + sel.x + sel.w / 2),
      screenY: Math.round(originY + sel.y + sel.h / 2),
      opacity: pinOpacity,
    })
  }

  // ---------- 工具条 ----------
  function setTool(t) {
    tool = tool === t ? null : t
    document.querySelectorAll('#toolbar .tb[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool)
    })
    hideTextInput(false)
  }

  function syncStyleDots() {
    colorDot.style.background = color
    const d = 2 + strokeW * 2 // 2→6px 4→10px 6→14px
    widthDot.style.width = d + 'px'
    widthDot.style.height = d + 'px'
  }

  function togglePop() {
    popOpen ? closePop() : openPop()
  }

  function openPop() {
    popOpen = true
    tbPop.style.display = 'block'
    const br = colorBtn.getBoundingClientRect()
    const pw = tbPop.offsetWidth
    const ph = tbPop.offsetHeight
    let x = br.left + br.width / 2 - pw / 2
    x = Math.max(8, Math.min(W - pw - 8, x))
    let y = toolbar.getBoundingClientRect().top - ph - 8
    if (y < 8) y = toolbar.getBoundingClientRect().bottom + 8
    tbPop.style.left = x + 'px'
    tbPop.style.top = y + 'px'
  }

  function closePop() {
    if (!popOpen) return
    popOpen = false
    tbPop.style.display = 'none'
  }

  function buildToolbar() {
    for (const c of COLORS) {
      const b = document.createElement('button')
      b.className = 'sw' + (c === color ? ' active' : '')
      b.style.background = c
      b.dataset.c = c
      b.title = c
      b.addEventListener('click', () => {
        color = c
        popSwatches.querySelectorAll('.sw').forEach((x) => x.classList.toggle('active', x.dataset.c === c))
        syncStyleDots()
      })
      popSwatches.appendChild(b)
    }
    popWidths.querySelectorAll('.pwd').forEach((b) => {
      b.addEventListener('click', () => {
        strokeW = Number(b.dataset.w)
        popWidths.querySelectorAll('.pwd').forEach((x) => x.classList.toggle('active', x === b))
        syncStyleDots()
        closePop()
      })
    })
    popWidths.querySelector(`[data-w="${strokeW}"]`)?.classList.add('active')
    syncStyleDots()
    colorBtn.addEventListener('click', togglePop)
    widthBtn.addEventListener('click', togglePop)
    document.querySelectorAll('#toolbar .tb[data-tool]').forEach((b) => {
      b.addEventListener('click', () => setTool(b.dataset.tool))
    })
    ocrBtn.addEventListener('click', runOcrNow)
    $('#ocrCopyAll').addEventListener('click', () => {
      const lines = [...ocrLinesBox.children].map((r) => r.textContent)
      api.clip.writeText(lines.join('\n'))
      showToast('已复制全部')
    })
    $('#ocrClose').addEventListener('click', closeOcrPanel)
    undoBtn.addEventListener('click', undo)
    redoBtn.addEventListener('click', redo)
    $('#copyBtn').addEventListener('click', () => doAction('copy'))
    $('#saveBtn').addEventListener('click', () => doAction('save'))
    $('#pinBtn').addEventListener('click', () => doAction('pin'))
    $('#closeBtn').addEventListener('click', () => api.overlay.cancel())
  }

  function undo() {
    if (!shapes.length) return
    redoShapes.push(shapes.pop())
    redrawAll()
  }
  function redo() {
    if (!redoShapes.length) return
    shapes.push(redoShapes.pop())
    redrawAll()
  }

  // ---------- 文字输入 ----------
  function hideTextInput(commit) {
    if (textInput.style.display !== 'block') return
    const val = textInput.value.trim()
    textInput.style.display = 'none'
    textInput.value = ''
    if (commit && val && textPos) {
      shapes.push({ type: 'text', x: textPos.x, y: textPos.y, text: val, color, size: 14 + strokeW * 3 })
      redrawAll()
    }
    textPos = null
  }
  const commitTextIfAny = () => hideTextInput(true)

  // ---------- OCR 文字识别 ----------
  function showToast(text) {
    if (!sel) return
    toast.textContent = text
    toast.style.display = 'block'
    toast.style.left = Math.max(8, sel.x + sel.w / 2 - toast.offsetWidth / 2) + 'px'
    toast.style.top = Math.max(8, sel.y - 36) + 'px'
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.style.display = 'none'), 1400)
  }

  function positionOcrPanel() {
    ocrPanel.style.display = 'block'
    const pw = ocrPanel.offsetWidth
    const ph = ocrPanel.offsetHeight
    let x = sel.x + sel.w / 2 - pw / 2
    x = Math.max(8, Math.min(W - pw - 8, x))
    let y = sel.y + sel.h + 12
    if (y + ph > H - 8) y = sel.y - ph - 12
    if (y < 8) y = Math.max(8, H - ph - 8)
    ocrPanel.style.left = x + 'px'
    ocrPanel.style.top = y + 'px'
  }

  function showOcrPanel(lines, lang) {
    ocrLinesBox.innerHTML = ''
    for (const line of lines) {
      const row = document.createElement('div')
      row.className = 'ocr-line'
      row.textContent = line
      row.title = '点击复制本行'
      row.addEventListener('click', () => {
        api.clip.writeText(line)
        showToast('已复制本行')
      })
      ocrLinesBox.appendChild(row)
    }
    ocrTitle.textContent = `文字识别 · ${lines.length} 行${lang ? ' · ' + lang : ''}`
    ocrPanelOpen = true
    toolbar.style.display = 'none'
    positionOcrPanel()
  }

  function closeOcrPanel() {
    if (!ocrPanelOpen) return
    ocrPanelOpen = false
    ocrPanel.style.display = 'none'
    if (state === 'selected') updateSelUI() // 恢复工具条
  }

  async function runOcrNow() {
    if (ocrBusy || !sel || sel.w < MIN_SEL || sel.h < MIN_SEL) return
    commitTextIfAny()
    ocrBusy = true
    ocrBtn.classList.add('busy')
    const dataUrl = exportSel()
    try {
      const r = await api.ocr.run(dataUrl)
      if (r && r.ok && r.lines && r.lines.length) {
        showOcrPanel(r.lines, r.lang)
      } else if (r && r.ok) {
        showToast('未识别到文字')
      } else {
        const code = r && r.code
        showToast(code === 'no_language' ? '系统未安装 OCR 语言包' : '识别失败')
      }
    } catch {
      showToast('识别失败')
    } finally {
      ocrBusy = false
      ocrBtn.classList.remove('busy')
    }
  }

  // ---------- 命中检测 ----------
  function handleAt(p) {
    if (!sel) return ''
    const pts = {
      nw: [sel.x, sel.y], n: [sel.x + sel.w / 2, sel.y], ne: [sel.x + sel.w, sel.y],
      w: [sel.x, sel.y + sel.h / 2], e: [sel.x + sel.w, sel.y + sel.h / 2],
      sw: [sel.x, sel.y + sel.h], s: [sel.x + sel.w / 2, sel.y + sel.h], se: [sel.x + sel.w, sel.y + sel.h],
    }
    for (const [dir, [hx, hy]] of Object.entries(pts)) {
      if (Math.abs(p.x - hx) <= 6 && Math.abs(p.y - hy) <= 6) return dir
    }
    return ''
  }
  const insideSel = (p) =>
    sel && p.x >= sel.x && p.x <= sel.x + sel.w && p.y >= sel.y && p.y <= sel.y + sel.h

  function applyResize(p) {
    const MIN = 8
    let s = { ...moveOrig.sel }
    if (resizeDir.includes('w')) {
      const right = s.x + s.w
      s.x = Math.min(Math.max(0, p.x), right - MIN)
      s.w = right - s.x
    }
    if (resizeDir.includes('e')) s.w = Math.min(W, Math.max(p.x, s.x + MIN)) - s.x
    if (resizeDir.includes('n')) {
      const bot = s.y + s.h
      s.y = Math.min(Math.max(0, p.y), bot - MIN)
      s.h = bot - s.y
    }
    if (resizeDir.includes('s')) s.h = Math.min(H, Math.max(p.y, s.y + MIN)) - s.y
    sel = s
    updateSelUI()
  }

  // ---------- 窗口智能识别 ----------
  function dimUniform() {
    // 无明确目标时：整屏均匀压暗
    dim.classList.remove('shade')
    dim.style.cssText = 'position:fixed;inset:0'
  }

  function dimShadeAt(x, y, w, h) {
    // 目标区域保持明亮，其余压暗
    dim.classList.add('shade')
    dim.style.cssText = 'position:fixed'
    dim.style.left = x + 'px'
    dim.style.top = y + 'px'
    dim.style.width = w + 'px'
    dim.style.height = h + 'px'
  }

  function hideWinHl() {
    winHlRect = null
    winHl.style.display = 'none'
    if (state === 'idle' && !sel) dimUniform() // 无高亮目标时回到整屏均匀压暗
  }

  function updateWinHl(r) {
    if (!r || r.w < 2 || r.h < 2) return hideWinHl()
    winHlRect = {
      x: Math.max(0, Math.round(r.x)),
      y: Math.max(0, Math.round(r.y)),
      w: Math.min(W, Math.round(r.w)),
      h: Math.min(H, Math.round(r.h)),
    }
    winHl.style.display = 'block'
    winHl.style.left = winHlRect.x + 'px'
    winHl.style.top = winHlRect.y + 'px'
    winHl.style.width = winHlRect.w + 'px'
    winHl.style.height = winHlRect.h + 'px'
    dimShadeAt(winHlRect.x, winHlRect.y, winHlRect.w, winHlRect.h) // 高亮窗口明亮、其余压暗
  }

  function scheduleWinQuery(p) {
    if (winQueryBusy) return
    winQueryBusy = true
    api.win
      .atPoint(originX + p.x, originY + p.y)
      .then((r) => {
        if (state === 'idle') updateWinHl(r)
      })
      .catch(() => {})
      .finally(() => setTimeout(() => (winQueryBusy = false), 40))
  }

  // ---------- 鼠标 ----------
  const onToolbar = (e) => !!(e.target.closest && e.target.closest('#toolbar'))

  // 工具条拖拽移动（抓空白处 / 分隔条）
  toolbar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (!(e.target === toolbar || e.target.classList?.contains('sep'))) return
    e.preventDefault()
    tbDrag = { sx: e.clientX, sy: e.clientY, ox: tbOff.x, oy: tbOff.y }
  })

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) {
      if (popOpen) closePop()
      return
    }
    // 点击弹层与工具条之外：先收弹层，再走正常选区交互
    if (popOpen && !e.target.closest?.('#tbPop') && !onToolbar(e)) closePop()
    if (onToolbar(e)) return
    if (ocrPanelOpen) {
      // 面板内点击交给按钮，面板外点击先收起面板再走正常选区交互
      if (e.target.closest && e.target.closest('#ocrPanel')) return
      closeOcrPanel()
    }
    // 捕获指针：拖拽移出窗口（多显示器边缘）仍能收到 move/up
    try {
      document.body.setPointerCapture(e.pointerId)
    } catch {
      /* 忽略 */
    }
    commitTextIfAny()
    const p = { x: e.clientX, y: e.clientY }
    if (state === 'selected') {
      const h = handleAt(p)
      if (h) {
        state = 'resizing'
        resizeDir = h
        moveOrig = { sel: { ...sel } }
        return
      }
      if (tool) {
        state = 'drawing'
        startShape(p)
        return
      }
      if (insideSel(p)) {
        state = 'moving'
        moveOrig = { sel: { ...sel }, px: p.x, py: p.y }
        toolbar.style.display = 'none'
        return
      }
    }
    // 选区外或空闲：开始新的框选（丢弃已有标注）
    if (sel) {
      shapes = []
      redoShapes = []
      redrawAll()
    }
    tbOff = { x: 0, y: 0 } // 新选区：工具条回正中
    // 窗口智能识别：有高亮窗口时按下先挂起——单击 = 选中窗口，拖动 ≥6px = 转手动框选
    if (winHlRect) {
      state = 'winDown'
      winPending = { ...winHlRect }
      dragStart = p
      return
    }
    state = 'dragging'
    sel = { x: p.x, y: p.y, w: 0, h: 0 }
    dragStart = p
    toolbar.style.display = 'none'
    updateSelUI()
  })

  window.addEventListener('pointermove', (e) => {
    if (tbDrag) {
      tbOff.x = tbDrag.ox + e.clientX - tbDrag.sx
      tbOff.y = tbDrag.oy + e.clientY - tbDrag.sy
      if (state === 'selected') positionToolbar()
      return
    }
    const p = { x: e.clientX, y: e.clientY }
    if (onToolbar(e)) {
      hideMagnifier()
      return
    }
    if (state === 'idle' || state === 'dragging') {
      drawMagnifier(p)
    } else {
      hideMagnifier()
    }
    if (state === 'idle') {
      scheduleWinQuery(p)
    } else if (state !== 'winDown' && winHlRect) {
      hideWinHl()
    }
    if (state === 'winDown') {
      // 按住后拖动超过阈值 → 放弃窗口选中，转手动框选
      if (Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > 6) {
        state = 'dragging'
        sel = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 }
        hideWinHl()
        updateSelUI()
      }
      return
    }
    if (state === 'dragging') {
      sel = {
        x: Math.min(dragStart.x, p.x),
        y: Math.min(dragStart.y, p.y),
        w: Math.abs(p.x - dragStart.x),
        h: Math.abs(p.y - dragStart.y),
      }
      updateSelUI()
    } else if (state === 'moving') {
      sel = {
        ...moveOrig.sel,
        x: Math.min(Math.max(0, moveOrig.sel.x + p.x - moveOrig.px), W - moveOrig.sel.w),
        y: Math.min(Math.max(0, moveOrig.sel.y + p.y - moveOrig.py), H - moveOrig.sel.h),
      }
      updateSelUI()
    } else if (state === 'resizing') {
      applyResize(p)
    } else if (state === 'drawing') {
      extendShape(p)
    }
  })

  window.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return
    if (tbDrag) {
      tbDrag = null
      return
    }
    if (state === 'winDown') {
      // 单击：选中识别到的窗口区域
      sel = { ...winPending }
      winPending = null
      hideWinHl()
      state = 'selected'
      updateSelUI()
      return
    }
    if (state === 'dragging') {
      if (!sel || sel.w < MIN_SEL || sel.h < MIN_SEL) {
        sel = null
        state = 'idle'
      } else {
        state = 'selected'
      }
      updateSelUI()
    } else if (state === 'moving' || state === 'resizing') {
      state = 'selected'
      updateSelUI()
    } else if (state === 'drawing') {
      state = 'selected'
      curShape = null
      lastPt = null
      redrawAll()
      updateSelUI()
    }
  })

  window.addEventListener('dblclick', (e) => {
    if (onToolbar(e) || ocrPanelOpen) return
    if (sel && !tool) doAction('copy')
  })

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (ocrPanelOpen) {
      closeOcrPanel()
      return
    }
    if (!sel) {
      api.overlay.cancel()
    } else if (shapes.length === 0 && !tool) {
      api.overlay.cancel()
    }
  })

  function startShape(p) {
    const base = { color, width: strokeW }
    if (tool === 'pen' || tool === 'marker' || tool === 'mosaic') {
      curShape = { ...base, type: tool, points: [p] }
      shapes.push(curShape)
      lastPt = p
    } else if (tool === 'text') {
      startTextInput(p)
      state = 'selected'
    } else {
      curShape = { ...base, type: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y }
      shapes.push(curShape)
    }
  }

  function extendShape(p) {
    if (!curShape) return
    if (curShape.type === 'pen' || curShape.type === 'marker' || curShape.type === 'mosaic') {
      drawShape(annotCtx, curShape, { from: lastPt, to: p })
      curShape.points.push(p)
      lastPt = p
    } else {
      curShape.x1 = p.x
      curShape.y1 = p.y
      redrawAll()
      drawShape(annotCtx, curShape)
    }
  }

  function startTextInput(p) {
    textPos = { x: p.x, y: p.y }
    textInput.style.left = p.x + 'px'
    textInput.style.top = p.y - 3 + 'px'
    textInput.style.fontSize = 14 + strokeW * 3 + 'px'
    textInput.style.color = color
    textInput.style.display = 'block'
    textInput.value = ''
    setTimeout(() => textInput.focus(), 0)
  }

  textInput.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') hideTextInput(true)
    else if (e.key === 'Escape') hideTextInput(false)
  })

  // ---------- 键盘 ----------
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (popOpen) {
        closePop()
        return
      }
      if (ocrPanelOpen) {
        closeOcrPanel()
        return
      }
      api.overlay.cancel()
      return
    }
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.toLowerCase()
    if (mod && k === 'c') return doAction('copy')
    if (mod && k === 's') {
      e.preventDefault()
      return doAction('save')
    }
    if (mod && k === 'z') {
      e.preventDefault()
      return e.shiftKey ? redo() : undo()
    }
    if (mod && k === 'y') {
      e.preventDefault()
      return redo()
    }
    if (mod) return
    if (e.key === 'Enter' && sel) return doAction('copy')
    if (k === 'o' && sel) return runOcrNow()
    const map = { r: 'rect', e: 'ellipse', a: 'arrow', p: 'pen', m: 'marker', t: 'text', b: 'mosaic' }
    if (map[k] && sel) setTool(map[k])
  })

  // ---------- 初始化 ----------
  api.on('capture:init', (p) => {
    const t0 = performance.now()
    displayId = p.displayId
    dpr = p.dpr
    W = p.width
    H = p.height
    originX = p.x || 0
    originY = p.y || 0
    pinOpacity = p.pinOpacity || 100
    pixels = null
    shapes = []
    redoShapes = []
    sel = null
    tool = null
    state = 'idle'
    hideTextInput(false)
    hideWinHl()
    winPending = null
    closePop()
    tbOff = { x: 0, y: 0 }
    tbDrag = null
    ocrPanelOpen = false
    ocrBusy = false
    ocrPanel.style.display = 'none'
    ocrBtn.classList.remove('busy')
    toast.style.display = 'none'
    document.querySelectorAll('#toolbar .tb[data-tool]').forEach((b) => b.classList.remove('active'))
    bgCtx = setupCanvas(bgCanvas, true) // 放大镜要整幅读回像素，必须 willReadFrequently
    annotCtx = setupCanvas(annotCanvas)
    mag.width = Math.round(MAG * dpr)
    mag.height = Math.round(MAG * dpr)
    magCtx = mag.getContext('2d')
    magCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    bgImg = new Image()
    bgImg.onload = () => {
      bgCtx.drawImage(bgImg, 0, 0, W, H)
      annotCtx.clearRect(0, 0, W, H)
      buildMosaic()
      redrawAll()
      updateSelUI()
      console.log('[perf][overlay] init+draw:', Math.round(performance.now() - t0), 'ms')
      api.overlay.captureReady(displayId)
    }
    bgImg.onerror = () => api.overlay.captureReady(displayId)
    bgImg.src = p.dataUrl
  })

  buildToolbar()
  updateSelUI()
  api.overlay.ready()
})()
