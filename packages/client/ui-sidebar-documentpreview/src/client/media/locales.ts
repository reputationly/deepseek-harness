/** Locale-owned media renderer labels and status text. */
export const zh = {
  title: '媒体',
  preview: '媒体预览：{name}',
  loading: '媒体加载中...',
  failed: '无法播放这个媒体文件',
  unsupported: '媒体预览需要完整文件内容',
} satisfies Record<string, string>

/** Media renderer dictionary keys. */
export type MediaPreviewKey = keyof typeof zh

export const en = {
  title: 'Media',
  preview: 'Media preview: {name}',
  loading: 'Loading media...',
  failed: 'This media file could not be played.',
  unsupported: 'Media preview requires the complete file contents.',
} satisfies Record<MediaPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Audio/video preview accessible name and status text. */
    sidebarMedia: MediaPreviewKey
  }
}

export const ja = {
  title: 'メディア',
  preview: 'メディアプレビュー: {name}',
  loading: 'メディアを読み込み中...',
  failed: 'このメディアファイルを再生できませんでした。',
  unsupported: 'メディアプレビューには完全なファイル内容が必要です。',
} satisfies Record<keyof typeof en, string>

export const es = {
  title: 'Multimedia',
  preview: 'Vista previa multimedia: {name}',
  loading: 'Cargando multimedia...',
  failed: 'Este archivo multimedia no se pudo reproducir.',
  unsupported: 'La vista previa multimedia requiere el contenido completo del archivo.',
} satisfies Record<keyof typeof en, string>

export const fr = {
  title: 'Média',
  preview: 'Aperçu du média : {name}',
  loading: 'Chargement du média...',
  failed: 'Ce fichier multimédia n’a pas pu être lu.',
  unsupported: 'L’aperçu multimédia nécessite le contenu complet du fichier.',
} satisfies Record<keyof typeof en, string>

export const de = {
  title: 'Medien',
  preview: 'Medienvorschau: {name}',
  loading: 'Medien werden geladen...',
  failed: 'Diese Mediendatei konnte nicht wiedergegeben werden.',
  unsupported: 'Für die Medienvorschau ist der vollständige Dateiinhalt erforderlich.',
} satisfies Record<keyof typeof en, string>

export const ru = {
  title: 'Медиа',
  preview: 'Просмотр медиа: {name}',
  loading: 'Загрузка медиа...',
  failed: 'Не удалось воспроизвести этот медиафайл.',
  unsupported: 'Для просмотра медиа требуется полное содержимое файла.',
} satisfies Record<keyof typeof en, string>

export const pt = {
  title: 'Mídia',
  preview: 'Pré-visualização de mídia: {name}',
  loading: 'Carregando mídia...',
  failed: 'Não foi possível reproduzir este arquivo de mídia.',
  unsupported: 'A pré-visualização de mídia requer o conteúdo completo do arquivo.',
} satisfies Record<keyof typeof en, string>
