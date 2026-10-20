/**
 * E2E for the Ctrl+Tab switcher scope: a fresh profile lists only the current
 * workspace, Ctrl+A (Control still held) lists every workspace by last focus
 * without moving the box, releasing Control opens a tab in another workspace,
 * Escape cancels, and the next Ctrl+Tab keeps the chosen scope. A workspace
 * that a sidebar click shows and a pane that takes focus count as visits too.
 * Agent chat and browser page rows open in their own workspace, and outside a
 * workspace view This workspace says why it has no list. Writes the observed
 * switcher states and screenshots as a test artifact.
 */

import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { worktreeRowSurface } from './worktree-row-locators'

type SwitcherSnapshot = {
  title: string
  box: { x: number; y: number; width: number; height: number }
  rows: { text: string; selected: boolean }[]
}

const TAB_NAMES = [
  'Terminal 1',
  'diff-note-layout.ts',
  'index.ts',
  'package.json',
  'Switcher chat',
  'Switcher page'
]

function switcher(page: Page) {
  return page.getByRole('listbox', { name: 'Switch tabs' })
}

async function readSwitcher(page: Page): Promise<SwitcherSnapshot> {
  await expect(switcher(page)).toBeVisible()
  return switcher(page).evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect()
    return {
      title: element.firstElementChild?.firstElementChild?.textContent ?? '',
      box: { x, y, width, height },
      rows: [...element.querySelectorAll('[role="option"]')].map((row) => ({
        text: row.textContent ?? '',
        selected: row.getAttribute('aria-selected') === 'true'
      }))
    }
  })
}

/** Opens the switcher, reads it, and cancels it; the Control release must not switch tabs. */
async function peekSwitcher(page: Page): Promise<SwitcherSnapshot> {
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  const snapshot = await readSwitcher(page)
  await page.keyboard.press('Escape')
  await expect(switcher(page)).toHaveCount(0)
  await page.keyboard.up('Control')
  return snapshot
}

function rowIndex(snapshot: SwitcherSnapshot, fileName: string): number {
  return snapshot.rows.findIndex((row) => row.text.includes(fileName))
}

function rowNames(snapshot: SwitcherSnapshot): string[] {
  return snapshot.rows.map((row) => TAB_NAMES.find((name) => row.text.includes(name)) ?? row.text)
}

async function getWorktreeIdsByBranch(
  page: Page
): Promise<{ primaryId: string; secondaryId: string }> {
  return page.evaluate(() => {
    const worktrees = Object.values(window.__store!.getState().worktreesByRepo).flat()
    const secondary = worktrees.find((worktree) => worktree.branch.includes('e2e-secondary'))
    const primary = worktrees.find((worktree) => worktree !== secondary)
    if (!primary || !secondary) {
      throw new Error('the seeded repo needs its primary and e2e-secondary worktrees')
    }
    return { primaryId: primary.id, secondaryId: secondary.id }
  })
}

async function openSeededFile(
  page: Page,
  worktreeId: string,
  relativePath: string,
  opts: { activate?: boolean } = {}
): Promise<void> {
  await page.evaluate(
    ({ wId, relPath, activate }) => {
      const state = window.__store!.getState()
      // Why: one task, so the empty-workspace check sees this tab and seeds no first terminal.
      if (activate) {
        state.setActiveWorktree(wId)
      }
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        throw new Error(`unknown worktree ${wId}`)
      }
      const separator = worktree.path.includes('\\') ? '\\' : '/'
      state.openFile({
        filePath: `${worktree.path}${separator}${relPath.split('/').join(separator)}`,
        relativePath: relPath,
        worktreeId: wId,
        language: relPath.endsWith('.json') ? 'json' : 'typescript',
        mode: 'edit'
      })
    },
    { wId: worktreeId, relPath: relativePath, activate: opts.activate === true }
  )
}

async function clickSidebarWorkspace(page: Page, worktreeId: string): Promise<void> {
  await worktreeRowSurface(page, worktreeId).click()
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    worktreeId
  )
}

async function clickTab(page: Page, name: string): Promise<void> {
  await page.locator('[data-tab-id]:visible').filter({ hasText: name }).click()
}

// Why: each call is its own task, like a click in a pane, which calls focusGroup on focus.
async function focusPane(page: Page, worktreeId: string, groupId: string): Promise<void> {
  await page.evaluate(({ wId, gId }) => window.__store!.getState().focusGroup(wId, gId), {
    wId: worktreeId,
    gId: groupId
  })
}

test.describe('Ctrl+Tab switcher across workspaces', () => {
  test('Ctrl+A flips the scope mid-gesture and the scope sticks', async ({
    orcaPage
  }, testInfo) => {
    const page = orcaPage
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await page.evaluate(async () => {
      // Why: the assertions read English strings; the host may run another system locale.
      await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    })
    const { primaryId, secondaryId } = await getWorktreeIdsByBranch(page)
    const activeTab = page.locator('[data-tab-id][data-active="true"]:visible')
    const steps: (SwitcherSnapshot & { step: string })[] = []

    // Focus history: package.json in the primary workspace, then index.ts and
    // diff-note-layout.ts in e2e-secondary. diff-note-layout.ts stays on screen.
    await switchToWorktree(page, primaryId)
    await openSeededFile(page, primaryId, 'package.json')
    await expect(activeTab).toContainText('package.json')
    await openSeededFile(page, secondaryId, 'src/index.ts', { activate: true })
    await expect(activeTab).toContainText('index.ts')
    await openSeededFile(page, secondaryId, 'src/diff-note-layout.ts')
    await expect(activeTab).toContainText('diff-note-layout.ts')

    // A fresh profile opens on this workspace only.
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const workspaceScope = await readSwitcher(page)
    steps.push({ step: 'ctrl-tab', ...workspaceScope })
    expect(workspaceScope.title).toBe('Switch Tab · This workspace')
    expect(rowIndex(workspaceScope, 'index.ts')).toBeGreaterThanOrEqual(0)
    expect(rowIndex(workspaceScope, 'package.json')).toBe(-1)
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-this-workspace.png') })

    // Ctrl+A with Control still held lists every workspace by last focus.
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('All workspaces')
    const allScope = await readSwitcher(page)
    steps.push({ step: 'ctrl-a', ...allScope })
    expect(allScope.title).toBe('Switch Tab · All workspaces')
    // Only the row count can change the box: its top edge, left edge and width stay.
    expect({ x: allScope.box.x, y: allScope.box.y, width: allScope.box.width }).toEqual({
      x: workspaceScope.box.x,
      y: workspaceScope.box.y,
      width: workspaceScope.box.width
    })
    expect(rowIndex(allScope, 'diff-note-layout.ts')).toBe(0)
    expect(rowIndex(allScope, 'index.ts')).toBe(1)
    expect(allScope.rows[1].selected).toBe(true)
    expect(allScope.rows[1].text).toContain('e2e-secondary')
    const packageRow = rowIndex(allScope, 'package.json')
    expect(packageRow).toBeGreaterThan(1)
    expect(allScope.rows[packageRow].text).not.toContain('e2e-secondary')
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-all-workspaces.png') })

    // Tab down to the primary workspace's file and release Control.
    for (let index = 1; index < packageRow; index++) {
      await page.keyboard.press('Tab')
    }
    const beforeRelease = await readSwitcher(page)
    steps.push({ step: 'tab-to-package-json', ...beforeRelease })
    expect(beforeRelease.rows[packageRow].selected).toBe(true)
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)
    await expect(activeTab).toContainText('package.json')

    // The scope sticks: the next Ctrl+Tab lists every workspace and selects the tab just left.
    const sticky = await peekSwitcher(page)
    steps.push({ step: 'sticky-ctrl-tab', ...sticky })
    expect(sticky.title).toBe('Switch Tab · All workspaces')
    expect(rowNames(sticky).slice(0, 2)).toEqual(['package.json', 'diff-note-layout.ts'])
    expect(sticky.rows[1].selected).toBe(true)
    await expect(activeTab).toContainText('package.json')

    // A workspace that a sidebar click shows counts as a visit, like a tab click.
    await page.evaluate(
      (ids) => {
        const state = window.__store!.getState()
        state.setSidebarOpen(true)
        for (const id of ids) {
          state.revealWorktreeInSidebar(id)
        }
      },
      [primaryId, secondaryId]
    )
    await clickTab(page, 'Terminal 1')
    await expect(activeTab).toContainText('Terminal 1')
    await clickSidebarWorkspace(page, secondaryId)
    await expect(activeTab).toContainText('diff-note-layout.ts')
    await clickSidebarWorkspace(page, primaryId)
    await expect(activeTab).toContainText('Terminal 1')
    const sidebarVisits = await peekSwitcher(page)
    steps.push({ step: 'sidebar-visits', ...sidebarVisits })
    expect
      .soft(rowNames(sidebarVisits))
      .toEqual(['Terminal 1', 'diff-note-layout.ts', 'package.json', 'index.ts'])

    // A pane that takes focus counts as a visit: package.json moves to its own
    // pane, index.ts gets a tab click, and then each pane takes focus in turn.
    const panes = await page.evaluate((wId) => {
      const state = window.__store!.getState()
      const editorTab = (state.unifiedTabsByWorktree[wId] ?? []).find(
        (tab) => tab.contentType === 'editor'
      )
      const terminalGroupId = editorTab?.groupId
      const editorGroupId = terminalGroupId
        ? state.createEmptySplitGroup(wId, terminalGroupId, 'right')
        : null
      if (!editorTab || !terminalGroupId || !editorGroupId) {
        throw new Error('the primary workspace did not split')
      }
      state.moveUnifiedTabToGroup(editorTab.id, editorGroupId)
      return { terminalGroupId, editorGroupId }
    }, primaryId)
    await focusPane(page, primaryId, panes.terminalGroupId)
    await clickSidebarWorkspace(page, secondaryId)
    await clickTab(page, 'index.ts')
    await expect(activeTab).toContainText('index.ts')
    await clickSidebarWorkspace(page, primaryId)
    await focusPane(page, primaryId, panes.editorGroupId)
    await focusPane(page, primaryId, panes.terminalGroupId)
    const paneVisits = await peekSwitcher(page)
    steps.push({ step: 'pane-focus-visits', ...paneVisits })
    expect
      .soft(rowNames(paneVisits))
      .toEqual(['Terminal 1', 'package.json', 'index.ts', 'diff-note-layout.ts'])

    // An agent chat is a row too: the chat just left comes second and opens in its workspace.
    await clickSidebarWorkspace(page, secondaryId)
    await page.evaluate((wId) => {
      const state = window.__store!.getState()
      state.createUnifiedTab(wId, 'agent-session', {
        id: 'structured-agent-session-e2e-switcher-chat',
        entityId: 'e2e-switcher-chat',
        executionHostId: 'local',
        agentSessionAgent: 'claude',
        label: 'Switcher chat',
        activate: true
      })
      state.setActiveTabType('agent-session', wId)
    }, secondaryId)
    await expect(activeTab).toContainText('Switcher chat')
    // Why: no activeTab check here; the split primary workspace shows two active tabs.
    await clickSidebarWorkspace(page, primaryId)
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const chatRows = await readSwitcher(page)
    steps.push({ step: 'agent-chat-row', ...chatRows })
    expect(rowNames(chatRows).slice(0, 2)).toEqual(['Terminal 1', 'Switcher chat'])
    expect(chatRows.rows[1].selected).toBe(true)
    expect(chatRows.rows[1].text).toContain('e2e-secondary')
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)
    await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
      'data-rendered-active-worktree-id',
      secondaryId
    )
    await expect(activeTab).toContainText('Switcher chat')

    // A browser page row opens its page in its own workspace.
    const browserTabId = await page.evaluate((wId) => {
      const state = window.__store!.getState()
      // Why: about:blank would name the row "New Tab"; this page keeps its title until it loads.
      const tab = state.createBrowserTab(wId, 'data:text/html,<title>Switcher page</title>', {
        title: 'Switcher page',
        activate: false
      })
      return tab.id
    }, primaryId)
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    const pageRows = await readSwitcher(page)
    steps.push({ step: 'browser-page-row', ...pageRows })
    const pageRow = rowIndex(pageRows, 'Switcher page')
    expect(pageRow).toBeGreaterThan(1)
    expect(pageRows.rows[pageRow].text).not.toContain('e2e-secondary')
    for (let index = 1; index < pageRow; index++) {
      await page.keyboard.press('Tab')
    }
    await expect(switcher(page).getByRole('option').nth(pageRow)).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await page.keyboard.up('Control')
    await expect(switcher(page)).toHaveCount(0)
    await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
      'data-rendered-active-worktree-id',
      primaryId
    )
    // Why: by id, because the loaded page renames its tab to "New Tab".
    await expect(page.locator(`[data-tab-id="${browserTabId}"][data-active="true"]`)).toBeVisible()

    // Settings shows the scope that the switcher stored.
    await page.evaluate(() => window.__store!.getState().openSettingsPage())
    await page.getByPlaceholder('Search settings').fill('tab scope')
    const scopeSelect = page.getByRole('combobox', { name: 'Tab Scope' })
    await expect(scopeSelect).toHaveText('All workspaces')

    // Outside a workspace view This workspace has no list, so the switcher says why.
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await expect(switcher(page)).toContainText('Switch Tab · All workspaces')
    await page.keyboard.press('a')
    await expect(switcher(page)).toContainText('Go to a workspace to see its tabs')
    const outsideWorkspace = await readSwitcher(page)
    steps.push({ step: 'outside-workspace', ...outsideWorkspace })
    expect(outsideWorkspace.title).toBe('Switch Tab · This workspace')
    expect(outsideWorkspace.rows).toEqual([])
    await switcher(page).screenshot({ path: testInfo.outputPath('switcher-outside-workspace.png') })
    await page.keyboard.press('Escape')
    await expect(switcher(page)).toHaveCount(0)
    await page.keyboard.up('Control')
    // The toggle saves the scope even where it has no list to show.
    await expect(scopeSelect).toHaveText('This workspace')

    const reportPath = testInfo.outputPath('recent-tab-switcher-all-workspaces.json')
    writeFileSync(reportPath, `${JSON.stringify({ steps }, null, 2)}\n`)
    await testInfo.attach('switcher-states', { path: reportPath, contentType: 'application/json' })
  })
})
