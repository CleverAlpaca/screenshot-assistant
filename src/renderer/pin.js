// 贴图窗口：左键拖动移动、滚轮以光标为锚缩放、右键菜单、双击关闭
(() => {
  const api = window.shotAPI
  const pic = document.getElementById('pic')

  api.on('pin:init', ({ dataUrl }) => {
    pic.src = dataUrl
  })

  // ---- 拖动 ----
  let dragging = false
  let last = null

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    dragging = true
    last = { x: e.screenX, y: e.screenY }
    document.body.classList.add('dragging')
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    api.pin.drag(e.screenX - last.x, e.screenY - last.y)
    last = { x: e.screenX, y: e.screenY }
  })
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return
    dragging = false
    document.body.classList.remove('dragging')
  })

  // ---- 缩放 ----
  window.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      api.pin.zoom({ deltaY: e.deltaY, screenX: e.screenX, screenY: e.screenY })
    },
    { passive: false }
  )

  // ---- 菜单 / 关闭 ----
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    api.pin.menu()
  })
  window.addEventListener('dblclick', () => api.pin.close())
})()
