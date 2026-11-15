/** Copy for exact-version video node editing. */
export const videoZh = {
  'video.new': '新建视频', 'video.newTitle': '视频素材',
  'video.noVersion': '尚无视频候选', 'video.empty': '上传本机视频后，可在这里预览并编辑。',
  'video.localActions': '视频与本地操作', 'video.sourceVersion': '预览与操作的源版本', 'video.adopted': '已采用',
  'video.extractAudio': '提取音频', 'video.firstFrame': '提取首帧', 'video.lastFrame': '提取尾帧', 'video.refreshTail': '刷新衔接尾帧',
  'video.download': '下载此版本', 'video.previewFailed': '此版本暂时无法预览，请重试预览或检查原文件',
  'video.retryPreview': '重试预览',
  'video.upload': '上传视频为新候选', 'video.uploading': '正在上传并保存视频候选…', 'video.retainedFile': '{message} · 文件保留在：{path}',
  'video.localHint': '提取结果保存为新候选，不更改已采用版本。刷新衔接尾帧仅针对当前采用的视频',
  'video.resultTitle': '{title} · {operation}', 'video.processing': '正在本地处理：{operation}',
  'video.saved': '已保存新候选，可在画布中查看和采用', 'video.locateResult': '定位新素材',
}

/** English dictionary paired with the Chinese video keys. */
export const videoEn: Record<keyof typeof videoZh, string> = {
  'video.new': 'New video', 'video.newTitle': 'Video asset',
  'video.noVersion': 'No video candidates yet', 'video.empty': 'Upload a local video to preview and edit it here.',
  'video.localActions': 'Video and local actions', 'video.sourceVersion': 'Preview and operation source', 'video.adopted': 'Adopted',
  'video.extractAudio': 'Extract audio', 'video.firstFrame': 'Capture first frame', 'video.lastFrame': 'Capture last frame', 'video.refreshTail': 'Refresh continuity tail',
  'video.download': 'Download this version', 'video.previewFailed': 'This version could not be previewed. Retry the preview or check the original file.',
  'video.retryPreview': 'Retry preview',
  'video.upload': 'Upload video as a candidate', 'video.uploading': 'Uploading and saving the video candidate…', 'video.retainedFile': '{message} · File retained at: {path}',
  'video.localHint': 'Extraction creates candidates and preserves adoption. Refreshing the continuity tail applies only to the currently adopted video.',
  'video.resultTitle': '{title} · {operation}', 'video.processing': 'Processing locally: {operation}',
  'video.saved': 'A new candidate is saved for review and adoption on the canvas.', 'video.locateResult': 'Locate new media',
}
