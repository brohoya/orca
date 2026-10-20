import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { activateStructuredAgentSessionTab } from './agent-session/structured-agent-session-tab-activation'
import {
  findAmbiguousWorktreeIds,
  getPaletteOwnershipWorktreeIds,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'
import { activateAndRevealWorkspace } from './worktree-activation'

export type AgentSessionTabPaletteActivationResult =
  | { status: 'activated' }
  | { status: 'blocked' }
  | { status: 'failed'; reason: 'missing-tab' | 'missing-worktree' }

export type AgentSessionTabPaletteActivationTarget = {
  executionHostId: ExecutionHostId
  tabId: string
  worktreeId: string
}

export function activateAgentSessionTabPaletteResult({
  executionHostId,
  tabId,
  worktreeId
}: AgentSessionTabPaletteActivationTarget): AgentSessionTabPaletteActivationResult {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree) {
    return { status: 'failed', reason: 'missing-worktree' }
  }
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(getPaletteOwnershipWorktreeIds(state))
  const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter((tab) => tab.id === tabId)
  if (
    tabs.length !== 1 ||
    tabs[0].contentType !== 'agent-session' ||
    !isUnifiedTabOwnedByWorktree(tabs[0], worktree, ambiguousWorktreeIds)
  ) {
    return { status: 'failed', reason: 'missing-tab' }
  }
  if (!activateAndRevealWorkspace(worktree.id, { executionHostId })) {
    return { status: 'blocked' }
  }
  // Why: this path also focuses the chat composer and tells the chat's host which tab is active.
  return activateStructuredAgentSessionTab({ worktreeId, tabId })
    ? { status: 'activated' }
    : { status: 'failed', reason: 'missing-tab' }
}
