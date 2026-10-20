import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

type FocusedTabState = Pick<
  AppState,
  'activeWorktreeId' | 'activeGroupIdByWorktree' | 'groupsByWorktree' | 'unifiedTabsByWorktree'
>

type FocusedTab = { worktreeId: string; tabId: string; lastFocusedAt: number }

function readFocusedTab(state: FocusedTabState): FocusedTab | null {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  const tabId = (state.groupsByWorktree[worktreeId] ?? []).find(
    (group) => group.id === groupId
  )?.activeTabId
  const tab = tabId
    ? (state.unifiedTabsByWorktree[worktreeId] ?? []).find((item) => item.id === tabId)
    : undefined
  return tab ? { worktreeId, tabId: tab.id, lastFocusedAt: tab.lastFocusedAt ?? 0 } : null
}

/**
 * Stamps lastFocusedAt on the tab that a workspace switch or a pane focus puts on screen,
 * because those paths do not call activateTab. Cmd+J and Ctrl+Tab order by it.
 * Follow-up: TabGroup.recentTabIds and lastVisitedAtByWorktreeId keep similar orders. This
 * observer could be their one writer, and each list could filter the same data.
 */
export function useTabFocusRecency({ enabled }: { enabled: boolean }): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    let stampedKey: string | null = null
    let changedAt: number | null = null
    const stamp = (): void => {
      const since = changedAt ?? Date.now()
      changedAt = null
      const state = useAppStore.getState()
      const focused = readFocusedTab(state)
      const key = focused ? `${focused.worktreeId}\u0000${focused.tabId}` : null
      if (key === stampedKey) {
        return
      }
      stampedKey = key
      // Why: a tab that activateTab selected in this task already has its stamp.
      if (!focused || focused.lastFocusedAt >= since) {
        return
      }
      // Why: activateTab stays the one renderer writer of focus times (layout-writer ratchet).
      state.activateTab(focused.tabId, { worktreeId: focused.worktreeId, preservePreview: true })
    }
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (
        changedAt !== null ||
        (state.activeWorktreeId === previous.activeWorktreeId &&
          state.activeGroupIdByWorktree === previous.activeGroupIdByWorktree &&
          state.groupsByWorktree === previous.groupsByWorktree)
      ) {
        return
      }
      changedAt = Date.now()
      // Why: Cmd+J and Ctrl+Tab switch the workspace and then select a tab in one task;
      // only the tab that is on screen at the end of the task is a visit.
      queueMicrotask(stamp)
    })
    stamp()
    return unsubscribe
  }, [enabled])
}
