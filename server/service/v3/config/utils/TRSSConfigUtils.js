import {YamlReader} from "#guoba.framework"

export function handleConfigData(action, key, field, value) {

  // 特殊处理 auth
  if (key === 'system.server' && field === 'auth') {
    let handleRes = handleAuth(action, field, value)
    field = handleRes.field
    value = handleRes.value
  }

  return {field, value};
}

function handleAuth(action, field, value) {
  if (action === 'get') {
    if (!value) {
      return {field, value: []}
    }
    if (value instanceof Object) {
      return {
        field,
        value: Object.entries(value).map(([key, val]) => {
          return {
            key,
            value: val
          }
        })
      }
    }
    return {field, value: []}
  } else {
    // 强制覆盖旧数据
    field = YamlReader.CONFIG_FORCE_OVERLAY_KEY + field
    if (!value) {
      return {field, value: null}
    }
    if (Array.isArray(value) && value.length > 0) {
      return {
        field,
        value: value.reduce((acc, cur) => {
          acc[cur.key] = cur.value
          return acc
        }, {})
      }
    }
    return {field, value: null}
  }
}

/**
 * 取群名，只为了在配置项旁边显示「群名 (群号)」。
 *
 * 必须走 strict 模式：不加它的话，框架在群不存在时会「随机选择 Bot」，而那条路径写的是
 * `this.bots[this.uin].pickGroup()` —— 没有账号在线时 `this.uin` 是空数组，取出来是
 * undefined，直接 TypeError 把整个配置页打成 500。群名取不到就不显示，不该影响读配置。
 */
function pickGroupName(groupId) {
  try {
    const group = Bot.pickGroup(groupId, true)
    if (!group) return ''
    return group.group_name || group.name || ''
  } catch {
    return ''
  }
}

/**
 * 处理 group 配置
 */
export function handleGroupConfig(action, data) {
  for (const key of Object.keys(data)) {
    if (action === 'get') {
      // 判断是否带 :
      let groupId = key
      let keySplit = []
      if (typeof groupId === 'string') {
        if (groupId.includes(':')) {
          keySplit = groupId.split(':')
          groupId = keySplit.pop()
        }
        if (groupId.startsWith(YamlReader.CONFIG_INTEGER_KEY)) {
          groupId = groupId.replace(YamlReader.CONFIG_INTEGER_KEY, '')
        }
      }
      if (!groupId) {
        continue
      }
      if (groupId === 'default') {
        continue
      }
      groupId = Number(groupId) || String(groupId)
      const groupName = pickGroupName(groupId)
      if (!groupName) {
        continue
      }
      data[key]['__GROUP_TIP_TEXT__'] = `${groupName} (${[...keySplit, groupId].join(':')})`
    } else {
      delete data[key]['__GROUP_TIP_TEXT__']
    }
  }
  return data
}
