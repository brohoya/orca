import React, { useId } from 'react'
import type { CtrlTabScope } from '../../../../shared/tab-types'
import { normalizeCtrlTabScope } from '../tab-bar/recent-tab-switching'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

export function RecentTabScopeControl({
  ctrlTabScope,
  keywords,
  updateSettings
}: {
  ctrlTabScope: CtrlTabScope
  keywords?: string[]
  updateSettings: (updates: { ctrlTabScope?: CtrlTabScope }) => Promise<void> | void
}): React.JSX.Element {
  const labelId = useId()
  return (
    <SearchableSetting
      title={translate('auto.components.settings.RecentTabScopeControl.title', 'Tab Scope')}
      description={translate(
        'auto.components.settings.RecentTabScopeControl.description',
        'This workspace or all workspaces. The switcher can also change it.'
      )}
      keywords={keywords}
      className="max-w-none"
    >
      <SettingsRow
        label={translate('auto.components.settings.RecentTabScopeControl.title', 'Tab Scope')}
        labelId={labelId}
        control={
          <Select
            value={ctrlTabScope}
            onValueChange={(value) =>
              void updateSettings({ ctrlTabScope: normalizeCtrlTabScope(value) })
            }
          >
            {/* Why: a minimum width, not a fixed one, so a long translation is not cut. */}
            <SelectTrigger className="min-w-[180px]" aria-labelledby={labelId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="workspace">
                {translate(
                  'auto.components.settings.RecentTabScopeControl.workspace',
                  'This workspace'
                )}
              </SelectItem>
              <SelectItem value="all">
                {translate('auto.components.settings.RecentTabScopeControl.all', 'All workspaces')}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
