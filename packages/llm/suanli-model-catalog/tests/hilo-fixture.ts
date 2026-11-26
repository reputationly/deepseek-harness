/** A Hilo catalog shaped like the gateway's, trimmed to one entry per kind. */

/** One image entry. */
export const IMAGE = {
  id: 'MiniMax-H3-Image',
  platformModel: 'minimax-h3-image',
  displayName: 'MiniMax H3 Image',
  description: 'Text and reference images to image',
  interfaceType: 'maas-image',
  maxRefs: 4,
  params: {
    aspect_ratio: { type: 'select', label: '宽高比', default: 'adaptive', options: ['adaptive', '1:1', '16:9', '9:16'] },
    resolution: { type: 'select', label: '分辨率', default: '2K', options: ['1K', '2K'] },
  },
}

/** One first/last-frame video entry. */
export const VIDEO = {
  id: 'MiniMax-H3-FL',
  platformModel: 'minimax-h3-2k',
  displayName: 'MiniMax H3 FL',
  interfaceType: 'maas-video',
  maxRefs: 2,
  params: {
    duration: { type: 'select', label: '时长', default: '15', options: ['1', '5', '15', '20'] },
    image_mode: { type: 'select', label: '玩法', default: 'first-last-frame', options: ['first-last-frame', 'text-to-video', 'video-extension'] },
    ratio: { type: 'select', label: '比例', default: 'adaptive', options: ['adaptive', '16:9'] },
    resolution: { type: 'select', label: '分辨率', default: '2K', options: ['768P', '2K'] },
  },
}

/** One music entry, which declares no interface type. */
export const MUSIC = {
  id: 'music-3.0',
  platformModel: 'minimax-music3',
  displayName: 'Music 3.0',
  params: {
    is_instrumental: { type: 'select', label: '纯音乐', default: 'false', options: ['true', 'false'] },
    lyrics: { type: 'textarea', label: '歌词', default: '', optional: true },
  },
}

/** Two chat models; the second also understands video. */
export const TEXT = [
  { id: 'deepseek-v4-1-flash', platformModel: 'deepseek-v4-1-flash', displayName: 'DeepSeek V4.1 Flash', interfaceType: 'chat-completion', supportsImage: true },
  { id: 'qwen3.8-flash-fp8', platformModel: 'qwen3.8-flash-fp8', displayName: 'Qwen 3.8 Flash', interfaceType: 'chat-completion', supportsImage: true, supportsVideo: true },
]

/**
 * A Hilo catalog payload.
 * @param overrides - sections or fields to replace.
 * @returns the payload the gateway would serve.
 */
export function hilo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'v1',
    image: [IMAGE],
    video: [VIDEO],
    audio: [MUSIC],
    text: TEXT,
    defaults: { chat: 'deepseek-v4-1-flash', multimodal: 'qwen3.8-flash-fp8' },
    ...overrides,
  }
}

/**
 * The gateway's answer carrying one payload.
 * @param value - response body.
 * @param status - HTTP status.
 * @returns the response.
 */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
