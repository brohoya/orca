import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import type { TypeCyclableTab } from '../terminal/tab-type-cycle'

const EDITOR_INPUT_SELECTOR =
  '.monaco-editor textarea, .monaco-editor .native-edit-context, [contenteditable="true"]'

/**
 * Moves the keyboard into a tab that the switcher opened in another pane. Activation only marks
 * that pane as focused, and an editor there is already mounted, so it does not take the focus.
 */
export function focusTabInOtherPane(
  worktreeId: string,
  tab: TypeCyclableTab,
  paneBefore: string | undefined
): void {
  const pane = useAppStore.getState().activeGroupIdByWorktree[worktreeId]
  if (!pane || pane === paneBefore) {
    return
  }
  if (tab.type === 'terminal') {
    focusTerminalTabSurface(tab.id)
    return
  }
  if (tab.type === 'agent-session') {
    if (tab.tabId) {
      requestNativeChatComposerFocus(tab.tabId)
    }
    return
  }
  if (tab.type === 'browser') {
    const pageId = useAppStore
      .getState()
      .browserTabsByWorktree[worktreeId]?.find(
        (browserTab) => browserTab.id === tab.id
      )?.activePageId
    if (pageId) {
      requestBrowserFocus({ pageId, target: 'webview' })
    }
    return
  }
  requestAnimationFrame(() => {
    const input = document
      .querySelector(`[data-tab-group-body-id="${CSS.escape(pane)}"]`)
      ?.querySelector(EDITOR_INPUT_SELECTOR)
    if (input instanceof HTMLElement) {
      input.focus()
    }
  })
}
