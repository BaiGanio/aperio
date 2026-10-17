// lib/helpers/metricsSampler.js
// Process + host metrics sampled on an owned, stoppable timer.
//
// Lifecycle is explicit on purpose: route mounting used to create an anonymous
// setInterval that captured the store and lived until process exit, so a second
// mount (tests, re-created app) left the earlier sampler running. Sampling is
// also single-flight — the next tick is scheduled only after the previous
// sample settles, so a slow store.counts() or vm_stat can never overlap.

import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { getEmbeddingBacklogSize } from "./embedding-backlog.js";

const execAsync = promisify(exec);

const EMPTY_METRICS = { rss: 0, heap: 0, cpu: 0, embedding_queue_size: 0 };

/**
 * @param {object} opts
 * @param {object} [opts.store]        store exposing counts(); optional
 * @param {number} [opts.intervalMs]   delay between samples (default 2000)
 * @param {Function} [opts.execImpl]   promisified exec, injectable for tests
 */
export function createMetricsSampler({ store, intervalMs = 2000, execImpl = execAsync } = {}) {
  let metrics = { ...EMPTY_METRICS };
  let timer = null;
  let running = false;
  let inFlight = null;
  let prevCpu = process.cpuUsage();
  let prevCpuTime = Date.now();
  // Apple Silicon exposes performance/efficiency core counts via sysctl (static,
  // fetched once). Elsewhere the split stays null and the UI shows plain cores.
  let coreDetail = { perf: null, eff: null };

  async function detectCoreDetail() {
    if (os.platform() !== "darwin") return;
    try {
      const { stdout } = await execImpl("sysctl -n hw.perflevel0.logicalcpu hw.perflevel1.logicalcpu");
      const [perf, eff] = String(stdout).trim().split(/\s+/).map(Number);
      if (perf > 0 && eff > 0) coreDetail = { perf, eff };
    } catch { /* not Apple Silicon, or sysctl unavailable */ }
  }

  // macOS: os.freemem() counts file cache as used, overstating usage (~99% on a
  // healthy Mac). Use Activity Monitor's formula instead: (anonymous − purgeable)
  // + wired + compressor, from vm_stat.
  async function systemUsedMemMB() {
    if (os.platform() === "darwin") {
      try {
        const { stdout } = await execImpl("/usr/bin/vm_stat");
        const page = Number((stdout.match(/page size of (\d+)/) || [])[1]) || 16384;
        const pages = name => Number((stdout.match(new RegExp(name + ":\\s+(\\d+)")) || [])[1]) || 0;
        const used = (pages("Anonymous pages") - pages("Pages purgeable")
                      + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
        if (used > 0) return Math.round(used / 1024 / 1024);
      } catch { /* fall through to the portable estimate */ }
    }
    return Math.round((os.totalmem() - os.freemem()) / 1024 / 1024);
  }

  async function collect() {
    const mem = process.memoryUsage();
    const now = Date.now();
    const cur = process.cpuUsage(prevCpu);
    const elapsed = (now - prevCpuTime) * 1000;
    let embedding_queue_size = 0;
    let memories_total = 0;
    try {
      const { total, embedded } = await store.counts();
      memories_total = total;
      // The tracker includes active memory/wiki and graph queues. `counts()` is
      // retained as a fallback for stores initialized without those workers.
      embedding_queue_size = Math.max(total - embedded, getEmbeddingBacklogSize());
    } catch { /* store not ready, or counts unsupported */ }
    const load = os.loadavg();
    const systemUsedMem = await systemUsedMemMB();
    metrics = {
      rss:  Math.round(mem.rss / 1024 / 1024),
      heap: Math.round(mem.heapUsed / 1024 / 1024),
      cpu:  elapsed > 0 ? Math.round((cur.user + cur.system) / elapsed * 100) : 0,
      embedding_queue_size,
      memories_total,
      // System-level metrics
      cores:          os.cpus().length,
      perfCores:      coreDetail.perf,
      effCores:       coreDetail.eff,
      loadAvg1:       Math.round(load[0] * 100) / 100,
      loadAvg5:       Math.round(load[1] * 100) / 100,
      loadAvg15:      Math.round(load[2] * 100) / 100,
      systemTotalMem: Math.round(os.totalmem() / 1024 / 1024),
      systemFreeMem:  Math.round(os.freemem() / 1024 / 1024),
      systemUsedMem,
      uptime:         Math.round(os.uptime()),
      platform:       os.platform(),
      arch:           os.arch(),
      nodeVersion:    process.version,
    };
    prevCpu = process.cpuUsage();
    prevCpuTime = now;
    return metrics;
  }

  /** Sample once, coalescing concurrent callers onto the in-flight sample. */
  function sample() {
    if (inFlight) return inFlight;
    inFlight = collect().finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule() {
    timer = setTimeout(async () => {
      timer = null;
      if (!running) return;
      try { await sample(); } catch { /* never let a sample kill the loop */ }
      if (running) schedule();
    }, intervalMs);
    timer.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      void detectCoreDetail();
      schedule();
    },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    getMetrics() { return metrics; },
    sample,
    get isRunning() { return running; },
  };
}
