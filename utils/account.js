/**
 * 账号标识的判据。
 *
 * 单独放一个文件是为了不带任何依赖：`utils/common.js` 顶上 import 了 `#guoba.platform`，
 * server 的 model 层（零依赖、能脱机单测）没法引它，只能各写一份 —— 判据分了两处就会漂移。
 */

/**
 * 非真实账号的判定。
 *
 * `stdin` 是控制台适配器（它的昵称就叫「标准输入」）；官方 QQ 机器人（官bot）除了正式账号，
 * 还会额外注册一个沙盒环境的账号 `QQBotSandbox`。这类账号没有关系链、私聊发不出去，
 * 既不该当「机器人本体」拿去显示（那样面板上写的就是「标准输入」），也不该当「有账号上线了」
 * 的依据 —— 挑中它的话，`cfg.master` 里根本查不到它名下的主人。
 */
export function isFakeAccount(id) {
  return id == null || id === '' || /^stdin$|sandbox$/i.test(String(id))
}
