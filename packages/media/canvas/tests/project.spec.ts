import { describe, expect, it } from 'vitest'
import { canvasFileOf, episodeOf, FREE_PROJECT, parseProject, serializeProject, withBinding, withEpisode, type StudioProject } from '../src/project.ts'

const project: StudioProject = {
  ...FREE_PROJECT,
  format: 'drama',
  title: 'Rain',
  spec: { aspect: '9:16', resolution: '1080p', fps: 30 },
  episodes: [{ id: 'e1' as never, title: '第一集', file: 'canvas.json' }],
  bindings: {},
}

describe('project', () => {
  it('parses and serializes a project', () => {
    expect(parseProject(serializeProject(project))).toEqual(project)
  })

  it('treats a project without episodes or bindings as free format', () => {
    const parsed = parseProject(JSON.stringify({
      version: 1, revision: 0, format: 'free', title: 'Canvas', spec: { aspect: '16:9', resolution: '1080p', fps: 24 }, episodes: [],
    }))
    expect(parsed.episodes).toEqual([])
    expect(parsed.bindings).toEqual({})
  })

  it('rejects malformed projects', () => {
    const bad = [
      'not json', '[]',
      '{"version":2}',
      '{"version":1,"revision":-1}',
      '{"version":1,"revision":0,"format":"podcast","title":"t","spec":{"aspect":"16:9","resolution":"r","fps":30},"episodes":[]}',
      '{"version":1,"revision":0,"format":"drama","title":"t","spec":{"aspect":"wide","resolution":"r","fps":30},"episodes":[]}',
      '{"version":1,"revision":0,"format":"drama","title":"t","spec":{"aspect":"16:9","resolution":"r","fps":29},"episodes":[]}',
      '{"version":1,"revision":0,"format":"drama","title":"t","spec":{"aspect":"16:9","resolution":"r","fps":30}}',
      '{"version":1,"revision":0,"format":"drama","title":"t","spec":{"aspect":"16:9","resolution":"r","fps":30},"episodes":[{"id":"e1","title":"t"}]}',
      '{"version":1,"revision":0,"format":"drama","title":"t","spec":{"aspect":"16:9","resolution":"r","fps":30},"episodes":[],"bindings":{"s1":"e9"}}',
    ]
    for (const source of bad) expect(() => parseProject(source)).toThrow()
  })

  it('resolves the canvas file of an episode', () => {
    expect(canvasFileOf('/p', FREE_PROJECT)).toBe('/p/.canvas/canvas.json')
    expect(canvasFileOf('/p', project)).toBe('/p/.canvas/canvas.json')
    expect(canvasFileOf('/p', project, 'e1' as never)).toBe('/p/.canvas/canvas.json')
    const two = withEpisode(project, '第二集').project
    expect(canvasFileOf('/p', two, 'e2' as never)).toBe('/p/.canvas/episodes/e2.json')
  })

  it('resolves the episode a session edits', () => {
    expect(episodeOf(project, 's1')).toBe('e1')
    const bound = withBinding(project, 's1', 'e1' as never)
    expect(episodeOf(bound, 's1')).toBe('e1')
    expect(() => episodeOf(FREE_PROJECT, 's1')).toThrow('no episode')
    expect(() => withBinding(project, 's1', 'e9' as never)).toThrow('does not exist')
  })

  it('appends episodes, reusing the single canvas for the first one', () => {
    const first = withEpisode(project, '第二集')
    expect(first.episode.file).toBe('episodes/e2.json')
    const fromEmpty = withEpisode(FREE_PROJECT, '第一集')
    expect(fromEmpty.episode).toMatchObject({ id: 'e1', file: 'canvas.json' })
    expect(fromEmpty.project.episodes).toHaveLength(1)
  })
})
