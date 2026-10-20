import { keybindingMatchesInput } from './keybindings'
import type { WindowShortcutInput } from './window-shortcut-policy'

// Why: Control stays held for the whole switcher gesture, so the scope toggle shares it rather than taking a new chord.
export function isRecentTabSwitcherScopeToggle(
  input: WindowShortcutInput,
  platform: NodeJS.Platform
): boolean {
  return (
    keybindingMatchesInput('Ctrl+A', input, platform) ||
    keybindingMatchesInput('Ctrl+Shift+A', input, platform)
  )
}
