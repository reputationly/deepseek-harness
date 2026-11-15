/** A generation test starts with its declared G1 prerequisite present. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Bible, BibleEntryId } from '@deepseek-ai/dsh-canvas'

export const bibleFixture: Bible = {
  version: 1, revision: 0, logline: 'A story', style: { visual: 'cinematic', aspect: '9:16' },
  entries: [{ id: brandString<BibleEntryId>('setting'), kind: 'location', name: '街道', aliases: [], description: '安静的街道', imageNodes: [] }],
}
