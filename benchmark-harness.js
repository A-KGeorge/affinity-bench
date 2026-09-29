#!/usr/bin/env node
'use strict';

// Orchestrates the five-condition thread-affinity contention benchmark.
//
// Usage:
//   node benchmark-harness.js [--duration-ms=45000] [--cooldown-ms=3000]
//                              [--pbkdf2-concurrency=8] [--pbkdf2-iterations=100000]
//                              [--out-dir=results]
//
// See README.md for the full methodology. In short: for each of five
// conditions (baseline / process-wide pin / selective per-thread pin /
// sized-down unpinned / sized-down selectively pinned), this spawns a fresh
// child Node process running lib/worker-child.js, applies the condition's
// taskset -p pinning (if any) during a readiness window before the
// synthetic addon's busy-loop threads start spinning, then measures event
// loop lag via perf_hooks.monitorEventLoopDelay() while the addon threads
// and a concurrent crypto.pbkdf2 workload run for the configured duration.
//
// This is a black-box approximation via `taskset -p` on a running process --
// it does not modify Node or libuv source, and is not the actual proposed
// UV_THREADPOOL_AFFINITY / NODE_MAIN_THREAD_AFFINITY implementation. It
// exists to produce evidence for that proposal, not to be it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, execSync } = require('child_process');

const { discoverL3Groups, cpuListToMask } = require('./lib/topology');
const { listThreads, pinThread, verifyAffinity } = require('./lib/procfs');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    durationMs: 45000,
    cooldownMs: 3000,
    pbkdf2Concurrency: 8,
    pbkdf2Iterations: 100000,
    outDir: path.join(__dirname, 'results'),
  };
  for (const arg of argv) {
    const m = arg.match(/^--([a-z0-9-]+)=(.+)$/i);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case 'duration-ms': opts.durationMs = parseInt(value, 10); break;
      case 'cooldown-ms': opts.cooldownMs = parseInt(value, 10); break;
      case 'pbkdf2-concurrency': opts.pbkdf2Concurrency = parseInt(value, 10); break;
      case 'pbkdf2-iterations': opts.pbkdf2Iterations = parseInt(value, 10); break;
      case 'out-dir': opts.outDir = path.resolve(value); break;
      default:
        console.error(`Unknown option --${key}, ignoring.`);
    }
  }
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Machine info
// ---------------------------------------------------------------------------

function collectMachineInfo() {
  let lscpu = null;
  try {
    lscpu = execSync('lscpu', { encoding: 'utf8' });
  } catch (e) {
    lscpu = `(lscpu unavailable: ${e.message})`;
  }
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cpuModel: (os.cpus()[0] || {}).model || '(unknown)',
    logicalCpuCount: os.cpus().length,
    lscpu,
  };
}

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------

// Applies the taskset -p pinning for one condition to a running child
// process, then verifies every pin actually stuck. Non-addon, non-main
// threads that vanish between enumeration and pinning/verification (a
// transient V8 helper thread exiting, say) are logged and skipped rather
// than failing the run -- but the main thread, any addon thread, or any
// mismatch in the CPUs a thread is actually allowed to run on is fatal,
// since those are exactly the threads whose placement this benchmark exists
// to test.
function applyPinningForCondition(spec, pid, ctx, log) {
  if (spec.pin === 'none') return [];

  const threads = listThreads(pid);
  const nodeMask = cpuListToMask(ctx.nodeSet);
  const addonMask = cpuListToMask(ctx.addonSet);
  const applied = [];

  for (const t of threads) {
    const targetSet = spec.pin === 'process' ? 'node' : (t.isAddon ? 'addon' : 'node');
    const targetMask = targetSet === 'addon' ? addonMask : nodeMask;
    const critical = t.isMain || t.isAddon;

    try {
      pinThread(t.tid, targetMask);
      applied.push({ tid: t.tid, comm: t.comm, targetSet, critical });
    } catch (e) {
      if (!critical) {
        log(`  (warning) could not pin tid=${t.tid} comm=${t.comm} (likely exited): ${e.message.split('\n')[0]}`);
        continue;
      }
      throw new Error(`Failed to pin critical thread tid=${t.tid} comm=${t.comm}: ${e.message}`);
    }
  }

  const expectedCpuSets = { node: ctx.nodeSet, addon: ctx.addonSet };
  for (const a of applied) {
    try {
      verifyAffinity(pid, a.tid, expectedCpuSets[a.targetSet], `${a.comm}(tid=${a.tid})`);
    } catch (e) {
      if (!a.critical && e.code === 'ENOENT') {
        log(`  (warning) tid=${a.tid} comm=${a.comm} exited before verification; skipping`);
        continue;
      }
      throw e;
    }
  }

  log(`  pinned ${applied.length} threads (${applied.filter((a) => a.targetSet === 'addon').length} to addon set, ${applied.filter((a) => a.targetSet === 'node').length} to node set)`);
  return applied;
}

// ---------------------------------------------------------------------------
// Running one condition
// ---------------------------------------------------------------------------

function runCondition(spec, ctx, log) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      ADDON_THREAD_COUNT: String(spec.addonThreads),
      UV_THREADPOOL_SIZE: String(ctx.pbkdf2Concurrency),
      BENCH_DURATION_MS: String(ctx.durationMs),
      BENCH_PBKDF2_CONCURRENCY: String(ctx.pbkdf2Concurrency),
      BENCH_PBKDF2_ITERATIONS: String(ctx.pbkdf2Iterations),
    });

    const child = fork(path.join(__dirname, 'lib', 'worker-child.js'), [], {
      env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    let settled = false;
    const timeoutMs = ctx.durationMs + 30000; // generous ceiling in case a child wedges
    const hardTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Condition ${spec.id} (${spec.name}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('message', (msg) => {
      if (settled) return;
      if (msg.type === 'ready') {
        log(`  child ready (pid=${msg.pid}, addonThreadCount=${msg.addonThreadCount})`);
        try {
          applyPinningForCondition(spec, msg.pid, ctx, log);
        } catch (e) {
          settled = true;
          clearTimeout(hardTimeout);
          child.kill('SIGKILL');
          reject(e);
          return;
        }
        child.send({ cmd: 'begin' });
      } else if (msg.type === 'result') {
        settled = true;
        clearTimeout(hardTimeout);
        resolve(msg.result);
      } else if (msg.type === 'error') {
        settled = true;
        clearTimeout(hardTimeout);
        reject(new Error(`Child reported error: ${msg.message}`));
      }
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      reject(new Error(`Child for condition ${spec.id} (${spec.name}) exited early (code=${code}, signal=${signal}) before reporting a result`));
    });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      reject(e);
    });
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmt(ms) {
  return ms === undefined || ms === null ? 'n/a' : ms.toFixed(2);
}

function buildMarkdownTable(rows) {
  const header = '| Condition | N (addon threads) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |';
  const sep = '|---|---|---|---|---|---|';
  const lines = rows.map((r) =>
    `| ${r.id}. ${r.name} | ${r.addonThreads} | ${fmt(r.p50Ms)} | ${fmt(r.p95Ms)} | ${fmt(r.p99Ms)} | ${fmt(r.maxMs)} |`
  );
  return [header, sep, ...lines].join('\n');
}

function buildComparisonSummary(rows) {
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const lines = [];
  function compare(aId, bId, label) {
    const a = byId[aId];
    const b = byId[bId];
    if (!a || !b || a.error || b.error) {
      lines.push(`- ${label}: unavailable (a run failed)`);
      return;
    }
    const dp99 = a.p99Ms - b.p99Ms;
    const pct = b.p99Ms !== 0 ? (dp99 / b.p99Ms) * 100 : NaN;
    lines.push(`- ${label}: condition ${aId} p99 ${fmt(a.p99Ms)}ms vs condition ${bId} p99 ${fmt(b.p99Ms)}ms (${dp99 >= 0 ? '+' : ''}${fmt(dp99)}ms, ${pct.toFixed(1)}%)`);
  }
  compare(3, 1, 'Condition 3 vs 1 (does selective pinning help under full contention)');
  compare(4, 1, 'Condition 4 vs 1 (how much plain sizing-down recovers)');
  compare(5, 4, 'Condition 5 vs 4 (does pinning add anything once sizing is already done)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.platform !== 'linux') {
    console.error(`This benchmark is Linux-only (uses /sys/devices/system/cpu, /proc/<pid>/task, and taskset). Detected platform: ${process.platform}. Stopping.`);
    process.exitCode = 1;
    return;
  }

  const opts = parseArgs(process.argv.slice(2));

  console.log('=== Thread affinity contention benchmark ===\n');

  console.log('Discovering L3 cache-sharing CPU groups (cache-domain isolation, not NUMA)...');
  const { groups, cpuCount } = discoverL3Groups();
  console.log(`Found exactly 2 L3 groups covering ${cpuCount} logical CPUs:`);
  console.log(`  Group A: [${groups[0].join(',')}] (${groups[0].length} CPUs)`);
  console.log(`  Group B: [${groups[1].join(',')}] (${groups[1].length} CPUs)`);

  const nodeSet = groups[0];
  const addonSet = groups[1];
  console.log(`\nAssignment: Node set (main thread + libuv threadpool) = [${nodeSet.join(',')}]`);
  console.log(`            Addon set (synthetic busy-loop threads)     = [${addonSet.join(',')}]\n`);

  const totalCpus = cpuCount;
  const addonSetSize = addonSet.length;

  const conditions = [
    { id: 1, name: 'Baseline (no taskset)', pin: 'none', addonThreads: totalCpus },
    { id: 2, name: 'Process-wide pin (naive: all threads -> node set)', pin: 'process', addonThreads: totalCpus },
    { id: 3, name: 'Selective per-thread pin (proposed feature, approximated)', pin: 'selective', addonThreads: totalCpus },
    { id: 4, name: 'Sized-down, unpinned (cap addon threads to addon-set size)', pin: 'none', addonThreads: addonSetSize },
    { id: 5, name: 'Sized-down, selectively pinned (matched control)', pin: 'selective', addonThreads: addonSetSize },
  ];

  const ctx = {
    nodeSet,
    addonSet,
    durationMs: opts.durationMs,
    pbkdf2Concurrency: opts.pbkdf2Concurrency,
    pbkdf2Iterations: opts.pbkdf2Iterations,
  };

  console.log(`Run parameters: duration=${opts.durationMs}ms/condition, pbkdf2 concurrency=${opts.pbkdf2Concurrency}, pbkdf2 iterations=${opts.pbkdf2Iterations}, cooldown=${opts.cooldownMs}ms\n`);

  const results = [];
  for (const spec of conditions) {
    console.log(`--- Condition ${spec.id}: ${spec.name} (N=${spec.addonThreads}) ---`);
    const startedAt = Date.now();
    try {
      const result = await runCondition(spec, ctx, (line) => console.log(line));
      const row = {
        id: spec.id,
        name: spec.name,
        pin: spec.pin,
        addonThreads: spec.addonThreads,
        ...result,
        wallMs: Date.now() - startedAt,
      };
      results.push(row);
      console.log(`  p50=${fmt(result.p50Ms)}ms p95=${fmt(result.p95Ms)}ms p99=${fmt(result.p99Ms)}ms max=${fmt(result.maxMs)}ms (pbkdf2 calls: ${result.pbkdf2Calls})\n`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}\n`);
      results.push({ id: spec.id, name: spec.name, pin: spec.pin, addonThreads: spec.addonThreads, error: e.message });
    }
    if (spec.id !== conditions[conditions.length - 1].id) {
      await sleep(opts.cooldownMs);
    }
  }

  console.log('\n=== Results ===\n');
  console.table(results.map((r) => ({
    condition: `${r.id}. ${r.name}`,
    N: r.addonThreads,
    p50: fmt(r.p50Ms),
    p95: fmt(r.p95Ms),
    p99: fmt(r.p99Ms),
    max: fmt(r.maxMs),
    error: r.error || '',
  })));

  const markdownTable = buildMarkdownTable(results);
  const comparisonSummary = buildComparisonSummary(results);

  console.log('\n--- Markdown (paste into the GitHub issues) ---\n');
  console.log(markdownTable);
  console.log('\n--- How to read the results ---\n');
  console.log(comparisonSummary);

  const machineInfo = collectMachineInfo();

  fs.mkdirSync(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(opts.outDir, `results-${stamp}.json`);
  const mdPath = path.join(opts.outDir, `results-${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    runParameters: opts,
    topology: { groups, nodeSet, addonSet, cpuCount },
    machineInfo,
    results,
  }, null, 2));

  fs.writeFileSync(mdPath, [
    `# Thread affinity contention benchmark results`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `## Machine`,
    ``,
    '```',
    `CPU: ${machineInfo.cpuModel}`,
    `Logical CPUs: ${machineInfo.logicalCpuCount}`,
    `Node set (L3 group): [${nodeSet.join(',')}]`,
    `Addon set (L3 group): [${addonSet.join(',')}]`,
    '```',
    ``,
    `<details><summary>lscpu</summary>`,
    ``,
    '```',
    machineInfo.lscpu.trim(),
    '```',
    ``,
    `</details>`,
    ``,
    `## Results`,
    ``,
    markdownTable,
    ``,
    `## How to read the results`,
    ``,
    comparisonSummary,
    ``,
  ].join('\n'));

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);

  if (results.some((r) => r.error)) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Fatal error:', e.stack || e.message);
  process.exitCode = 1;
});
