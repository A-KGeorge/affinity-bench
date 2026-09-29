'use strict';

// Minimal smoke test: does the addon build and load, does start()/stop()
// work, and does it spawn the expected number of named threads. Run this
// after `npm run build` and before trusting the harness's own results.
//
// IMPORTANT: this script never calls process.exit(). Once contention-addon
// is required, its raw pthreads + N-API env cleanup hook mean an explicit
// process.exit() call hangs forever on Node 22 instead of exiting (verified
// empirically -- see the comment above Cleanup() in src/addon.cpp). Instead
// this script sets process.exitCode and returns, letting the event loop
// drain naturally, which runs the cleanup hook correctly and exits cleanly.

const fs = require('fs');
const addon = require('./index.js');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

const expected = process.env.ADDON_THREAD_COUNT
  ? parseInt(process.env.ADDON_THREAD_COUNT, 10)
  : require('os').cpus().length;

const actual = addon.threadCount();
if (actual !== expected) {
  fail(`expected ${expected} addon threads, got ${actual}`);
} else {
  console.log(`OK: addon spawned ${actual} threads`);
}

// Verify the threads are actually visible and named under /proc.
const taskDir = `/proc/${process.pid}/task`;
const tids = fs.readdirSync(taskDir).map(Number);
let named = 0;
for (const tid of tids) {
  try {
    const comm = fs.readFileSync(`${taskDir}/${tid}/comm`, 'utf8').trim();
    if (comm.startsWith('bench-worker')) named++;
  } catch (e) {
    // thread may have exited between readdir and read; ignore
  }
}
if (named !== expected) {
  fail(`expected ${expected} threads named bench-worker-*, found ${named} in /proc/${process.pid}/task`);
} else {
  console.log(`OK: ${named} threads visible and named under /proc/${process.pid}/task`);
}

// Verify start/stop toggle without throwing, and that CPU actually gets
// consumed while running (coarse check -- just to catch a completely
// no-op busy loop, not a real measurement; that's the harness's job).
function cpuTimeMs() {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

addon.start();
const before = cpuTimeMs();
const startWall = Date.now();
while (Date.now() - startWall < 300) {
  /* busy-wait 300ms on the JS thread so cpuUsage() reflects wall time
     passing while addon threads spin in the background */
}
const after = cpuTimeMs();
addon.stop();

const deltaMs = after - before;
console.log(`OK: start()/stop() did not throw. Process CPU time delta over ~300ms wall: ${deltaMs.toFixed(1)}ms (process-wide, includes this thread's own busy-wait).`);
if (deltaMs < 300) {
  fail(`process CPU time delta (${deltaMs.toFixed(1)}ms) is less than the wall-clock window (300ms) -- addon threads may not be consuming CPU as expected.`);
}

console.log('Note: this self-test only confirms the addon loads, spawns/names threads, and start()/stop() work. It does not measure per-core saturation -- that is the harness\'s job.');

if (process.exitCode) {
  console.error('SELF-TEST FAILED');
} else {
  console.log('SELF-TEST PASSED');
}
// No process.exit() call -- see note at top of file. The script returns
// here, nothing else is keeping the event loop alive, so Node exits
// naturally with process.exitCode.
