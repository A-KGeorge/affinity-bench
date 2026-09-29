'use strict';

// Discovers the L3-cache-sharing CPU groups on this machine by reading, for
// each present logical CPU, which other logical CPUs share its L3
// (index3) cache -- i.e. its cache-coherence/contention domain.
//
// On a dual-CCD Ryzen (e.g. 5900X: 12C/24T, two 6-core CCDs each with its
// own 32MB L3), this naturally produces exactly two groups of 12 logical
// CPUs each. Linux reports this whole chip as a single NUMA node, so this
// is *not* NUMA-based discovery -- it's cache-domain discovery. It's kept
// generic (no hardcoded CPU numbers, no assumption of exactly 12-per-group)
// so it also works on other multi-L3-domain machines.
//
// If the topology doesn't split cleanly into exactly two L3 domains, this
// throws rather than guessing -- silently pinning to the wrong CPUs would
// invalidate every number the benchmark produces.

const fs = require('fs');
const path = require('path');

const CPU_SYSFS_ROOT = '/sys/devices/system/cpu';

function listPresentCpus() {
  let names;
  try {
    names = fs.readdirSync(CPU_SYSFS_ROOT);
  } catch (e) {
    throw new Error(
      `Could not read ${CPU_SYSFS_ROOT} (${e.message}). This platform does not expose the Linux CPU sysfs tree this benchmark relies on.`
    );
  }
  const cpuIds = names
    .filter((n) => /^cpu\d+$/.test(n))
    .map((n) => parseInt(n.slice(3), 10))
    .sort((a, b) => a - b);

  if (cpuIds.length === 0) {
    throw new Error(`No cpuN entries found under ${CPU_SYSFS_ROOT}.`);
  }
  return cpuIds;
}

// Parses a Linux "list" format string (e.g. "0-5,12-17" or "0,2,4") into a
// sorted array of integers.
function parseCpuList(str) {
  const out = new Set();
  for (const part of str.trim().split(',')) {
    if (part === '') continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((s) => parseInt(s, 10));
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      out.add(parseInt(part, 10));
    }
  }
  return [...out].sort((a, b) => a - b);
}

function readSharedL3List(cpuId) {
  const p = path.join(CPU_SYSFS_ROOT, `cpu${cpuId}`, 'cache', 'index3', 'shared_cpu_list');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(
      `Could not read ${p} (${e.message}). This machine may not expose an L3 (cache/index3) node for cpu${cpuId} -- ` +
      `cache-domain-based pinning requires it. If this hardware genuinely has no L3, or a different cache index is ` +
      `the last shared level, this benchmark's topology discovery needs to be adapted rather than guessing.`
    );
  }
  return parseCpuList(raw);
}

// Returns { groups: number[][], cpuCount: number } where groups.length is
// guaranteed to be exactly 2 (throws otherwise), sorted by each group's
// lowest CPU id, each group's CPU ids sorted ascending.
function discoverL3Groups() {
  const cpuIds = listPresentCpus();

  // Group CPUs by their shared_cpu_list signature (the exact list string
  // canonicalized via parse+rejoin, so equivalent lists always compare
  // equal regardless of formatting differences).
  const bySignature = new Map();
  for (const cpuId of cpuIds) {
    const list = readSharedL3List(cpuId);
    const sig = list.join(',');
    if (!bySignature.has(sig)) bySignature.set(sig, new Set());
    bySignature.get(sig).add(cpuId);
  }

  const groups = [...bySignature.values()]
    .map((set) => [...set].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);

  if (groups.length !== 2) {
    const summary = groups.map((g) => `[${g.join(',')}]`).join(', ');
    throw new Error(
      `Expected exactly 2 L3-cache-sharing CPU groups, found ${groups.length}: ${summary}. ` +
      `This benchmark is designed for a dual-cache-domain machine (e.g. a dual-CCD Ryzen); ` +
      `refusing to guess how to split threads on a topology it doesn't understand. Stopping.`
    );
  }

  const totalGrouped = groups[0].length + groups[1].length;
  if (totalGrouped !== cpuIds.length) {
    throw new Error(
      `L3 groups account for ${totalGrouped} CPUs but ${cpuIds.length} logical CPUs are present. ` +
      `Refusing to proceed with an incomplete topology map.`
    );
  }

  return { groups, cpuCount: cpuIds.length };
}

// Converts an array of logical CPU ids into a hex bitmask string usable by
// `taskset -p <mask> <pid>` (taskset accepts hex masks with or without a
// leading "0x"; we include it for clarity in logs).
function cpuListToMask(cpuIds) {
  let mask = 0n;
  for (const id of cpuIds) mask |= 1n << BigInt(id);
  return '0x' + mask.toString(16);
}

module.exports = { discoverL3Groups, cpuListToMask, parseCpuList, listPresentCpus };
