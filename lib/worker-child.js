'use strict';

// The measured Node.js process for one benchmark condition. Spawned by
// benchmark-harness.js via child_process.fork() so IPC message passing is
// available for the readiness/begin handshake and for returning results.
//
// IMPORTANT: this script never calls process.exit(). Once contention-addon
// is required, its raw pthreads plus its N-API env cleanup hook mean an
// explicit process.exit() call hangs forever on Node 22 instead of exiting
// (verified empirically -- see the comment above Cleanup() in
// contention-addon/src/addon.cpp). Instead, after sending the result this
// script calls process.disconnect() (which removes the IPC channel's handle
// from the event loop) and returns; with nothing else pending, Node exits
// naturally and the cleanup hook runs correctly.

const path = require('path');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const addon = require(path.join(__dirname, '..', 'contention-addon'));

const DURATION_MS = parseInt(process.env.BENCH_DURATION_MS || '30000', 10);
const PBKDF2_CONCURRENCY = parseInt(process.env.BENCH_PBKDF2_CONCURRENCY || '8', 10);
const PBKDF2_ITERATIONS = parseInt(process.env.BENCH_PBKDF2_ITERATIONS || '100000', 10);

function pbkdf2Once(iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2('bench-password', 'bench-salt-' + Math.random(), iterations, 64, 'sha512', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Forces libuv to spin up its threadpool workers *before* the harness
// enumerates this process's threads to apply taskset. libuv creates its
// full threadpool (all UV_THREADPOOL_SIZE worker threads) eagerly the first
// time anything uses it -- but not before. Without this warm-up, the
// threadpool workers wouldn't exist yet at pin time (nothing would have used the pool), and condition 3/5's "pin Node's threadpool workers" step
// would have nothing to pin. This also means the warmed-up threads are the
// exact same threads later reused for the measured pbkdf2 workload.
async function warmUpThreadpool() {
  const lanes = [];
  for (let i = 0; i < PBKDF2_CONCURRENCY; i++) lanes.push(pbkdf2Once(1));
  await Promise.all(lanes);
}

function runMeasuredWorkload() {
  return new Promise((resolve) => {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    addon.start();

    let running = true;
    let pbkdf2Calls = 0;
    let pbkdf2Errors = 0;

    function lane() {
      if (!running) return;
      pbkdf2Once(PBKDF2_ITERATIONS)
        .then(() => {
          pbkdf2Calls++;
          lane();
        })
        .catch(() => {
          pbkdf2Errors++;
          lane();
        });
    }
    for (let i = 0; i < PBKDF2_CONCURRENCY; i++) lane();

    setTimeout(() => {
      running = false;
      addon.stop();
      histogram.disable();
      resolve({
        p50Ms: histogram.percentile(50) / 1e6,
        p95Ms: histogram.percentile(95) / 1e6,
        p99Ms: histogram.percentile(99) / 1e6,
        maxMs: histogram.max / 1e6,
        minMs: histogram.min / 1e6,
        meanMs: histogram.mean / 1e6,
        stddevMs: histogram.stddev / 1e6,
        pbkdf2Calls,
        pbkdf2Errors,
        durationMs: DURATION_MS,
        pbkdf2Concurrency: PBKDF2_CONCURRENCY,
        pbkdf2Iterations: PBKDF2_ITERATIONS,
        addonThreadCount: addon.threadCount(),
      });
    }, DURATION_MS);
  });
}

async function main() {
  await warmUpThreadpool();

  process.send({ type: 'ready', pid: process.pid, addonThreadCount: addon.threadCount() });

  const result = await new Promise((resolve, reject) => {
    process.once('message', (msg) => {
      if (msg && msg.cmd === 'begin') {
        runMeasuredWorkload().then(resolve, reject);
      } else {
        reject(new Error(`worker-child: unexpected message before 'begin': ${JSON.stringify(msg)}`));
      }
    });
  });

  await new Promise((resolve) => {
    process.send({ type: 'result', result }, () => resolve());
  });
  process.disconnect();
}

main().catch((err) => {
  process.exitCode = 1;
  try {
    process.send({ type: 'error', message: (err && err.stack) || String(err) }, () => {
      process.disconnect();
    });
  } catch (e) {
    // IPC channel may already be gone; fall through to a natural exit with
    // exitCode already set to 1.
  }
});
