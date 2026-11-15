/** Card component of every node type. */
import { AudioNode, ImageNode, VideoNode } from './media.tsx'
import { ScriptNode, StoryboardNode, TextNode, TimelineNode } from './text.tsx'
import { GroupNode } from './group.tsx'

/**
 * Flow renderers for each canvas node kind.
 */
export const NODE_TYPES = {
  image: ImageNode,
  video: VideoNode,
  audio: AudioNode,
  text: TextNode,
  script: ScriptNode,
  storyboard: StoryboardNode,
  timeline: TimelineNode,
  frame: GroupNode,
}
