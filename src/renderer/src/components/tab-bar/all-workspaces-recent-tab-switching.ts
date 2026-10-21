// Builds the Ctrl+Tab list for the all-workspaces scope from the open-tab entries
// Cmd+J searches plus agent chats, ordered by last focus like Cmd+J's recent tabs.

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { resolveUnifiedTabLabel } from '../../../../shared/tab-title-resolution'
import type { TabContentType, WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildSearchableBrowserPages } from '@/lib/browser-palette-page-entries'
import { formatBrowserPaletteUrl } from '@/lib/browser-palette-search'
import {
  dedupePaletteWorktrees,
  getPaletteWorktreeIdentity,
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from '@/lib/palette-repo-resolution'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import { orderRecentWorkspaceTabs } from '@/lib/recent-workspace-tab-rows'
import {
  buildSearchableSimulatorTabs,
  simulatorPaletteTabTitle
} from '@/lib/simulator-palette-search'
import {
  findAmbiguousWorktreeIds,
  findDuplicateIds,
  getUnifiedTabPaletteExecutionHostId,
  isUnifiedTabOwnedByWorktree
} from '@/lib/unified-tab-host-ownership'
import { buildSearchableWorkspaceTabs } from '@/lib/workspace-tab-palette-search'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getFolderWorkspaceWorktree } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { buildWorktreeJumpPaletteWorktreeMaps } from '../worktree-jump-palette-worktree-maps'
import type { OpenTabSearchResult } from './open-tab-search'
import type { AgentSessionTabSwitchResult } from './open-tab-selection-routing'

export type AllWorkspacesRecentTabItem = {
  key: string
  label: string
  /** Project and workspace that own the tab. */
  location: string
  type: WorkspaceVisibleTabType
  contentType: TabContentType
  isDirty: boolean
  result: OpenTabSearchResult | AgentSessionTabSwitchResult
}

export type AllWorkspacesRecentTabSwitcherModel = {
  items: AllWorkspacesRecentTabItem[]
  activeIndex: number
}

type Candidate = {
  item: AllWorkspacesRecentTabItem
  lastFocusedAt?: number
  isCurrent: boolean
}

export type AllWorkspacesRecentTabState = Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'agentStatusByPaneKey'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'folderWorkspaces'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'paneForegroundAgentByPaneKey'
  | 'repos'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
> & { settings?: AppState['settings'] }

function formatLocation(repoName: string, worktree: Worktree): string {
  const worktreeName = resolveWorktreeDisplayName(worktree)
  return repoName && repoName !== worktreeName ? `${repoName} · ${worktreeName}` : worktreeName
}

function rowKey(kind: string, worktree: Worktree, id: string): string {
  return encodePaletteIdentity([kind, getPaletteWorktreeIdentity(worktree), id])
}

function collectCandidates(state: AllWorkspacesRecentTabState): Candidate[] {
  const ownershipWorktrees = dedupePaletteWorktrees([
    ...Object.values(selectWorktreesByRepo(state)).flat(),
    ...selectFolderWorkspaces(state).map(getFolderWorkspaceWorktree)
  ])
  const worktrees = ownershipWorktrees.filter((worktree) => !worktree.isArchived)
  const scope = {
    worktrees,
    ownershipWorktrees,
    repoMap: new Map(state.repos.map((repo) => [repo.id, repo])),
    repoMapByHostIdentity: new Map(state.repos.map((repo) => [getRepoHostIdentity(repo), repo])),
    worktreeOrder: buildWorktreeJumpPaletteWorktreeMaps(worktrees).worktreeOrder,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    activeTabType: state.activeTabType
  }
  const dirtyFileIds = new Set(
    state.openFiles.filter((file) => file.isDirty).map((file) => file.id)
  )
  const generatedTitlesEnabled = state.settings?.tabAutoGenerateTitle === true

  const workspaceTabs = buildSearchableWorkspaceTabs({
    ...scope,
    tabsByWorktree: state.tabsByWorktree,
    openFiles: state.openFiles,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    groupsByWorktree: state.groupsByWorktree,
    activeTabId: state.activeTabId,
    activeTabIdByWorktree: state.activeTabIdByWorktree,
    activeFileId: state.activeFileId,
    activeFileIdByWorktree: state.activeFileIdByWorktree,
    activeTabTypeByWorktree: state.activeTabTypeByWorktree,
    generatedTitlesEnabled,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey
  }).map((entry): Candidate => {
    const key = rowKey('tab', entry.worktree, entry.tab.id)
    return {
      lastFocusedAt: entry.tab.lastFocusedAt,
      isCurrent: entry.isCurrentTab,
      item: {
        key,
        label: entry.title,
        location: formatLocation(entry.repoName, entry.worktree),
        type: entry.tab.contentType === 'terminal' ? 'terminal' : 'editor',
        contentType: entry.tab.contentType,
        isDirty: entry.tab.contentType !== 'terminal' && dirtyFileIds.has(entry.tab.entityId),
        result: {
          source: 'workspace',
          executionHostId:
            getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree) ??
            LOCAL_EXECUTION_HOST_ID,
          id: key,
          title: entry.title,
          matchedText: null,
          worktreeId: entry.worktree.id,
          contentType: entry.tab.contentType,
          tabId: entry.tab.id,
          entityId: entry.tab.entityId,
          groupId: entry.tab.groupId,
          relativePath: null,
          occupantAgent: entry.occupantAgent
        }
      }
    }
  })

  const browserPages = buildSearchableBrowserPages({
    ...scope,
    browserTabsByWorktree: state.browserTabsByWorktree,
    browserPagesByWorkspace: state.browserPagesByWorkspace,
    activeBrowserTabId: state.activeBrowserTabId
  }).map((entry): Candidate => {
    const title = entry.page.title || formatBrowserPaletteUrl(entry.page.url)
    const key = rowKey('page', entry.worktree, entry.page.id)
    return {
      lastFocusedAt: entry.lastFocusedAt,
      isCurrent: entry.isCurrentPage,
      item: {
        key,
        label: title,
        location: formatLocation(entry.repoName, entry.worktree),
        type: 'browser',
        contentType: 'browser',
        isDirty: false,
        result: {
          source: 'browser',
          executionHostId: entry.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
          id: key,
          title,
          matchedText: null,
          worktreeId: entry.worktree.id,
          contentType: 'browser',
          pageId: entry.page.id,
          workspaceId: entry.workspace.id,
          url: entry.page.url,
          faviconUrl: entry.page.faviconUrl ?? null
        }
      }
    }
  })

  const simulatorTabs = buildSearchableSimulatorTabs({
    ...scope,
    activeGroupIdByWorktree: state.activeGroupIdByWorktree,
    groupsByWorktree: state.groupsByWorktree
  }).map((entry): Candidate => {
    const title = simulatorPaletteTabTitle(entry.tab)
    const key = rowKey('simulator', entry.worktree, entry.tab.id)
    return {
      lastFocusedAt: entry.tab.lastFocusedAt,
      isCurrent: entry.isCurrentTab,
      item: {
        key,
        label: title,
        location: formatLocation(entry.repoName, entry.worktree),
        type: 'simulator',
        contentType: 'simulator',
        isDirty: false,
        result: {
          source: 'simulator',
          executionHostId:
            getUnifiedTabPaletteExecutionHostId(entry.tab, entry.worktree) ??
            LOCAL_EXECUTION_HOST_ID,
          id: key,
          title,
          matchedText: null,
          worktreeId: entry.worktree.id,
          contentType: 'simulator',
          tabId: entry.tab.id,
          groupId: entry.tab.groupId
        }
      }
    }
  })

  // Why: Cmd+J does not list agent chats, so their rows come straight from the unified tabs.
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(ownershipWorktrees)
  const agentSessionTabs = worktrees.flatMap((worktree) => {
    const tabs = state.unifiedTabsByWorktree[worktree.id] ?? []
    const duplicateTabIds = findDuplicateIds(tabs)
    const activeGroupId = state.activeGroupIdByWorktree[worktree.id]
    // Why: as in This workspace, the focused group's active tab is the one on screen.
    const shownTabId = isPaletteCurrentWorktree(
      worktree,
      state.activeWorktreeId,
      state.activeWorkspaceExecutionHostId
    )
      ? (state.groupsByWorktree[worktree.id] ?? []).find((group) => group.id === activeGroupId)
          ?.activeTabId
      : undefined
    const repoName =
      resolvePaletteRepoForWorktree(worktree, scope.repoMap, scope.repoMapByHostIdentity)
        ?.displayName ?? ''
    return tabs.flatMap((tab): Candidate[] => {
      if (
        tab.contentType !== 'agent-session' ||
        duplicateTabIds.has(tab.id) ||
        !isUnifiedTabOwnedByWorktree(tab, worktree, ambiguousWorktreeIds)
      ) {
        return []
      }
      return [
        {
          lastFocusedAt: tab.lastFocusedAt,
          isCurrent: tab.id === shownTabId,
          item: {
            key: rowKey('agent-session', worktree, tab.id),
            label: resolveUnifiedTabLabel(tab, generatedTitlesEnabled, tab.entityId),
            location: formatLocation(repoName, worktree),
            type: 'agent-session',
            contentType: 'agent-session',
            isDirty: false,
            result: {
              source: 'agent-session',
              executionHostId:
                getUnifiedTabPaletteExecutionHostId(tab, worktree) ?? LOCAL_EXECUTION_HOST_ID,
              worktreeId: worktree.id,
              tabId: tab.id
            }
          }
        }
      ]
    })
  })

  return [...workspaceTabs, ...browserPages, ...simulatorTabs, ...agentSessionTabs]
}

export function buildAllWorkspacesRecentTabSwitcherModel(
  state: AllWorkspacesRecentTabState
): AllWorkspacesRecentTabSwitcherModel | null {
  const candidates = collectCandidates(state)
  if (candidates.length === 0) {
    return null
  }
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.item.key, candidate]))
  const ordered = orderRecentWorkspaceTabs({
    rows: candidates.map((candidate) => ({
      id: candidate.item.key,
      lastFocusedAt: candidate.lastFocusedAt
    }))
  }).flatMap((key) => candidateByKey.get(key) ?? [])
  const currentIndex = ordered.findIndex((candidate) => candidate.isCurrent)
  if (currentIndex > 0) {
    // Why: the tab on screen leads so the first Tab press lands on the previous one.
    const [current] = ordered.splice(currentIndex, 1)
    ordered.unshift(current)
  }
  return {
    items: ordered.map((candidate) => candidate.item),
    activeIndex: currentIndex === -1 ? -1 : 0
  }
}
