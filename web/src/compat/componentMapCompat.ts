/**
 * 老锅巴（1.x）的 componentMap 是 Map，插件的自定义组件用 `get` 取原组件、
 * 用 `set` 把自己的组件换进去（douyin-auto-spark 的模板编辑器就是这么替换 InputTextArea 的）。
 *
 * 新面板用的是普通对象，这里包一层 Map 语义。读写都落在同一个对象上，
 * 所以插件换进去的组件会直接参与 SchemaFormItem 的渲染。
 */
export function createCompatMap(target: Record<string, any>) {
  const map: Record<string, any> = new Proxy(target, {
    get(raw, prop) {
      if (prop === 'get') return (name: string) => raw[name]
      if (prop === 'set') return (name: string, value: any) => {
        raw[name] = value
        return map
      }
      if (prop === 'has') return (name: string) => Object.hasOwn(raw, name)
      if (prop === 'delete') return (name: string) => delete raw[name]
      if (prop === 'clear') return () => {
        for (const key of Object.keys(raw)) delete raw[key]
      }
      if (prop === 'size') return Object.keys(raw).length
      if (prop === 'keys') return () => Object.keys(raw)
      if (prop === 'values') return () => Object.values(raw)
      if (prop === 'entries') return () => Object.entries(raw)
      if (prop === 'forEach') return (fn: (value: any, key: string) => void) => {
        Object.entries(raw).forEach(([key, value]) => fn(value, key))
      }
      return Reflect.get(raw, prop)
    },
  })
  return map
}
