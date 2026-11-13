/**
 * Plan the audio nodes one storyboard's dialogue needs: one node per spoken line, reused across
 * rewrites by line id.
 * @module
 */

import { activeVersionOf, type Bible, type CanvasNode, type CanvasNodeId, type CanvasOperation, type Shot } from '@deepseek-ai/dsh-canvas'
import type { PlannedNode } from './budget.ts'

/** What one storyboard's dialogue needs. */
export interface DialoguePlan {
  /** Audio nodes to create. */
  readonly create: readonly CanvasOperation[]
  /** Nodes that will synthesize their line, whether reused or created. */
  readonly nodes: readonly PlannedNode[]
}

/** Voice one line uses: the character's, else the narrator's, else none. */
function voiceOf(bible: Bible, line: Shot['dialogue'][number]): string | undefined {
  const speaker = line.speaker
  if (speaker.kind === 'narrator') return bible.narrator?.voice
  return bible.entries.find(entry => entry.id === speaker.entry)?.voice?.voice
}

/** Existing audio node that already voices one line. */
function existingVoice(nodes: readonly CanvasNode[], storyboard: CanvasNodeId, shot: Shot, lineId: string): CanvasNode | undefined {
  return nodes.find(node => node.type === 'audio'
    && node.gen?.dialogue?.storyboard === storyboard
    && node.gen.dialogue.shot === shot.id
    && node.gen.dialogue.line === lineId)
}

/** Title one audio node shows: who speaks and what the line starts with. */
function titleOf(bible: Bible, line: Shot['dialogue'][number]): string {
  const speaker = line.speaker
  const name = speaker.kind === 'narrator'
    ? '旁白'
    : bible.entries.find(entry => entry.id === speaker.entry)?.name ?? '角色'
  const preview = line.line.length > 12 ? `${line.line.slice(0, 12)}…` : line.line
  return `${name} · ${preview}`
}

/**
 * Plan the audio nodes for every spoken line of one storyboard.
 * @param storyboard - storyboard node whose current version holds the shots.
 * @param bible - the project's bible, for speaker names and voices.
 * @param nodes - nodes already on the canvas, matched by line id.
 * @param model - speech model id.
 * @returns the nodes to create and the plan entries for all of them.
 * @throws Error when the node is not a storyboard.
 */
export function planDialogue(
  storyboard: CanvasNode,
  bible: Bible,
  nodes: readonly CanvasNode[],
  model: string,
): DialoguePlan {
  if (storyboard.type !== 'storyboard') throw new Error(`canvas node ${storyboard.id} is not a storyboard`)
  const create: CanvasOperation[] = []
  const planned: PlannedNode[] = []
  for (const shot of activeVersionOf(storyboard)?.shots ?? []) {
    for (const line of shot.dialogue) {
      const reused = existingVoice(nodes, storyboard.id, shot, line.id)
      if (reused !== undefined) {
        planned.push({
          node: reused.id, kind: 'speech', model, calls: 1, lines: 1,
        })
        continue
      }
      const voice = voiceOf(bible, line)
      create.push({
        op: 'add',
        ref: `voice-${shot.id}-${line.id}`,
        type: 'audio',
        title: titleOf(bible, line),
        gen: {
          kind: 'speech',
          prompt: line.line,
          model,
          params: voice === undefined ? {} : { voice },
          dialogue: { storyboard: storyboard.id, shot: shot.id, line: line.id },
        },
      })
      planned.push({
        node: `${storyboard.id}:${shot.id}:${line.id}` as CanvasNodeId,
        ref: `voice-${shot.id}-${line.id}`,
        kind: 'speech',
        model,
        calls: 1,
        lines: 1,
      })
    }
  }
  return { create, nodes: planned }
}
