// @vitest-environment jsdom
/** Generation starts directly once the plan is ready, with no confirmation step. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EpisodeId } from '@deepseek-ai/dsh-canvas/client'
import type { MediaPlanView } from '@deepseek-ai/dsh-api-remotes/client'
import { useGenerationControls } from '../src/client/GenerationControls.tsx'

afterEach(cleanup)
type Props = Parameters<typeof useGenerationControls>[0]
const scope = { directory: '/project', episode: brandString<EpisodeId>('e1') }
const plan = (state: MediaPlanView['state'], message?: string): MediaPlanView => ({
  state, ...message === undefined ? {} : { message }, lines: [], jobs: [],
  totals: { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 1 },
})
function Harness(props: Props) {
  const value = useGenerationControls(props)
  return <><button onClick={() => { value.generate(['n1']) }}>generate</button>{value.feedback}</>
}
function props(): Props {
  return { document: undefined, scope, t: key => key,
    planNodes: vi.fn(async () => plan('ready')), generateNodes: vi.fn(async () => plan('started')) }
}

it('starts generation directly once the plan is ready', async () => {
  const value = props()
  render(<Harness {...value} />)
  fireEvent.click(screen.getByText('generate'))
  await waitFor(() => { expect(value.generateNodes).toHaveBeenCalledExactlyOnceWith(['n1'], scope) })
  expect(value.planNodes).toHaveBeenCalledExactlyOnceWith(['n1'], scope)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('does not start when the plan refuses', async () => {
  const value = { ...props(), planNodes: vi.fn(async () => plan('blocked', 'gate refused')) }
  render(<Harness {...value} />)
  fireEvent.click(screen.getByText('generate'))
  await screen.findByText('gate refused')
  expect(value.generateNodes).not.toHaveBeenCalled()
})

it('reports a refused start without presenting it as a successfully started job', async () => {
  const value = { ...props(), planNodes: vi.fn(async () => plan('ready')), generateNodes: vi.fn(async () => plan('failed', 'scope refused')) }
  render(<Harness {...value} />)
  fireEvent.click(screen.getByText('generate'))
  await screen.findByText('audio.notStarted')
  expect(screen.queryByText('inspector.started')).toBeNull()
})
