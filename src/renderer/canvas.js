// 画布原图查看器窗口：画布随窗口缩放重绘；滚轮以光标为锚缩放；拖图平移；顶部拖动移动窗口
(() => {
  const api = window.shotAPI
  const cv = document.getElementById('cv')
  const meta = document.getElementById('meta')
  let img = null
  let zoom = 1
  let off = { x: 0, y: 0 }
  let mode = null

  // 画布可用区 = 窗口内容区减去顶栏
  const W = () => innerWidth
  const H = () => innerHeight - 34

  function draw() {
    if (!img) return
    const d = window.devicePixelRatio || 1
    cv.width = Math.max(1, Math.round(W() * d))
    cv.height = Math.max(1, Math.round(H() * d))
    cv.style.width = W() + 'px'
    cv.style.height = H() + 'px'
    const ctx = cv.getContext('2d')
    ctx.setTransform(d, 0, 0, d, 0, 0)
    ctx.fillStyle = '#10141f'
    ctx.fillRect(0, 0, W(), H())
    const dw = img.naturalWidth * zoom
    const dh = img.naturalHeight * zoom
    const dx = off.x + (W() - dw) / 2
    const dy = off.y + (H() - dh) / 2
    ctx.imageSmoothingEnabled = zoom < 3
    ctx.drawImage(img, dx, dy, dw, dh)
  }

  function fit() {
    if (!img) return
    zoom = Math.min(W() / img.naturalWidth, H() / img.naturalHeight)
    off = { x: 0, y: 0 }
    draw()
  }

  function close() {
    api.canvasViewer.close()
  }

  api.on('cv:init', ({ dataUrl, metaText }) => {
    meta.textContent = metaText
    const im = new Image()
    im.onload = () => {
      img = im
      fit()
    }
    im.src = dataUrl
  })

  // 窗口被原生边缘拖拽调整大小时，画布实时重绘（缩放/平移状态保留）
  window.addEventListener('resize', draw)

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !img) return
    e.preventDefault()
    try {
      cv.setPointerCapture(e.pointerId)
    } catch {
      /* 忽略 */
    }
    mode = { sx: e.clientX, sy: e.clientY, ox: off.x, oy: off.y }
    cv.classList.add('panning')
  })
  cv.addEventListener('pointermove', (e) => {
    if (!mode) return
    off.x = mode.ox + e.clientX - mode.sx
    off.y = mode.oy + e.clientY - mode.sy
    draw()
  })
  cv.addEventListener('pointerup', (e) => {
    if (e.button === 0) {
      mode = null
      cv.classList.remove('panning')
    }
  })

  cv.addEventListener(
    'wheel',
    (e) => {
      if (!img) return
      e.preventDefault()
      const rect = cv.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const dw0 = img.naturalWidth * zoom
      const dh0 = img.naturalHeight * zoom
      const dx0 = off.x + (W() - dw0) / 2
      const dy0 = off.y + (H() - dh0) / 2
      const ix = (mx - dx0) / zoom
      const iy = (my - dy0) / zoom
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
      zoom = Math.min(8, Math.max(0.05, zoom * f))
      const dw1 = img.naturalWidth * zoom
      const dh1 = img.naturalHeight * zoom
      const dx1 = off.x + (W() - dw1) / 2
      const dy1 = off.y + (H() - dh1) / 2
      off.x += mx - (dx1 + ix * zoom)
      off.y += my - (dy1 + iy * zoom)
      draw()
    },
    { passive: false }
  )

  document.getElementById('fitBtn').addEventListener('click', fit)
  document.getElementById('closeBtn').addEventListener('click', close)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
  })
})()
