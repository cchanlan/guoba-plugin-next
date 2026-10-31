/**
 * 移动端横向拖动接管。
 *
 * 手机上横向手势经常被浏览器吃掉（返回手势、下拉刷新、外层纵向滚动抢焦点），
 * 滚动容器写了 overflow-x: auto 也滑不动 —— 文件页表格实测过。这里在触摸事件里
 * 直接改 scrollLeft：只在横向位移明显大于纵向时接管，纵向手势原样交给浏览器。
 *
 * 监听只挂在「这次手指按下的、真能横向滚的容器」上，页面别处的滚动不受影响。
 * 不按视口宽度判断：手机开「桌面版」时视口会超过 768，横向溢出照样滑不动。
 */

let scroller: HTMLElement | null = null
let startX = 0
let startY = 0
let startLeft = 0
let dragging = false

/** 从触点往上找第一个能横向滚的容器 */
function findScroller(target: EventTarget | null): HTMLElement | null {
  let node = target instanceof HTMLElement ? target : null
  while (node && node !== document.body) {
    // 输入框 / 可编辑区自己要用横向手势走光标
    if (node.matches('input, textarea, select, [contenteditable="true"]')) return null
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function onTouchMove(e: TouchEvent) {
  if (!scroller) return
  const t = e.touches[0]
  if (!t) return
  const dx = t.clientX - startX
  const dy = t.clientY - startY
  if (!dragging) {
    if (Math.abs(dx) < Math.abs(dy) + 4) return
    dragging = true
  }
  e.preventDefault()
  scroller.scrollLeft = startLeft - dx
}

function stop() {
  if (scroller) scroller.removeEventListener('touchmove', onTouchMove)
  scroller = null
  dragging = false
}

function onTouchStart(e: TouchEvent) {
  stop()
  if (e.touches.length !== 1) return
  const el = findScroller(e.target)
  if (!el) return
  const t = e.touches[0]
  scroller = el
  startX = t.clientX
  startY = t.clientY
  startLeft = el.scrollLeft
  el.addEventListener('touchmove', onTouchMove, { passive: false })
  document.addEventListener('touchend', stop, { passive: true, once: true })
  document.addEventListener('touchcancel', stop, { passive: true, once: true })
}

export function installHorizontalDrag() {
  document.addEventListener('touchstart', onTouchStart, { passive: true })
}
