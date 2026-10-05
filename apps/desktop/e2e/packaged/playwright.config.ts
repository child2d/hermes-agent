import '../run-tmp'
import '../fix-electron-tracing'

import { defineConfig } from '@playwright/test'

/**
 * The PACKAGED-ARTIFACT enterprise lane: a small lane that exercises the REAL
 * `Plankton.app` (a full `npm run pack:plankton` artifact), NOT the dev harness.
 *
 * WHY A SEPARATE CONFIG (batch-2 third review, P6-1/P6-2)
 * -------------------------------------------------------
 * The enterprise tool-catalog spec used to live in the dev suite (`e2e/`) and
 * gated itself on HERMES_DESKTOP_VARIANT=plankton — a var NO CI lane sets (so
 * it was permanently skipped) and one the spec passed straight through to the
 * app, making its `enterpriseEnabled` assertion a tautology in a dev bundle
 * (PRODUCT_IDENTITY is derived live from env there). On top of that the dev
 * harness cannot even boot the enterprise variant: the gate pins launcher
 * discovery to `<HERMES_HOME>/bin`, which a dev checkout does not have.
 *
 * So the enterprise e2e is a PACKAGED-ARTIFACT lane:
 *   - excluded from the dev default set (../../playwright.config.ts ignores
 *     `packaged/**`);
 *   - run explicitly against the artifact the pack produces.
 *
 * Entry command (from apps/desktop):
 *   npm run pack:plankton        # build release/mac-arm64/Plankton.app
 *   npm run test:e2e:packaged    # this lane
 *
 * One worker (a real app owns a window + a backend); 180 s per test (a cold
 * first launch seeds the enterprise home + starts the bundled engine).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report/packaged' }]],
  outputDir: '../../test-results/packaged',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
})
