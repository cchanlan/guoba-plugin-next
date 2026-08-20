import {YamlReader} from "#guoba.framework"

export function handleConfigData(action, key, field, value) {
  return {field, value};
}

/**
 * 处理 group 配置
 */
export function handleGroupConfig(action, data) {
  for (const key of Object.keys(data)) {
    if (action === 'get') {
      // 判断是否带 :
      let groupId = key
      if (groupId === 'default') {
        continue
      }
      if (typeof groupId === 'string') {
        if (groupId.startsWith(YamlReader.CONFIG_INTEGER_KEY)) {
          groupId = groupId.replace(YamlReader.CONFIG_INTEGER_KEY, '')
        }
      }
      groupId = Number(groupId) || String(groupId)
      // 取不到群名就不显示提示文本，别让它把整个配置页打成 500（同 TRSSConfigUtils）
      let groupName = ''
      try {
        groupName = Bot.pickGroup(groupId)?.info?.group_name ?? ''
      } catch {
        groupName = ''
      }
      if (!groupName) {
        continue
      }
      data[key]['__GROUP_TIP_TEXT__'] = `${groupName} (${groupId})`
    } else {
      delete data[key]['__GROUP_TIP_TEXT__']
    }
  }
  return data
}
