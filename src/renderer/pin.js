// 贴图窗口：画布渲染原图+标注；非编辑态 = 拖动/滚轮/双击/右键；
// 编辑态 = 通过独立工具条窗口的 IPC 指令进行标注（与截图工具条同款交互）
(() => {
  const api = window.shotAPI
  const cv = document.getElementById('pcv')
  const pText = document.getElementById('pText')
  const COLORS = ['#e5484d', '#ef9f43', '#f5cf3a', '#27a875', '#3d8be9', '#9d7bea', '#1a2036', '#ffffff']
  const MOSAIC_BLOCK = 8

  let baseImg = null
  let annots = []
  let redoA = []
  let editing = false
  let tool = null
  let color = COLORS[0]
  let strokeW = 2
  let textSize = 24
  let cur = null
  let lastPt = null
  let textPos = null
  let scale = 1
  let mosaicCv = null
  let panning = false
  let mode = null

  const dpr = () => window.devicePixelRatio || 1

  // ---------- 渲染 ----------
  function draw() {
    if (!baseImg) return
    scale = innerWidth / baseImg.naturalWidth
    const d = dpr()
    cv.width = Math.max(1, Math.round(innerWidth * d))
    cv.height = Math.max(1, Math.round(innerHeight * d))
    cv.style.width = innerWidth + 'px'
    cv.style.height = innerHeight + 'px'
    const ctx = cv.getContext('2d')
    ctx.setTransform(d * scale, 0, 0, d * scale, 0, 0)
    ctx.drawImage(baseImg, 0, 0)
    for (const a of annots) drawA(ctx, a)
    if (cur) drawA(ctx, cur)
  }

  function buildMosaic() {
    const M = MOSAIC_BLOCK
    mosaicCv = document.createElement('canvas')
    mosaicCv.width = Math.max(1, Math.round(baseImg.naturalWidth / M))
    mosaicCv.height = Math.max(1, Math.round(baseImg.naturalHeight / M))
    const c = mosaicCv.getContext('2d')
    c.imageSmoothingEnabled = true
    c.drawImage(baseImg, 0, 0, mosaicCv.width, mosaicCv.height)
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
      ctx.globalAlpha = 1
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
    if (!mosaicCv) return
    ctx.imageSmoothingEnabled = false
    const M = MOSAIC_BLOCK
    const dist = Math.hypot(to.x - from.x, to.y - from.y)
    const step = Math.max(brush / 2, 2)
    const n = Math.max(1, Math.ceil(dist / step))
    for (let i = 1; i <= n; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n }
      const sw = brush / M
      ctx.drawImage(mosaicCv, p.x / M - sw / 2, p.y / M - sw / 2, sw, sw, p.x - brush / 2, p.y - brush / 2, brush, brush)
    }
    ctx.imageSmoothingEnabled = true
  }

  function drawA(ctx, a, incremental) {
    ctx.save()
    const width = a.width || 2
    if (a.type === 'pen' || a.type === 'marker') {
      const pts = incremental ? [incremental.from, incremental.to] : a.points
      strokeSmoothPath(ctx, pts, a.type === 'marker' ? width * 5 : width, a.color, a.type === 'marker' ? 0.35 : 1)
    } else if (a.type === 'rect') {
      ctx.lineWidth = width
      ctx.strokeStyle = a.color
      ctx.strokeRect(a.x0, a.y0, a.x1 - a.x0, a.y1 - a.y0)
    } else if (a.type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, Math.abs(a.x1 - a.x0) / 2, Math.abs(a.y1 - a.y0) / 2, 0, 0, Math.PI * 2)
      ctx.lineWidth = width
      ctx.strokeStyle = a.color
      ctx.stroke()
    } else if (a.type === 'arrow') {
      const dx = a.x1 - a.x0
      const dy = a.y1 - a.y0
      const ang = Math.atan2(dy, dx)
      const hl = Math.max(11, width * 3)
      ctx.beginPath()
      ctx.moveTo(a.x0, a.y0)
      ctx.lineTo(a.x1, a.y1)
      ctx.lineWidth = width
      ctx.lineCap = 'round'
      ctx.strokeStyle = a.color
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(a.x1, a.y1)
      ctx.lineTo(a.x1 - hl * Math.cos(ang - 0.42), a.y1 - hl * Math.sin(ang - 0.42))
      ctx.lineTo(a.x1 - hl * Math.cos(ang + 0.42), a.y1 - hl * Math.sin(ang + 0.42))
      ctx.closePath()
      ctx.fillStyle = a.color
      ctx.fill()
    } else if (a.type === 'mosaic') {
      if (incremental) {
        drawMosaicSegment(ctx, incremental.from, incremental.to, width * 5 + 8)
      } else {
        let prev = a.points[0]
        for (let i = 1; i < a.points.length; i++) {
          drawMosaicSegment(ctx, prev, a.points[i], width * 5 + 8)
          prev = a.points[i]
        }
      }
    } else if (a.type === 'text') {
      ctx.font = fontSpec(a.size)
      ctx.textBaseline = 'top'
      ctx.fillStyle = a.color
      const lh = Math.round(a.size * 1.35)
      String(a.text).split('\n').forEach((ln, i) => ctx.fillText(ln, a.x, a.y + i * lh))
    }
    ctx.restore()
  }

  function compositeDataUrl() {
    const c = document.createElement('canvas')
    c.width = baseImg.naturalWidth
    c.height = baseImg.naturalHeight
    const ctx = c.getContext('2d')
    ctx.drawImage(baseImg, 0, 0)
    for (const a of annots) drawA(ctx, a)
    return c.toDataURL('image/png')
  }

  function pushComposite() {
    if (!baseImg) return
    api.pin.setComposite(compositeDataUrl())
  }

  // ---------- 编辑动作（由工具条窗口通过 IPC 触发） ----------
  function setTool(t) {
    tool = tool === t ? null : t
    hidePText(false)
  }

  function undo() {
    if (!annots.length) return
    redoA.push(annots.pop())
    draw()
    pushComposite()
  }

  function redo() {
    if (!redoA.length) return
    annots.push(redoA.pop())
    draw()
    pushComposite()
  }

  function setColor(c) {
    color = c
  }

  function setWidth(w) {
    strokeW = w
  }

  function setEditing(on) {
    editing = on
    document.body.classList.toggle('editing', on)
    if (on) {
      tool = null
      buildMosaic()
    } else {
      tool = null
      hidePText(false)
      pushComposite()
    }
    draw()
  }

  // ---------- 文字标注 ----------
  function startPText(p) {
    textPos = p
    pText.style.left = p.x * scale + 'px'
    pText.style.top = p.y * scale - 3 + 'px'
    pText.style.fontSize = textSize + 'px'
    pText.style.color = color
    pText.value = ''
    pText.style.height = 'auto'
    pText.style.display = 'block'
    setTimeout(() => pText.focus(), 0)
  }

  function hidePText(commit) {
    if (pText.style.display !== 'block') return
    const val = pText.value.trim()
    pText.style.display = 'none'
    pText.value = ''
    if (commit && val && textPos) {
      annots.push({ type: 'text', x: textPos.x, y: textPos.y, text: val, color, size: textSize })
      redoA = []
      draw()
      pushComposite()
    }
    textPos = null
  }

  pText.addEventListener('input', () => {
    pText.style.height = 'auto'
    pText.style.height = pText.scrollHeight + 'px'
  })
  pText.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      hidePText(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      hidePText(false)
    }
  })

  // ---------- 绘制交互（编辑态） ----------
  function toImg(e) {
    const rect = cv.getBoundingClientRect()
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale }
  }

  function startPShape(p) {
    const base = { color, width: strokeW }
    if (tool === 'pen' || tool === 'marker' || tool === 'mosaic') {
      cur = { ...base, type: tool, points: [p] }
      annots.push(cur)
      lastPt = p
    } else if (tool === 'text') {
      startPText(p)
      cur = null
    } else {
      cur = { ...base, type: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y }
      annots.push(cur)
    }
  }

  function extendPShape(p) {
    if (!cur) return
    if (cur.type === 'pen' || cur.type === 'marker' || cur.type === 'mosaic') {
      drawA(cv.getContext('2d'), cur, { from: lastPt, to: p })
      cur.points.push(p)
      lastPt = p
    } else {
      cur.x1 = p.x
      cur.y1 = p.y
      draw()
    }
  }

  // ---------- 指针交互 ----------
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !baseImg) return
    e.preventDefault()
    try {
      cv.setPointerCapture(e.pointerId)
    } catch {
      /* 忽略 */
    }
    if (editing) {
      hidePText(true)
      const p = toImg(e)
      startPShape(p)
      return
    }
    panning = true
    mode = { sx: e.screenX, sy: e.screenY }
    cv.classList.add('panning')
  })

  cv.addEventListener('pointermove', (e) => {
    if (!baseImg) return
    if (editing) {
      if (!cur) return
      const p = toImg(e)
      extendPShape(p)
      return
    }
    if (panning && mode) {
      api.pin.drag(e.screenX - mode.sx, e.screenY - mode.sy)
      mode.sx = e.screenX
      mode.sy = e.screenY
    }
  })

  cv.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return
    if (editing) {
      if (cur && cur.type === 'text') {
        cur = null
        return
      }
      if (cur) {
        if (cur.points === undefined && Math.hypot(cur.x1 - cur.x0, cur.y1 - cur.y0) < 2) {
          annots.pop()
        } else {
          redoA = []
        }
        cur = null
        draw()
        pushComposite()
      }
      return
    }
    if (panning) {
      panning = false
      mode = null
      cv.classList.remove('panning')
    }
  })

  window.addEventListener(
    'wheel',
    (e) => {
      if (editing) return
      e.preventDefault()
      api.pin.zoom({ deltaY: e.deltaY, screenX: e.screenX, screenY: e.screenY })
    },
    { passive: false }
  )

  cv.addEventListener('dblclick', () => {
    if (!editing) api.pin.close()
  })
  cv.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!editing) api.pin.menu()
  })

  // ---------- 悬停圆钮 ----------
  document.getElementById('pBrush').addEventListener('click', () => api.pin.openToolbar())
  document.getElementById('pClose').addEventListener('click', () => api.pin.close())

  // ---------- 工具条窗口 IPC 指令 ----------
  api.on('pin:editAction', ({ action, arg }) => {
    switch (action) {
      case 'setEditing': setEditing(arg); break
      case 'setTool': if (editing) setTool(arg); break
      case 'undo': if (editing) undo(); break
      case 'redo': if (editing) redo(); break
      case 'done': if (editing) setEditing(false); break
    }
  })
  api.on('pin:toolbarClosed', () => {
    if (editing) setEditing(false)
  })

  // ---------- 初始化 ----------
  api.on('pin:init', ({ dataUrl, hint }) => {
    const im = new Image()
    im.onload = () => {
      baseImg = im
      annots = []
      redoA = []
      buildMosaic()
      draw()
    }
    im.src = dataUrl
    if (hint) {
      const hintEl = document.getElementById('hint')
      hintEl.classList.add('show')
      setTimeout(() => {
        hintEl.classList.remove('show')
        api.settings.set({ pinHintShown: true })
      }, 3200)
    }
  })
})()
