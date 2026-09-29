'use strict';

// Helpers for enumerating and pinning the threads of a running process via
// /proc and taskset. Used to apply and then verify per-thread CPU affinity
// without touching Node or libuv source -- a black-box approximation of the
// proposed UV_THREADPOOL_AFFINITY / NODE_MAIN_THREAD_AFFINITY feature via
// `taskset -p` on a running process.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseCpuList } = require('./topology');

const ADDON_THREAD_NAME_PREFIX = 'bench-worker';
// libuv names its threadpool worker threads exactly this (no per-thread
// index) as of the libuv/Node versions this was developed against. Used
// only for friendlier logging -- classification/pinning doesn't depend on
// it, since every non-addon thread is treated as part of "Node's set"
// regardless of whether it's the main thread, a libuv worker, or a V8
// background thread.
const LIBUV_WORKER_THREAD_NAME = 'libuv-worker';

// Returns [{ tid, comm, isMain, isAddon }] for every thread currently
// visible under /proc/<pid>/task. isMain is true for the thread whose tid
// equals the process's pid (the traditional "main thread" identification).
// isAddon is true for threads named by contention-addon (bench-worker-N).
// Everything else -- V8 background threads, the inspector thread, and
// (once warmed up) libuv threadpool workers -- falls into neither bucket
// and is treated as "Node's own threads" for pinning purposes, since the
// proposal being validated is about keeping ALL of Node's threads (not just
// the main thread) off the cores the addon uses.
function listThreads(pid) {
  const taskDir = `/proc/${pid}/task`;
  let tids;
  try {
    tids = fs.readdirSync(taskDir).map((n) => parseInt(n, 10));
  } catch (e) {
    throw new Error(`Could not enumerate threads for pid ${pid} (${e.message}). Has the process already exited?`);
  }

  return tids.map((tid) => {
    let comm = '';
    try {
      comm = fs.readFileSync(path.join(taskDir, String(tid), 'comm'), 'utf8').trim();
    } catch (e) {
      // Thread may have exited between readdir() and this read (e.g. a
      // short-lived libuv helper). Leave comm empty; caller should re-list
      // if it needs a stable snapshot.
    }
    return {
      tid,
      comm,
      isMain: tid === pid,
      isAddon: comm.startsWith(ADDON_THREAD_NAME_PREFIX),
      isLibuvWorker: comm === LIBUV_WORKER_THREAD_NAME,
    };
  });
}

// Applies `taskset -p <mask> <tid>` to a single thread.
function pinThread(tid, hexMask) {
  execFileSync('taskset', ['-p', hexMask, String(tid)], { stdio: ['ignore', 'ignore', 'pipe'] });
}

// Reads Cpus_allowed_list for one thread from /proc/<pid>/task/<tid>/status
// and returns it as a sorted array of CPU ids.
function readAllowedCpus(pid, tid) {
  const statusPath = `/proc/${pid}/task/${tid}/status`;
  const content = fs.readFileSync(statusPath, 'utf8');
  const match = content.match(/^Cpus_allowed_list:\s*(.+)$/m);
  if (!match) {
    throw new Error(`Cpus_allowed_list not found in ${statusPath}`);
  }
  return parseCpuList(match[1]);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const as = [...a].sort((x, y) => x - y);
  const bs = [...b].sort((x, y) => x - y);
  return as.every((v, i) => v === bs[i]);
}

// Verifies that thread `tid` of process `pid` is currently allowed to run
// only on `expectedCpuIds`. Throws with a descriptive message if not --
// this is the "regardless of addon, verify the pin actually stuck" check
// the benchmark always runs after applying taskset, so a silently
// overwritten or partially-applied mask fails the run instead of silently
// producing bogus numbers.
function verifyAffinity(pid, tid, expectedCpuIds, label) {
  const actual = readAllowedCpus(pid, tid);
  if (!sameSet(actual, expectedCpuIds)) {
    throw new Error(
      `Affinity verification failed for ${label || `tid ${tid}`}: expected CPUs [${expectedCpuIds.join(',')}], ` +
      `actual Cpus_allowed_list is [${actual.join(',')}]. A pin was not applied, was overwritten, or the thread ` +
      `exited/respawned between pinning and verification.`
    );
  }
}

module.exports = {
  listThreads,
  pinThread,
  readAllowedCpus,
  verifyAffinity,
  ADDON_THREAD_NAME_PREFIX,
};
