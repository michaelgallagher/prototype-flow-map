# iOS speed — XCUITest optimisation plan

> **Status: SUPERSEDED (2026-04-28).** Phases 2 and 3 were never implemented. The Phase 1 instrumentation (timer + last-run cache) was delivered, but the measurement revealed that the XCUITest overhead itself (not the build) was responsible for ~13m of the 13m 30s run — meaning parallelising the build would have saved at most ~13 seconds, not the 6-8 minutes the plan originally estimated. The architectural alternative — injecting a launch-args route handler and capturing via `simctl io` directly — was pursued as an experiment and shipped instead. See [`ios-screenshots-fast-path.md`](ios-screenshots-fast-path.md) for the replacement approach.
>
> Phase 1 deliverables (`src/phase-timer.js`, `src/last-run-cache.js`, timing wiring in `src/index.js`, "Last run" banner in `bin/cli.js`) remain in the codebase and are still active.

## Original plan summary

Phase 1 (delivered): instrument the pipeline with per-phase timing. Revealed that `xcodebuild test` was the entire runtime bottleneck — the build itself was only ~13s of a 13m 30s run.

Phase 2 (superseded): parallelise `xcodebuild build-for-testing` with graph analysis. Expected saving: ~13s (not the 6-8min originally estimated). Not worth implementing.

Phase 3 (superseded): cache derived data by source hash. Would save the same ~13s on warm runs. Not worth implementing.

The decision to pursue the architectural alternative instead is documented in [`design-decisions.md`](../design-decisions.md).
