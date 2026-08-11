// noinspection JSUnusedGlobalSymbols
export const SystemMenus = {
  // 首页菜单
  home: {
    path: '/home',
    name: 'Home',
    component: '/guoba/home/index',
    meta: {
      title: '首页',
      // 统一用 ant-design 图标集：这些已内置在前端（icons/offline.ts），
      // 不走 iconify 公共 API，离线环境也能正常显示并跟随选中色。
      icon: 'ant-design:home-outlined',
    },
  },
  // 账号管理
  account: {
    path: '/account',
    name: 'Account',
    component: '/guoba/system/account/index',
    meta: {
      title: '账号管理',
      icon: 'ant-design:user-outlined',
    },
  },
  // 消息记录
  chat: {
    path: '/chat',
    name: 'Chat',
    component: '/guoba/chat/index',
    meta: {
      title: '消息记录',
      icon: 'ant-design:message-outlined',
    },
  },
  // 运行日志
  log: {
    path: '/log',
    name: 'Log',
    component: '/guoba/log/index',
    meta: {
      title: '运行日志',
      icon: 'ant-design:file-search-outlined',
    },
  },
  // 沙盒调试
  sandbox: {
    path: '/sandbox',
    name: 'Sandbox',
    component: '/guoba/sandbox/index',
    meta: {
      title: '沙盒',
      icon: 'ant-design:experiment-outlined',
    },
  },
  // 数据浏览
  data: {
    path: '/data',
    name: 'Data',
    component: '/guoba/data/index',
    meta: {
      title: '数据浏览',
      icon: 'ant-design:database-outlined',
    },
  },
  // 配置管理
  config: {
    path: '/config',
    name: 'Config',
    component: '/guoba/config/index',
    meta: {
      title: '配置管理',
      icon: 'ant-design:setting-outlined',
    },
  },
  // 关于
  about: {
    path: '/about',
    name: 'about',
    component: '/guoba/about/index',
    meta: {
      title: '关于',
      // 原 cib:about-me 是 About.me 的品牌 logo，渲染出来就是「me」两个字母，语义不符。
      // 换成与「账号管理」同一图标集的信息图标。iconify 运行时解析，改此处无需重建前端。
      icon: 'ant-design:info-circle-outlined',
    },
  },
}