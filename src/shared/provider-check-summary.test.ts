import { describe, expect, it } from 'vitest'
import { derivePipelineStatus } from '../main/gitlab/mappers'
import { deriveTaskPagePRCheckSummary } from '../renderer/src/components/task-page-pr-check-summary'
import { gitLabPipelineJobsToPRChecks } from './gitlab-pipeline-checks'
import { derivePRCheckStatus, derivePRCheckStatusFromRollup } from './pr-check-status'
import { summarizeProviderChecks } from './provider-check-summary'
import type { GitLabPipelineJob } from './gitlab-types'
import type { PRCheckDetail, ProviderCheckSummary } from './types'

function completed(conclusion: string): PRCheckDetail {
  return {
    name: conclusion,
    status: 'completed',
    conclusion: conclusion as PRCheckDetail['conclusion'],
    url: null
  }
}

function gitLabJobs(...statuses: string[]): PRCheckDetail[] {
  return gitLabPipelineJobsToPRChecks(
    statuses.map(
      (status, index): GitLabPipelineJob => ({
        id: index,
        name: status,
        stage: 'deploy',
        status,
        webUrl: '',
        duration: null
      })
    )
  )
}

// Why: GraphQL rollups arrive upper-cased and status-first; the main process must land on the
// same verdict as the renderer for the same checks.
function toGraphQLRollup(check: PRCheckDetail): { status: string; conclusion: string | null } {
  return {
    status: check.status.toUpperCase(),
    conclusion: check.conclusion ? check.conclusion.toUpperCase() : null
  }
}

type ParityCase = {
  name: string
  checks: PRCheckDetail[]
  /** Raw GitLab job statuses behind `checks`, so the main-process array rollup that feeds the
   *  worktree card is pinned to the same verdict as the job-derived surfaces. */
  gitLabJobStatuses?: string[]
  expected: Omit<ProviderCheckSummary, 'total'>
}

const PARITY_CASES: ParityCase[] = [
  {
    name: 'all success',
    checks: [completed('success'), completed('success')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus skipped',
    checks: [completed('success'), completed('skipped')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'all skipped',
    checks: [completed('skipped'), completed('skipped')],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus neutral',
    checks: [completed('success'), completed('neutral')],
    expected: { state: 'success', passed: 1, failed: 0, pending: 0, neutral: 1 }
  },
  {
    name: 'all neutral',
    checks: [completed('neutral')],
    expected: { state: 'neutral', passed: 0, failed: 0, pending: 0, neutral: 1 }
  },
  {
    name: 'success plus failure',
    checks: [completed('success'), completed('failure')],
    expected: { state: 'failure', passed: 1, failed: 1, pending: 0, neutral: 0 }
  },
  {
    name: 'success plus running',
    checks: [
      completed('success'),
      { name: 'ci', status: 'in_progress', conclusion: null, url: null }
    ],
    expected: { state: 'pending', passed: 1, failed: 0, pending: 1, neutral: 0 }
  },
  {
    name: 'GitLab manual gate only',
    checks: gitLabJobs('manual'),
    gitLabJobStatuses: ['manual'],
    expected: { state: 'neutral', passed: 0, failed: 0, pending: 0, neutral: 1 }
  },
  {
    name: 'GitLab manual gate alongside a green pipeline',
    checks: gitLabJobs('manual', 'success'),
    gitLabJobStatuses: ['manual', 'success'],
    expected: { state: 'success', passed: 1, failed: 0, pending: 0, neutral: 1 }
  },
  {
    name: 'GitLab manual gate alongside a failing job',
    checks: gitLabJobs('manual', 'failed'),
    gitLabJobStatuses: ['manual', 'failed'],
    expected: { state: 'failure', passed: 0, failed: 1, pending: 0, neutral: 1 }
  },
  {
    name: 'GitLab manual gate alongside a running job',
    checks: gitLabJobs('manual', 'running'),
    gitLabJobStatuses: ['manual', 'running'],
    expected: { state: 'pending', passed: 0, failed: 0, pending: 1, neutral: 1 }
  },
  {
    name: 'GitLab skipped-only pipeline',
    checks: gitLabJobs('skipped', 'skipped'),
    gitLabJobStatuses: ['skipped', 'skipped'],
    expected: { state: 'success', passed: 2, failed: 0, pending: 0, neutral: 0 }
  },
  {
    name: 'genuine action_required',
    checks: [completed('success'), completed('action_required')],
    expected: { state: 'failure', passed: 1, failed: 1, pending: 0, neutral: 0 }
  }
]

describe('provider check classification parity', () => {
  it.each(PARITY_CASES)(
    '$name resolves identically on every desktop surface',
    ({ checks, expected, gitLabJobStatuses }) => {
      const summary = { ...expected, total: checks.length }
      expect(summarizeProviderChecks(checks)).toEqual(summary)
      expect(deriveTaskPagePRCheckSummary(checks)).toEqual(summary)
      expect(derivePRCheckStatus(checks)).toBe(expected.state)
      expect(derivePRCheckStatusFromRollup(checks.map(toGraphQLRollup))).toBe(expected.state)
      if (gitLabJobStatuses) {
        expect(derivePipelineStatus(gitLabJobStatuses.map((status) => ({ status })))).toBe(
          expected.state
        )
      }
    }
  )
})
