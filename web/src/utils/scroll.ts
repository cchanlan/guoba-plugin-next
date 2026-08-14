/**
 * 页面级滚动的工具。
 *
 * 页面滚动的落点是布局里的 `.g-content`（见 layouts/BasicLayout.vue），不是 window ——
 * `.g-layout` 锁了 100dvh 并 overflow: hidden，document 本身不会滚。
 * 手机上日志 / 消息 / 沙盒这些容器只占页面的一部分，光把容器贴底还是看不到最新内容，
 * 得连页面一起拖到底。
 */
const PAGE_SCROLLER = '.g-content'

/** 找到承载页面滚动的容器；from 给了就从它往上找，找不到退回全局那一个 */
export function getPageScroller(from?: HTMLElement | null): HTMLElement | null {
  const closest = from?.closest?.(PAGE_SCROLLER) as HTMLElement | null | undefined
  return closest ?? document.querySelector<HTMLElement>(PAGE_SCROLLER)
}

/** 整页拖到最底下 */
export function scrollPageToBottom(from?: HTMLElement | null) {
  const el = getPageScroller(from)
  if (el) el.scrollTop = el.scrollHeight
}

/** 整页回到最上面，默认平滑滚 */
export function scrollPageToTop(from?: HTMLElement | null, smooth = true) {
  const el = getPageScroller(from)
  if (!el) return
  el.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
}
