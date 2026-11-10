/** Connection light for the model gateway, shown in the sidebar footer. */

/** Copy for the gateway connection light; `reason.*` keys explain a failure in the tooltip. */
export type GatewayStatusKey =
  | 'connected' | 'disconnected' | 'checking'
  | 'reason.no-key' | 'reason.key-rejected' | 'reason.http-error' | 'reason.unreachable'
  | 'retry'

/** English copy. */
export const en: Record<GatewayStatusKey, string> = {
  'connected': 'Connected',
  'disconnected': 'Not connected',
  'checking': 'Checking…',
  'reason.no-key': 'No API key yet. Add one in Settings → Models.',
  'reason.key-rejected': 'The gateway rejected this API key. Update it in Settings → Models.',
  'reason.http-error': 'The gateway answered {detail}.',
  'reason.unreachable': 'Cannot reach the gateway: {detail}',
  'retry': 'Check the connection again',
}

/** Chinese copy. */
export const zh: Record<GatewayStatusKey, string> = {
  'connected': '已连接',
  'disconnected': '未连接',
  'checking': '检测中…',
  'reason.no-key': '还没有填写 API Key，请在 设置 → 模型 中添加。',
  'reason.key-rejected': '网关不认这个 API Key，请在 设置 → 模型 中更新。',
  'reason.http-error': '网关返回 {detail}。',
  'reason.unreachable': '连不上网关：{detail}',
  'retry': '重新检测连接',
}

/** Japanese copy. */
export const ja: Record<GatewayStatusKey, string> = {
  'connected': '接続済み',
  'disconnected': '未接続',
  'checking': '確認中…',
  'reason.no-key': 'API キーが未設定です。設定 → モデル で追加してください。',
  'reason.key-rejected': 'ゲートウェイがこの API キーを受け付けませんでした。設定 → モデル で更新してください。',
  'reason.http-error': 'ゲートウェイの応答：{detail}',
  'reason.unreachable': 'ゲートウェイに接続できません：{detail}',
  'retry': '接続を再確認',
}

/** Spanish copy. */
export const es: Record<GatewayStatusKey, string> = {
  'connected': 'Conectado',
  'disconnected': 'Sin conexión',
  'checking': 'Comprobando…',
  'reason.no-key': 'Aún no hay clave de API. Añádela en Ajustes → Modelos.',
  'reason.key-rejected': 'La pasarela rechazó esta clave de API. Actualízala en Ajustes → Modelos.',
  'reason.http-error': 'La pasarela respondió {detail}.',
  'reason.unreachable': 'No se puede alcanzar la pasarela: {detail}',
  'retry': 'Comprobar la conexión de nuevo',
}

/** French copy. */
export const fr: Record<GatewayStatusKey, string> = {
  'connected': 'Connecté',
  'disconnected': 'Non connecté',
  'checking': 'Vérification…',
  'reason.no-key': 'Aucune clé d’API pour l’instant. Ajoutez-la dans Réglages → Modèles.',
  'reason.key-rejected': 'La passerelle a refusé cette clé d’API. Mettez-la à jour dans Réglages → Modèles.',
  'reason.http-error': 'La passerelle a répondu {detail}.',
  'reason.unreachable': 'Passerelle injoignable : {detail}',
  'retry': 'Vérifier à nouveau la connexion',
}

/** German copy. */
export const de: Record<GatewayStatusKey, string> = {
  'connected': 'Verbunden',
  'disconnected': 'Nicht verbunden',
  'checking': 'Wird geprüft…',
  'reason.no-key': 'Noch kein API-Schlüssel. Fügen Sie ihn unter Einstellungen → Modelle hinzu.',
  'reason.key-rejected': 'Das Gateway hat diesen API-Schlüssel abgelehnt. Aktualisieren Sie ihn unter Einstellungen → Modelle.',
  'reason.http-error': 'Das Gateway antwortete mit {detail}.',
  'reason.unreachable': 'Gateway nicht erreichbar: {detail}',
  'retry': 'Verbindung erneut prüfen',
}

/** Russian copy. */
export const ru: Record<GatewayStatusKey, string> = {
  'connected': 'Подключено',
  'disconnected': 'Нет подключения',
  'checking': 'Проверка…',
  'reason.no-key': 'Ключ API ещё не задан. Добавьте его в «Настройки» → «Модели».',
  'reason.key-rejected': 'Шлюз отклонил этот ключ API. Обновите его в «Настройки» → «Модели».',
  'reason.http-error': 'Шлюз ответил: {detail}.',
  'reason.unreachable': 'Шлюз недоступен: {detail}',
  'retry': 'Проверить подключение ещё раз',
}

/** Portuguese copy. */
export const pt: Record<GatewayStatusKey, string> = {
  'connected': 'Conectado',
  'disconnected': 'Sem conexão',
  'checking': 'Verificando…',
  'reason.no-key': 'Ainda não há chave de API. Adicione em Configurações → Modelos.',
  'reason.key-rejected': 'O gateway recusou esta chave de API. Atualize em Configurações → Modelos.',
  'reason.http-error': 'O gateway respondeu {detail}.',
  'reason.unreachable': 'Não é possível alcançar o gateway: {detail}',
  'retry': 'Verificar a conexão novamente',
}
