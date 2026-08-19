/**
 * 协议端支不支持取 protobuf。
 *
 * 「查看原始消息」的 pb 两档最终落在 `send_packet` 上，那是 NapCat 独有的扩展（packet 模式）；
 * Packet-plugin 自己的说明里也写着「仅支持以 OneBot 协议对接 NapCat」。别家协议端没有这个
 * 接口，而 Packet-plugin 抛出来的是「获取seq失败，请尝试更新napcat」—— 对着 LLOneBot 用户
 * 说这话只会让人白折腾一圈，所以取不到时得点明当前协议端是什么。
 */

/**
 * 协议端名字里带 napcat 就认为支持。
 *
 * NapCat 的 `app_name` 是 `NapCat.Onebot`，各分支/改版也都带这个词。
 */
const NAPCAT_RE = /napcat/i

/**
 * @param {object} bot Yunzai 的 bot 对象
 * @return {{unsupported: boolean, label: string, note: string}}
 *   `unsupported` 为 true 时不必把 Packet-plugin 的原始报错抛给用户看，`note` 才是有用的那句
 */
export function packetSupport(bot) {
  /**
   * 认 `app_name`，别认 `version.name`。
   *
   * `version.name` 是**适配器**名，恒为 `OneBotv11`（见 plugins/adapter/OneBotv11.js 里
   * `data.bot.version = {...get_version_info, name: this.name, ...}`）—— 拿它判断的话连
   * NapCat 都会被误判成不支持。协议端自己的名字在 `get_version_info` 的 `app_name` 里。
   */
  const app = String(bot?.version?.app_name ?? '').trim()
  // version 是个 getter，给的是 `LLOneBot v8.1.8` 这种完整串，直接拿来当标签
  const label = String(bot?.version?.version ?? '').trim() || app || '未知协议端'

  // 拿不到 app_name 时不武断判定为不支持 —— 照样让它去试，取不到再说
  if (app && !NAPCAT_RE.test(app)) {
    return {
      unsupported: true,
      label,
      note: `当前协议端是 ${label}，它没有 send_packet 接口 —— pb 两档只有 NapCat（开启 packet 模式）`
        + '取得到。msg array / msg raw 两档不受影响，排查消息结构看那两档就够了。',
    }
  }
  return {
    unsupported: false,
    label,
    note: `确认 NapCat 已开启 packet 模式${app ? `（当前 ${label}）` : ''}。`,
  }
}
