/** Default image collection path of an OpenAI-compatible gateway. */
export const DEFAULT_IMAGES_PATH = '/v1/images/generations'
/** Default video collection path of an OpenAI-compatible gateway. */
export const DEFAULT_VIDEOS_PATH = '/v1/videos'
/** Default request budget of one task-transport call. */
export const DEFAULT_MEDIA_TIMEOUT_MS = 30_000
/** Default request budget of one image call; the image endpoint answers only when the image exists. */
export const DEFAULT_MEDIA_IMAGE_TIMEOUT_MS = 240_000
/** Default interval between two status reads. */
export const DEFAULT_MEDIA_POLL_MS = 2_000
