/** Connection state copy shown beside the product wordmark. */

/** Copy for the gateway connection light; `reason.*` keys explain a failure in the tooltip. */
export type GatewayStatusKey =
  | 'connected' | 'disconnected' | 'checking'
  | 'reason.no-key' | 'reason.key-rejected' | 'reason.http-error' | 'reason.unreachable'
  | 'retry'
  | 'catalog.title' | 'catalog.description' | 'catalog.sync' | 'catalog.syncing'
  | 'catalog.synced' | 'catalog.unchanged' | 'catalog.no-credential'
  | 'catalog.unauthorized' | 'catalog.unreachable' | 'catalog.empty'
  | 'catalog.failed' | 'catalog.count'

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
  'catalog.title': 'Model catalog',
  'catalog.description': 'Sync the model list from this deployment’s gateway. It takes effect immediately.',
  'catalog.sync': 'Sync from gateway',
  'catalog.syncing': 'Syncing…',
  'catalog.synced': 'Synced {count} models',
  'catalog.unchanged': 'Already current',
  'catalog.no-credential': 'No gateway API key is stored yet',
  'catalog.unauthorized': 'The gateway rejected this API key',
  'catalog.unreachable': 'The gateway could not be reached',
  'catalog.empty': 'The gateway listed no models; the current list is kept',
  'catalog.failed': 'Sync failed',
  'catalog.count': '{count} models',
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
  'catalog.title': '模型目录',
  'catalog.description': '从当前网关同步模型列表，同步后立即生效。',
  'catalog.sync': '从网关同步',
  'catalog.syncing': '同步中…',
  'catalog.synced': '已同步 {count} 个模型',
  'catalog.unchanged': '已是最新',
  'catalog.no-credential': '还没有填写网关 API Key',
  'catalog.unauthorized': '网关不认这个 API Key',
  'catalog.unreachable': '连不上网关',
  'catalog.empty': '网关没有返回任何模型，已保留现有列表',
  'catalog.failed': '同步失败',
  'catalog.count': '{count} 个模型',
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
  'catalog.title': 'モデルカタログ',
  'catalog.description': '現在のゲートウェイからモデル一覧を同期します。すぐに反映されます。',
  'catalog.sync': 'ゲートウェイと同期',
  'catalog.syncing': '同期中…',
  'catalog.synced': '{count} 件のモデルを同期しました',
  'catalog.unchanged': '最新です',
  'catalog.no-credential': 'ゲートウェイの API キーが未設定です',
  'catalog.unauthorized': 'ゲートウェイがこの API キーを受け付けませんでした',
  'catalog.unreachable': 'ゲートウェイに接続できません',
  'catalog.empty': 'モデルが返されませんでした。現在の一覧を保持します',
  'catalog.failed': '同期に失敗しました',
  'catalog.count': '{count} 件のモデル',
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
  'catalog.title': 'Catálogo de modelos',
  'catalog.description': 'Sincroniza la lista de modelos desde la pasarela de esta instalación; se aplica de inmediato.',
  'catalog.sync': 'Sincronizar con la pasarela',
  'catalog.syncing': 'Sincronizando…',
  'catalog.synced': '{count} modelos sincronizados',
  'catalog.unchanged': 'Ya está al día',
  'catalog.no-credential': 'Aún no hay clave de API de la pasarela',
  'catalog.unauthorized': 'La pasarela rechazó esta clave',
  'catalog.unreachable': 'No se pudo contactar con la pasarela',
  'catalog.empty': 'La pasarela no devolvió modelos; se mantiene la lista actual',
  'catalog.failed': 'Falló la sincronización',
  'catalog.count': '{count} modelos',
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
  'catalog.title': 'Catalogue de modèles',
  'catalog.description': 'Synchronise la liste des modèles depuis la passerelle de ce déploiement ; prise en compte immédiate.',
  'catalog.sync': 'Synchroniser',
  'catalog.syncing': 'Synchronisation…',
  'catalog.synced': '{count} modèles synchronisés',
  'catalog.unchanged': 'Déjà à jour',
  'catalog.no-credential': 'Aucune clé d’API de passerelle enregistrée',
  'catalog.unauthorized': 'La passerelle a refusé cette clé',
  'catalog.unreachable': 'Passerelle injoignable',
  'catalog.empty': 'La passerelle n’a listé aucun modèle ; la liste actuelle est conservée',
  'catalog.failed': 'Échec de la synchronisation',
  'catalog.count': '{count} modèles',
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
  'catalog.title': 'Modellkatalog',
  'catalog.description': 'Synchronisiert die Modellliste mit dem Gateway dieser Installation; wirkt sofort.',
  'catalog.sync': 'Mit Gateway synchronisieren',
  'catalog.syncing': 'Synchronisiere…',
  'catalog.synced': '{count} Modelle synchronisiert',
  'catalog.unchanged': 'Bereits aktuell',
  'catalog.no-credential': 'Noch kein Gateway-API-Schlüssel gespeichert',
  'catalog.unauthorized': 'Das Gateway hat diesen Schlüssel abgelehnt',
  'catalog.unreachable': 'Gateway nicht erreichbar',
  'catalog.empty': 'Das Gateway hat keine Modelle gelistet; die aktuelle Liste bleibt',
  'catalog.failed': 'Synchronisierung fehlgeschlagen',
  'catalog.count': '{count} Modelle',
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
  'catalog.title': 'Каталог моделей',
  'catalog.description': 'Синхронизирует список моделей со шлюзом этой установки; изменения применяются сразу.',
  'catalog.sync': 'Синхронизировать со шлюзом',
  'catalog.syncing': 'Синхронизация…',
  'catalog.synced': 'Синхронизировано моделей: {count}',
  'catalog.unchanged': 'Уже актуально',
  'catalog.no-credential': 'Ключ API шлюза ещё не сохранён',
  'catalog.unauthorized': 'Шлюз отклонил этот ключ',
  'catalog.unreachable': 'Шлюз недоступен',
  'catalog.empty': 'Шлюз не вернул моделей; текущий список сохранён',
  'catalog.failed': 'Не удалось синхронизировать',
  'catalog.count': 'Моделей: {count}',
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
  'catalog.title': 'Catálogo de modelos',
  'catalog.description': 'Sincroniza a lista de modelos do gateway desta instalação; vale imediatamente.',
  'catalog.sync': 'Sincronizar do gateway',
  'catalog.syncing': 'Sincronizando…',
  'catalog.synced': '{count} modelos sincronizados',
  'catalog.unchanged': 'Já está atualizado',
  'catalog.no-credential': 'Ainda não há chave de API do gateway',
  'catalog.unauthorized': 'O gateway recusou esta chave',
  'catalog.unreachable': 'Não foi possível contactar o gateway',
  'catalog.empty': 'O gateway não listou modelos; a lista atual é mantida',
  'catalog.failed': 'Falha na sincronização',
  'catalog.count': '{count} modelos',
}
