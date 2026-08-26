// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardSurface } from '../src/client/Dashboard.tsx'
import { fixtureSnapshot } from '../src/client/fixture.ts'
import { projectAutonomousLifecycle } from '../src/lifecycle/autonomous.ts'

const callbacks = {
  onRefresh: async () => {},
  onPause: async () => {},
  onStop: async () => {},
  onCreateTask: async () => {},
  onUpdateTask: async () => {},
  onDeleteTask: async () => {},
  onSwitchProject: async () => {},
  onAddDiscoveryRoot: async () => {},
  onRemoveDiscoveryRoot: async () => {},
  onScanProjects: async () => ({ root: fixtureSnapshot.catalog.discoveryRoots[0]!, candidates: [], truncated: false }),
  onRegisterProjectCandidate: async () => {},
  onRegisterProject: async () => {},
  onOpenSession: () => {},
}

afterEach(cleanup)

describe('task detail inspector', () => {
  it('loads the timeline lazily and filters the returned event categories', async () => {
    const onLoadTimeline = vi.fn(async () => ({
      coverage: 'runtime-session' as const,
      truncated: false,
      events: [
        { id: 'agent', type: 'assistant/message', category: 'agent' as const, title: 'Assistant message', at: '2026-08-14T10:04:00.000Z' },
        { id: 'task', type: 'task.updated', category: 'task' as const, title: 'Task updated', at: '2026-08-14T10:00:00.000Z' },
      ],
    }))
    render(<DashboardSurface {...callbacks} snapshot={fixtureSnapshot} initialSelectedKey="linear:ENG:issue-238" onLoadTimeline={onLoadTimeline} />)

    expect(onLoadTimeline).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: '时间线' }))
    await waitFor(() => expect(onLoadTimeline).toHaveBeenCalledWith('linear:ENG:issue-238', undefined))
    expect(screen.getByText('本次运行')).toBeTruthy()
    expect(screen.getByText('Agent 更新')).toBeTruthy()
    expect(screen.getByText('任务已更新')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    expect(screen.getByText('Agent 更新')).toBeTruthy()
    expect(screen.queryByText('任务已更新')).toBeNull()
  })

  it('keeps the contextual primary action and puts destructive actions in a real menu', () => {
    render(<DashboardSurface {...callbacks} snapshot={fixtureSnapshot} initialSelectedKey="linear:ENG:issue-238" />)

    expect(screen.getAllByRole('button', { name: '打开会话' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '停止 Agent' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '停止 Agent' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '复制任务标识' })).toBeTruthy()
  })

  it('shows current role, next transition, structured evidence, and a true human interrupt in the inspector', () => {
    const sha = 'a'.repeat(40)
    const issue = fixtureSnapshot.board.columns[2]!.issues[0]!
    const lifecycle = projectAutonomousLifecycle(issue.identifier, issue.title, issue.state.name, [
      {
        schemaVersion: 'control-plane/v1', eventId: 'created', type: 'TASK_CREATED', taskId: 'eng-238-implement-issue-detail-inspector', domain: 'work',
        actor: { id: 'intake', domain: 'work' }, occurredAt: '2026-08-26T10:00:00.000Z', payload: { title: issue.title, initialState: 'IDEA' },
      },
      {
        schemaVersion: 'control-plane/v1', eventId: 'pr', type: 'STATE_TRANSITIONED', taskId: 'eng-238-implement-issue-detail-inspector', domain: 'work',
        actor: { id: 'author', domain: 'work' }, occurredAt: '2026-08-26T10:01:00.000Z', payload: { to: 'PR_OPEN', evidence: { headSha: sha, baseSha: 'b'.repeat(40), pullRequestUrl: 'https://example.test/pr/238', authorId: 'author' } },
      },
      {
        schemaVersion: 'control-plane/v1', eventId: 'wait', type: 'STATE_TRANSITIONED', taskId: 'eng-238-implement-issue-detail-inspector', domain: 'work',
        actor: { id: 'operator', domain: 'work' }, occurredAt: '2026-08-26T10:02:00.000Z', payload: { to: 'WAITING_HUMAN', evidence: { reason: 'approval required' } },
      },
    ])
    const snapshot = {
      ...fixtureSnapshot,
      board: {
        ...fixtureSnapshot.board,
        columns: fixtureSnapshot.board.columns.map(column => ({
          ...column,
          issues: column.issues.map(candidate => candidate.nativeRef === issue.nativeRef ? { ...candidate, autonomousLifecycle: lifecycle } : candidate),
        })),
      },
    }
    render(<DashboardSurface {...callbacks} snapshot={snapshot} initialSelectedKey="linear:ENG:issue-238" />)

    expect(screen.getByText('自主生命周期')).toBeTruthy()
    expect(screen.getByText('human')).toBeTruthy()
    expect(screen.getByText('WAITING_HUMAN')).toBeTruthy()
    expect(screen.getByText('正在等待明确的人类决定')).toBeTruthy()
    expect(screen.getByText('headSha')).toBeTruthy()
  })
})
