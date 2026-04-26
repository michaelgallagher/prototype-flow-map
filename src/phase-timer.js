/**
 * Per-phase timing for pipeline runs.
 *
 * Used to instrument generate / generateNative / generateScenario in
 * src/index.js, plus sub-phases inside long-running steps (xcodebuild test,
 * web jumpoff crawl, etc.) where we want a finer breakdown.
 *
 * The summary printed at the end of a run informs optimisation work — most
 * notably the iOS speed workstream, where the goal is to cut the ~12-minute
 * iOS run down toward Android's ~2 minutes. See
 * `docs/plans/roadmap.md` (iOS speed workstream).
 *
 * Usage:
 *
 *   const timer = createTimer();
 *
 *   timer.start("Parse");
 *   // ... do parse work ...
 *   timer.stop();
 *
 *   timer.start("Screenshots");
 *   // ... do screenshot work ...
 *   timer.stop();
 *
 *   console.log(timer.summary());
 *   //   Parse:        12s
 *   //   Screenshots:  5m 20s
 *   //   Total:        5m 32s
 *
 *   timer.totalMs();           // → number, includes time outside any phase
 *   timer.durations();         // → [{ name, dt }, ...]
 *
 * Calling start() while another phase is active stops the previous one
 * automatically — so the common pattern of "start at the top of each step"
 * doesn't require explicit stop() calls between steps. A final stop() before
 * summary() is still recommended so the active phase is included.
 */
function createTimer() {
  const phases = [];
  let active = null;
  const startedAt = Date.now();

  return {
    start(name) {
      if (active) this.stop();
      active = { name, t0: Date.now() };
    },
    stop() {
      if (active) {
        active.dt = Date.now() - active.t0;
        phases.push(active);
        active = null;
      }
    },
    summary() {
      // Stop any active phase so it's included in the summary
      if (active) this.stop();
      const total = Date.now() - startedAt;
      // Width = longest phase name + 1 (for the colon), min 12
      const nameWidth = Math.max(
        12,
        ...phases.map((p) => p.name.length + 1),
        "Total".length + 1,
      );
      const lines = phases.map(
        (p) => `   ${(p.name + ":").padEnd(nameWidth)} ${formatMs(p.dt)}`,
      );
      lines.push(`   ${"Total:".padEnd(nameWidth)} ${formatMs(total)}`);
      return lines.join("\n");
    },
    durations() {
      return phases.slice();
    },
    totalMs() {
      return Date.now() - startedAt;
    },
  };
}

/**
 * Format a duration in milliseconds for display.
 * <1s   → "ms"
 * <60s  → "X.Xs"
 * <60m  → "Xm Ys"
 * else  → "Xh Ym"
 */
function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const totalS = ms / 1000;
  if (totalS < 60) return `${totalS.toFixed(1)}s`;
  const totalM = totalS / 60;
  if (totalM < 60) {
    const m = Math.floor(totalM);
    const s = Math.round(totalS - m * 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(totalM / 60);
  const m = Math.round(totalM - h * 60);
  return `${h}h ${m}m`;
}

module.exports = { createTimer, formatMs };
