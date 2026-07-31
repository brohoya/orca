import { execFile, execFileSync } from 'node:child_process'

type WslAvailabilityCache =
  | { available: true }
  /** Not Windows — never re-probed. */
  | { available: false; unsupported: true }
  | { available: false; cachedAt: number; retryable: boolean; failures: number }

let wslAvailableCache: WslAvailabilityCache | null = null
let wslAvailabilityProbeInFlight: Promise<boolean> | null = null
// Why: probes overlap (the sync twin cannot await the async one's spawn) and resolve out of
// order, so every write carries the generation it was started against. See `writeWslAvailability`.
let wslAvailabilityCacheGeneration = 0

const WSL_AVAILABILITY_PROBE_TIMEOUT_MS = 5000
// Why: availability is a separate, blocking probe. Deliberately not a multiple of the
// renderer's 30s capability TTL, so repeated refreshes don't land on this boundary and
// re-probe every cycle.
const WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS = 45_000
// Why: even a definitive-looking non-zero exit can be transient — wsl.exe reports one
// while the WSL package is servicing or LxssManager is still starting — so nothing
// latches for the whole session; it just waits much longer before paying the probe again.
const WSL_AVAILABILITY_DEFINITIVE_TTL_MS = 10 * 60_000
const WSL_AVAILABILITY_MAX_RETRY_DELAY_MS = 30 * 60_000

function isPermanentWslAvailabilityCache(cache: WslAvailabilityCache): boolean {
  // Why: re-check the platform so a cache seeded off-Windows can't suppress a real probe.
  return cache.available || ('unsupported' in cache && process.platform !== 'win32')
}

// Why: the probe spawns wsl.exe, so a host with a wedged wsl.exe must not pay it every
// window; back off per consecutive failure.
function wslAvailabilityRetryDelayMs(cache: { retryable: boolean; failures: number }): number {
  const base = cache.retryable
    ? WSL_AVAILABILITY_NEGATIVE_CACHE_TTL_MS
    : WSL_AVAILABILITY_DEFINITIVE_TTL_MS
  return Math.min(base * 2 ** (cache.failures - 1), WSL_AVAILABILITY_MAX_RETRY_DELAY_MS)
}

// Why: a numeric `status` (wsl.exe ran and said no) or ENOENT (not installed) is
// answer-shaped, so it earns a long window rather than the short one a timeout gets.
// Same numeric-status rule as `wslUncDirectoryExists`; neither latches forever.
function isRetryableWslProbeFailure(error: unknown): boolean {
  const failure = error as { status?: unknown; code?: unknown } | null
  if (typeof failure?.status === 'number') {
    return false
  }
  return failure?.code !== 'ENOENT'
}

function isWslAvailabilityCacheFresh(cache: WslAvailabilityCache): boolean {
  if (isPermanentWslAvailabilityCache(cache)) {
    return true
  }
  if (!('cachedAt' in cache)) {
    return false
  }
  return Date.now() - cache.cachedAt < wslAvailabilityRetryDelayMs(cache)
}

function reusableWslAvailability(): boolean | null {
  return wslAvailableCache && isWslAvailabilityCacheFresh(wslAvailableCache)
    ? wslAvailableCache.available
    : null
}

function previousWslAvailabilityFailures(): number {
  return wslAvailableCache && 'failures' in wslAvailableCache ? wslAvailableCache.failures : 0
}

/** Every cache mutation goes through here, so a generation can never drift from the value it stamps. */
function writeWslAvailability(next: WslAvailabilityCache | null): void {
  wslAvailableCache = next
  wslAvailabilityCacheGeneration += 1
}

function cacheWslAvailabilityProbeResult(error: unknown, probeGeneration: number): boolean {
  if (!error) {
    // A success proves wsl.exe ran, so it stands whatever else landed meanwhile — the same
    // rule `dropStaleWslAvailabilityFailure` applies to a successful distro list.
    writeWslAvailability({ available: true })
    return true
  }
  // Why: the cache moved while this spawn was in flight — a fresher probe answered, or a
  // distro list invalidated the failure. This failure must not clobber that newer state or
  // restore what was just dropped; the caller still gets the answer this probe observed.
  if (probeGeneration !== wslAvailabilityCacheGeneration) {
    return wslAvailableCache?.available ?? false
  }
  writeWslAvailability({
    available: false,
    cachedAt: Date.now(),
    retryable: isRetryableWslProbeFailure(error),
    failures: previousWslAvailabilityFailures() + 1
  })
  return false
}

function probeWslStatus(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['--status'],
      { timeout: WSL_AVAILABILITY_PROBE_TIMEOUT_MS },
      (error: unknown) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      }
    )
  })
}

/**
 * Check whether wsl.exe is available and functional on this Windows machine.
 * Success caches for the process lifetime; every failure is re-probed eventually, so
 * a slow wsl.exe activation on a just-installed or just-rebooted machine cannot latch
 * WSL off for the whole session.
 */
export function isWslAvailable(): boolean {
  const cached = reusableWslAvailability()
  if (cached !== null) {
    return cached
  }

  if (process.platform !== 'win32') {
    writeWslAvailability({ available: false, unsupported: true })
    return false
  }

  // Why: an async probe may already be in flight — this one blocks the thread, so it cannot
  // join it, but it can stamp its generation and let whichever lands second stand down.
  const probeGeneration = wslAvailabilityCacheGeneration
  try {
    execFileSync('wsl.exe', ['--status'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: WSL_AVAILABILITY_PROBE_TIMEOUT_MS
    })
    return cacheWslAvailabilityProbeResult(null, probeGeneration)
  } catch (error) {
    return cacheWslAvailabilityProbeResult(error, probeGeneration)
  }
}

/**
 * Async twin of `isWslAvailable`, sharing its cache and backoff.
 *
 * Why: the renderer's capability read reaches this over IPC, and the sync probe blocks the
 * Electron main thread — every PTY message, window IPC and watchdog beat — for up to 5s on a
 * wedged wsl.exe. Concurrent callers share one spawn.
 */
export function isWslAvailableAsync(): Promise<boolean> {
  const cached = reusableWslAvailability()
  if (cached !== null) {
    return Promise.resolve(cached)
  }

  if (process.platform !== 'win32') {
    writeWslAvailability({ available: false, unsupported: true })
    return Promise.resolve(false)
  }

  if (wslAvailabilityProbeInFlight) {
    return wslAvailabilityProbeInFlight
  }

  const probeGeneration = wslAvailabilityCacheGeneration
  wslAvailabilityProbeInFlight = probeWslStatus()
    .then(() => cacheWslAvailabilityProbeResult(null, probeGeneration))
    .catch((error: unknown) => cacheWslAvailabilityProbeResult(error, probeGeneration))
    .finally(() => {
      wslAvailabilityProbeInFlight = null
    })
  return wslAvailabilityProbeInFlight
}

export function hasCachedWslAvailability(): boolean {
  return wslAvailableCache !== null
}

// Why: same contract as the distro getter — report the last observed answer. Going
// null on staleness would drop the `wsl-unavailable` repair prompt and let git and
// PTY silently resolve to a WSL that last failed to respond. `isWslAvailable` is what
// clears it, by re-probing once the retry window lapses.
export function getCachedWslAvailability(): boolean | null {
  return wslAvailableCache?.available ?? null
}

// Why: the two caches expire independently, and `getWslRepairReason` checks availability
// first — so a definitive failure held for 10-30min would report `wsl-unavailable` over a
// WSL that just listed a distro for us. A non-empty list proves wsl.exe ran, so drop the
// stale failure and let the next call re-probe. Non-empty lists are cached for the process
// lifetime, so this cannot re-spawn the blocking probe more than once.
export function dropStaleWslAvailabilityFailure(): void {
  if (wslAvailableCache && !wslAvailableCache.available && !('unsupported' in wslAvailableCache)) {
    writeWslAvailability(null)
    return
  }
  // A probe running right now would land its failure after this proof, so retire its
  // generation as well; nothing is cached, so the next caller simply re-probes.
  wslAvailabilityCacheGeneration += 1
}

export function _resetWslAvailabilityCacheForTests(): void {
  writeWslAvailability(null)
  wslAvailabilityProbeInFlight = null
}

export function _setWslAvailabilityCacheForTests(
  available: boolean | null | undefined,
  retryable: boolean
): void {
  writeWslAvailability(
    available === true
      ? { available: true }
      : available === false
        ? { available: false, cachedAt: Date.now(), retryable, failures: 1 }
        : null
  )
}
