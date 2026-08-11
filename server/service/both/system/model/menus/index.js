import {isV2} from '#guoba.adapter'

const {GI} = Guoba.createImport(import.meta.url)
const {SystemMenus} = await GI('./systemMenus.js')
const {usePluginsMenu} = await GI('./pluginMenus.js')
const {useCustomPagesMenu} = await GI('./customPageMenus.js')

// noinspection JSUnusedGlobalSymbols
export async function useMenuList() {
  if (isV2) return useMenuListV2()
  const menus = []
  menus.push(SystemMenus.home)
  menus.push(SystemMenus.config)
  menus.push(...(await usePluginsMenu()))
  menus.push(SystemMenus.log)
  menus.push(SystemMenus.sandbox)
  menus.push(SystemMenus.data)
  menus.push(...(await useCustomPagesMenu()))
  menus.push(SystemMenus.account)
  menus.push(SystemMenus.about)
  return menus
}

async function useMenuListV2() {
  return []
}
