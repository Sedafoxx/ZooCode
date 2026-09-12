import { defineConfig } from 'vitest/config'

/**
 * Shared vitest configuration.
 *
 * `fileParallelism: false` is deliberate, not a workaround for a slow machine.
 *
 * The suite has two kinds of heavy, non-hermetic-to-CPU tests:
 *   - `tests/cli.test.ts` spawns `npx tsx bin/zoocode.ts …` as child processes
 *     (one probe plus one per assertion). Each cold `npx tsx` boot costs ~2-3s
 *     of CPU on Windows.
 *   - `tests/git.test.ts`, `tests/doctor.test.ts` and `tests/tools.test.ts` fork
 *     real `git` / `node` subprocesses.
 *
 * When every test file runs in its own worker in parallel, those child launches
 * contend for CPU and disk, and a spawn that normally takes ~2s can exceed the
 * per-spawn timeout in `tests/cli.test.ts` — the process is then killed and the
 * assertion sees `status === -1` instead of the real exit code. That is a flaky
 * red, not a real defect in the CLI.
 *
 * Serializing test *files* (still running the tests inside each file normally,
 * and the whole run in well under a minute) removes the contention and makes the
 * suite deterministic. Per-test timeouts in the suites themselves are unchanged.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
