import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace for WeChat settings. */
export const NS = 'wechat'

/** English settings strings. */
export const en = {
  nav: 'WeChat',
  title: 'WeChat',
  description: 'Chat with the agent on this computer from WeChat.',
  add: 'Add WeChat',
  connected: 'WeChat ClawBot · Connected',
  connectedState: 'Connected',
  waiting: 'Waiting for you to scan the QR code',
  scanned: 'Scanned · Confirm on your phone',
  connecting: 'Connecting to WeChat…',
  reconnecting: 'Reconnecting to WeChat…',
  disconnected: 'WeChat is disconnected.',
  loggedOut: 'Your WeChat session expired. Scan again to reconnect.',
  cancel: 'Cancel',
  disconnect: 'Disconnect',
  reconnect: 'Reconnect',
  logout: 'Log out',
  confirmLogout: 'Log out of this WeChat account?',
  confirmLogoutAgain: 'Confirm again: remove the saved WeChat login from this computer?',
  project: 'Default project',
  projectHint: 'New WeChat messages continue in this project.',
  usage: 'Find ClawBot in WeChat and message it directly. Keep 蒜狸小助手 open and prevent this computer from sleeping.',
  commands: 'Commands',
  commandNew: '/new — start a new conversation',
  commandList: '/list — list recent conversations',
  commandUse: '/use <n> — switch conversations',
  commandProject: '/项目 [name|number] — switch projects (/project)',
  commandCancel: '/cancel — stop the current turn',
  commandHelp: '/help — show command help',
  failed: 'The WeChat request failed. Check the connection and try again.',
  noProjects: 'No projects are available.',
  'keepAwake.title': 'Keep computer awake',
  'keepAwake.description': "While the app is running, your computer won't go to sleep, so remote tasks such as WeChat aren't interrupted. The display can still turn off.",
  'keepAwake.error': "Couldn't save this setting. Try again.",
}

/** Simplified Chinese settings strings. */
export const zh = {
  nav: '微信',
  title: '微信',
  description: '在微信里和这台电脑上的智能体对话',
  add: '添加微信',
  connected: '微信 ClawBot · 已连接',
  connectedState: '已连接',
  waiting: '等待扫码',
  scanned: '已扫码，请在手机上确认',
  connecting: '正在连接微信…',
  reconnecting: '正在重新连接微信…',
  disconnected: '微信已断开连接',
  loggedOut: '微信登录已失效，请重新扫码绑定',
  cancel: '取消',
  disconnect: '断开连接',
  reconnect: '重新连接',
  logout: '退出登录',
  confirmLogout: '确定退出此微信账号吗？',
  confirmLogoutAgain: '再次确认：从这台电脑删除已保存的微信登录吗？',
  project: '默认项目',
  projectHint: '新的微信消息会继续发送到此项目',
  usage: '在微信里找到 ClawBot 直接对话；使用时保持蒜狸小助手打开、电脑不要睡眠',
  commands: '命令',
  commandNew: '/new — 开始新会话',
  commandList: '/list — 列出最近会话',
  commandUse: '/use <n> — 切换会话',
  commandProject: '/项目 [名称|序号] — 切换项目（/project）',
  commandCancel: '/cancel — 中断当前一轮',
  commandHelp: '/help — 查看命令帮助',
  failed: '微信操作失败，请检查连接后重试',
  noProjects: '没有可用项目',
  'keepAwake.title': '保持电脑唤醒',
  'keepAwake.description': '开启后，小助手运行期间电脑不会自动睡眠，微信等远程任务不会中断；显示器仍可按系统设置关闭。',
  'keepAwake.error': '没能保存这个设置，请重试',
}

/** Japanese copy for the Desktop power row. */
export const ja = {
  ...en,
  'keepAwake.title': 'コンピューターをスリープさせない',
  'keepAwake.description': 'オンにすると、アプリの実行中はコンピューターがスリープせず、WeChat などのリモートタスクが中断されません。ディスプレイはシステム設定に従ってオフになります。',
  'keepAwake.error': '設定を保存できませんでした。もう一度お試しください。',
}

/** Spanish copy for the Desktop power row. */
export const es = {
  ...en,
  'keepAwake.title': 'Mantener el equipo activo',
  'keepAwake.description': 'Mientras la aplicación esté abierta, el equipo no entrará en suspensión y las tareas remotas, como WeChat, no se interrumpirán. La pantalla aún puede apagarse.',
  'keepAwake.error': 'No se pudo guardar esta opción. Inténtalo de nuevo.',
}

/** French copy for the Desktop power row. */
export const fr = {
  ...en,
  'keepAwake.title': 'Garder l’ordinateur éveillé',
  'keepAwake.description': 'Pendant l’exécution de l’application, l’ordinateur ne se met pas en veille et les tâches à distance comme WeChat ne sont pas interrompues. L’écran peut toujours s’éteindre.',
  'keepAwake.error': 'Impossible d’enregistrer ce réglage. Réessayez.',
}

/** German copy for the Desktop power row. */
export const de = {
  ...en,
  'keepAwake.title': 'Computer wach halten',
  'keepAwake.description': 'Während die App läuft, wechselt der Computer nicht in den Ruhezustand. Remote-Aufgaben wie WeChat werden dadurch nicht unterbrochen. Der Bildschirm kann sich weiterhin ausschalten.',
  'keepAwake.error': 'Diese Einstellung konnte nicht gespeichert werden. Bitte erneut versuchen.',
}

/** Russian copy for the Desktop power row. */
export const ru = {
  ...en,
  'keepAwake.title': 'Не переводить компьютер в сон',
  'keepAwake.description': 'Пока приложение запущено, компьютер не будет переходить в спящий режим, поэтому удалённые задачи, например WeChat, не прервутся. Экран по-прежнему может отключаться согласно системным настройкам.',
  'keepAwake.error': 'Не удалось сохранить настройку. Повторите попытку.',
}

/** Portuguese copy for the Desktop power row. */
export const pt = {
  ...en,
  'keepAwake.title': 'Manter o computador ativo',
  'keepAwake.description': 'Enquanto o aplicativo estiver aberto, o computador não entrará em suspensão e tarefas remotas, como as do WeChat, não serão interrompidas. A tela ainda pode desligar.',
  'keepAwake.error': 'Não foi possível salvar esta configuração. Tente novamente.',
}

/** Locale key union shared by settings components. */
export type WechatLocaleKey = keyof typeof en
