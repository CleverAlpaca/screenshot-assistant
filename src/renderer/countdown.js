// 倒计时窗：显示剩余秒数；点击取消延时截图
(() => {
  const api = window.shotAPI
  const num = document.getElementById('num')

  api.on('countdown:tick', ({ n }) => {
    num.textContent = n
    num.classList.remove('tick')
    void num.offsetWidth // 重启动画
    num.classList.add('tick')
  })

  window.addEventListener('mousedown', () => api.countdown.cancel())
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    api.countdown.cancel()
  })
})()
