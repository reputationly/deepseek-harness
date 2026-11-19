import { describe, expect, it, vi } from 'vitest'
import { gazeDelta, gazePayload, lookCell } from '../src/pet/pet-gaze.ts'
import { createPetHostBridge } from '../src/pet/pet-host-bridge.ts'
import { PET_IPC, constrainPetBounds, parsePetWindowState, validPetCommand, type PetWindowState } from '../src/pet/pet-window-policy.ts'

const sprite = 'data:image/webp;base64,AAAA'

function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sprite,
    language: 'zh-CN',
    pet: { id: 'suanli', name: 'Suanli', description: 'Garlic cat', url: '/dsh-codex-pet/asset/suanli', version: 2, source: 'builtin' },
    config: { selected: 'suanli', visible: true, size: 120, position: null },
    activity: { pose: 'idle', title: '', text: '' },
    notifications: { items: [], hidden: 0, activity: { pose: 'idle', title: '', text: '' } },
    ...overrides,
  }
}

function stateWith(items: unknown[]): PetWindowState {
  const state = parsePetWindowState(snapshot({ notifications: { items, hidden: 0, activity: { pose: 'idle', title: '', text: '' } } }))
  if (state === null) throw new Error('fixture state did not parse')
  return state
}

describe('parsePetWindowState', () => {
  it('accepts the snapshot the pet plugin publishes and drops the stored position', () => {
    const state = parsePetWindowState(snapshot({ config: { selected: 'suanli', visible: true, size: 120, position: { x: 3, y: 4 } } }))
    expect(state?.pet.id).toBe('suanli')
    expect(state?.config).toEqual({ selected: 'suanli', visible: true, size: 120, position: null })
    expect(state?.sprite).toBe(sprite)
  })

  it.each([
    ['a sprite that is not an image data URL', { sprite: 'https://example.com/pet.webp' }],
    ['an asset route outside the plugin', { pet: { id: 'suanli', name: 'S', description: '', url: '/other/asset/suanli', version: 2, source: 'builtin' } }],
    ['an identifier with path characters', { pet: { id: '../x', name: 'S', description: '', url: '/dsh-codex-pet/asset/..%2Fx', version: 2, source: 'builtin' } }],
    ['an unknown spritesheet version', { pet: { id: 'suanli', name: 'S', description: '', url: '/dsh-codex-pet/asset/suanli', version: 3, source: 'builtin' } }],
    ['an unknown source', { pet: { id: 'suanli', name: 'S', description: '', url: '/dsh-codex-pet/asset/suanli', version: 2, source: 'remote' } }],
    ['a size outside the supported range', { config: { selected: 'suanli', visible: true, size: 400, position: null } }],
    ['an unknown pose', { activity: { pose: 'dancing', title: '', text: '' } }],
    ['a malformed language tag', { language: 'zh CN' }],
    ['a notification without a token', { notifications: { items: [{ id: 'a', pose: 'running', title: 't', text: 'x', updatedAt: 1 }], hidden: 0 } }],
  ])('rejects %s', (_name, overrides) => {
    expect(parsePetWindowState(snapshot(overrides))).toBeNull()
  })

  it('rejects values that are not snapshots', () => {
    expect(parsePetWindowState(null)).toBeNull()
    expect(parsePetWindowState('pet')).toBeNull()
    expect(parsePetWindowState({})).toBeNull()
  })
})

describe('validPetCommand', () => {
  const running = { id: 'a', token: 't1', pose: 'running', title: 'Task', text: 'Working', updatedAt: 1 }
  const approval = { id: 'b', token: 't2', pose: 'waiting', title: 'Task', text: 'Waiting', updatedAt: 2, request: { key: 'k', kind: 'approval' } }
  const question = {
    id: 'c', token: 't3', pose: 'waiting', title: 'Task', text: 'Waiting', updatedAt: 3,
    request: { key: 'q', kind: 'question', questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] },
  }
  const state = stateWith([running, approval, question])

  it('allows actions that match a live notification', () => {
    expect(validPetCommand({ type: 'stop', id: 'a', token: 't1' }, state)).toBe(true)
    expect(validPetCommand({ type: 'open', id: 'b', token: 't2' }, state)).toBe(true)
    expect(validPetCommand({ type: 'approve', id: 'b', token: 't2', requestKey: 'k' }, state)).toBe(true)
    expect(validPetCommand({ type: 'answer', id: 'c', token: 't3', requestKey: 'q', answers: { answers: [{ id: 'q1', selected: ['A'] }] } }, state)).toBe(true)
    expect(validPetCommand({ type: 'restore' }, state)).toBe(true)
    expect(validPetCommand({ type: 'sort', latest: true }, state)).toBe(true)
  })

  it('refuses actions for a stale token, another request, or the wrong kind', () => {
    expect(validPetCommand({ type: 'stop', id: 'a', token: 'old' }, state)).toBe(false)
    expect(validPetCommand({ type: 'stop', id: 'b', token: 't2' }, state)).toBe(false)
    expect(validPetCommand({ type: 'approve', id: 'b', token: 't2', requestKey: 'other' }, state)).toBe(false)
    expect(validPetCommand({ type: 'approve', id: 'c', token: 't3', requestKey: 'q' }, state)).toBe(false)
    expect(validPetCommand({ type: 'sort', latest: 'yes' }, state)).toBe(false)
    expect(validPetCommand({ type: 'open', id: 'a', token: 't1' }, null)).toBe(false)
  })

  it('refuses answers that do not fit the question', () => {
    const answer = (answers: unknown): unknown => ({ type: 'answer', id: 'c', token: 't3', requestKey: 'q', answers: { answers } })
    expect(validPetCommand(answer([{ id: 'q1', selected: ['C'] }]), state)).toBe(false)
    expect(validPetCommand(answer([{ id: 'q1', selected: ['A', 'B'] }]), state)).toBe(false)
    expect(validPetCommand(answer([{ id: 'q1', selected: [] }]), state)).toBe(false)
    expect(validPetCommand(answer([{ id: 'q1', selected: [], custom: 'something else' }]), state)).toBe(true)
    expect(validPetCommand(answer([]), state)).toBe(false)
    expect(validPetCommand(answer([null]), state)).toBe(false)
  })
})

describe('constrainPetBounds', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }

  it('keeps a position inside the work area', () => {
    expect(constrainPetBounds({ x: 100, y: 200 }, area)).toEqual({ x: 100, y: 200 })
  })

  it('pulls a position back from every edge', () => {
    expect(constrainPetBounds({ x: -50, y: -50 }, area)).toEqual({ x: 0, y: 0 })
    expect(constrainPetBounds({ x: 5000, y: 5000 }, area)).toEqual({ x: 1600, y: 480 })
  })

  it('uses the origin of a display on the left of the primary one', () => {
    expect(constrainPetBounds({ x: -3000, y: 0 }, { x: -1280, y: 0, width: 1280, height: 720 })).toEqual({ x: -1280, y: 0 })
  })
})

describe('gaze', () => {
  it('reports no direction inside the dead zone', () => {
    expect(lookCell(5, 5)).toBeNull()
  })

  it('maps the cursor to 16 clockwise frames starting straight up', () => {
    expect(lookCell(0, -100)).toEqual({ row: 9, col: 0 })
    expect(lookCell(100, 0)).toEqual({ row: 9, col: 4 })
    expect(lookCell(0, 100)).toEqual({ row: 10, col: 0 })
    expect(lookCell(-100, 0)).toEqual({ row: 10, col: 4 })
  })

  it('measures the offset from the sprite center', () => {
    expect(gazeDelta({ x: 248, y: 465 }, { x: 0, y: 0, width: 320, height: 560 }, 120)).toEqual({ dx: 0, dy: 0 })
  })

  it('follows the cursor only for an idle version 2 pet', () => {
    const bounds = { x: 0, y: 0, width: 320, height: 560 }
    const idle = { pet: { version: 2 }, activity: { pose: 'idle' }, config: { size: 120 } }
    expect(gazePayload(idle, { x: 0, y: 0 }, bounds)).toEqual({ dx: -248, dy: -465 })
    expect(gazePayload({ ...idle, pet: { version: 1 } }, { x: 0, y: 0 }, bounds)).toBeNull()
    expect(gazePayload({ ...idle, activity: { pose: 'running' } }, { x: 0, y: 0 }, bounds)).toBeNull()
    expect(gazePayload(null, { x: 0, y: 0 }, bounds)).toBeNull()
  })
})

describe('createPetHostBridge', () => {
  function fakeIpc() {
    const listeners = new Map<string, (...values: unknown[]) => void>()
    return {
      listeners,
      invoke: vi.fn(() => Promise.resolve()),
      send: vi.fn(),
      on: vi.fn((channel: string, listener: (...values: unknown[]) => void) => { listeners.set(channel, listener) }),
      removeListener: vi.fn((channel: string) => { listeners.delete(channel) }),
    }
  }

  it('forwards pet state to the shell', async () => {
    const ipc = fakeIpc()
    await createPetHostBridge(ipc as never).sync({ pet: null })
    expect(ipc.invoke).toHaveBeenCalledWith(PET_IPC.sync, { pet: null })
  })

  it('reports the outcome of each relayed command by its identifier', async () => {
    const ipc = fakeIpc()
    const handler = vi.fn((command: unknown) => (command as { type: string }).type === 'stop' ? Promise.resolve() : Promise.reject(new Error('gone')))
    const stop = createPetHostBridge(ipc as never).onCommand(handler)
    ipc.listeners.get(PET_IPC.command)?.({}, 'one', { type: 'stop' })
    ipc.listeners.get(PET_IPC.command)?.({}, 'two', { type: 'open' })
    await vi.waitFor(() => { expect(ipc.send).toHaveBeenCalledTimes(2) })
    expect(ipc.send).toHaveBeenCalledWith(PET_IPC.commandResult, 'one')
    expect(ipc.send).toHaveBeenCalledWith(PET_IPC.commandResult, 'two', 'gone')
    stop()
    expect(ipc.listeners.has(PET_IPC.command)).toBe(false)
  })

  it('relays shell actions until the listener is removed', () => {
    const ipc = fakeIpc()
    const actions: string[] = []
    const stop = createPetHostBridge(ipc as never).onAction((action) => { actions.push(action) })
    ipc.listeners.get(PET_IPC.action)?.({}, 'settings')
    stop()
    expect(actions).toEqual(['settings'])
    expect(ipc.listeners.has(PET_IPC.action)).toBe(false)
  })
})
