/** Copy dictionaries for the WhatsApp pairing Settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  nav: 'WhatsApp',
  loading: '正在读取连接状态…',
  error: '暂时无法读取 WhatsApp 连接状态。',
  retry: '重试',
  offlineTitle: '未连接',
  offlineBody: '本进程尚未注册 WhatsApp 提供方，不会连接任何账号。',
  connectingTitle: '正在连接…',
  connectingBody: '正在与 WhatsApp 建立连接，稍后会显示配对二维码或已连接的账号。',
  pairingTitle: '扫码配对',
  pairingBody: '在手机上打开 WhatsApp，进入「已登录的设备 › 连接设备」，扫描下面的二维码。',
  pairingRotates: '二维码会不断刷新，本页面会自动跟随，无需手动重载。',
  pairingWarning: '二维码是凭据：扫描它的人将获得该账号的完整访问权限。请勿转发或截图分享。',
  qrLabel: 'WhatsApp 配对二维码',
  onlineTitle: '已连接',
  onlineAccount: '账号',
  onlineUnknownAccount: '提供方未报告账号名称。',
  loggedOutTitle: '已退出登录',
  loggedOutReason: '原因',
  loggedOutBody: '当前凭据已失效，需要重新扫码配对。',
} satisfies Record<string, string>

/** WhatsApp pairing section locale key union. */
export type WhatsAppLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  nav: 'WhatsApp',
  loading: 'Reading the connection…',
  error: 'The WhatsApp connection state is temporarily unavailable.',
  retry: 'Retry',
  offlineTitle: 'Not connected',
  offlineBody: 'No WhatsApp provider is registered in this process, so no account will connect.',
  connectingTitle: 'Connecting…',
  connectingBody: 'Reaching WhatsApp. A pairing code or the connected account will appear here.',
  pairingTitle: 'Scan to pair',
  pairingBody: 'On your phone, open WhatsApp and go to Linked devices › Link a device, then scan the code below.',
  pairingRotates: 'The code refreshes on its own and this page follows it — no reload needed.',
  pairingWarning: 'The code is a credential: whoever scans it links a device with full access to the account. Do not forward or screenshot it.',
  qrLabel: 'WhatsApp pairing QR code',
  onlineTitle: 'Connected',
  onlineAccount: 'Account',
  onlineUnknownAccount: 'The provider did not report an account name.',
  loggedOutTitle: 'Logged out',
  loggedOutReason: 'Reason',
  loggedOutBody: 'The current credentials are gone; the account has to pair again.',
} satisfies Record<WhatsAppLocaleKey, string>
