#!/usr/bin/env python3
"""Generate the two benchmark charts as static PNGs for the GitHub issues /
README. Static images (not the interactive HTML form), so no hover layer;
everything else from the dataviz method still applies: one hue per
measure, direct labels, recessive gridlines, no dual axis.
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import numpy as np

# --- palette (reference instance, light mode) ---
SURFACE = "#fcfcfb"
INK_PRIMARY = "#0b0b0b"
INK_SECONDARY = "#52514e"
INK_MUTED = "#898781"
GRIDLINE = "#e1e0d9"
BASELINE_AXIS = "#c3c2b7"
SERIES_BLUE = "#2a78d6"
SERIES_ORANGE = "#eb6834"
STATUS_CRITICAL = "#d03b3b"

plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = ["DejaVu Sans", "Arial", "Helvetica"]

conditions = [
    "1. Baseline",
    "2. Process-wide\npin (naive)",
    "3. Selective\npin",
    "4. Sized-down,\nunpinned",
    "5. Sized-down\n+ pinned",
]

# p99 added delay (ms above the 10ms sampling floor), 4 runs each
p99_runs = {
    0: [0.97, 0.99, 0.94, 0.99],
    1: [2.94, 2.95, 2.94, 3.00],
    2: [0.92, 0.88, 0.89, 0.90],
    3: [0.90, 0.94, 0.96, 0.93],
    4: [0.88, 0.92, 0.90, 0.91],
}
max_runs = {
    0: [5.29, 4.16, 3.21, 7.69],
    1: [6.40, 15.12, 7.14, 17.08],
    2: [4.56, 1.03, 1.05, 1.66],
    3: [3.08, 18.85, 5.00, 4.90],
    4: [1.12, 3.98, 2.49, 2.17],
}

means = [np.mean(p99_runs[i]) for i in range(5)]
stdevs = [np.std(p99_runs[i]) for i in range(5)]

# ---------------------------------------------------------------------------
# Chart 1: p99 added delay by condition, mean +/- stdev across 4 runs
# ---------------------------------------------------------------------------
fig, ax = plt.subplots(figsize=(9, 5.4), dpi=200)
fig.patch.set_facecolor(SURFACE)
ax.set_facecolor(SURFACE)

x = np.arange(5)
bar_colors = [STATUS_CRITICAL if i == 1 else SERIES_BLUE for i in range(5)]
bars = ax.bar(x, means, yerr=stdevs, capsize=4, color=bar_colors, width=0.56,
              edgecolor="none", zorder=3,
              error_kw=dict(ecolor=INK_SECONDARY, elinewidth=1.3, capthick=1.3, zorder=4))

# baseline reference line
ax.axhline(means[0], color=BASELINE_AXIS, linewidth=1, linestyle=(0, (4, 3)), zorder=1)
ax.text(4.52, means[0] - 0.16, "baseline mean", color=INK_MUTED, fontsize=9,
        va="top", ha="right")

# direct labels
for i, (m, s) in enumerate(zip(means, stdevs)):
    ax.text(i, m + s + 0.10, f"{m:.2f}ms", ha="center", va="bottom",
             color=INK_PRIMARY, fontsize=10.5, fontweight="medium", zorder=5)

# annotate condition 2 as the outlier finding
ax.annotate("+204% vs baseline\n(reproduced in all 4 runs)", xy=(1, means[1] + stdevs[1] + 0.35),
            xytext=(1.55, 2.55), color=STATUS_CRITICAL, fontsize=9.5,
            ha="left", va="center",
            arrowprops=dict(arrowstyle="-", color=STATUS_CRITICAL, lw=1))

ax.set_xticks(x)
ax.set_xticklabels(conditions, fontsize=9.5, color=INK_SECONDARY)
ax.set_ylabel("p99 event-loop delay added above\nthe 10ms sampling floor (ms)",
              color=INK_SECONDARY, fontsize=10)
ax.set_ylim(0, 3.4)
ax.grid(axis="y", color=GRIDLINE, linewidth=0.8, zorder=0)
ax.set_axisbelow(True)
for spine in ["top", "right", "left"]:
    ax.spines[spine].set_visible(False)
ax.spines["bottom"].set_color(BASELINE_AXIS)
ax.tick_params(axis="y", colors=INK_MUTED, labelsize=9)
ax.tick_params(axis="x", length=0)

fig.text(0.06, 0.97, "Thread-affinity contention benchmark — p99 event-loop delay",
          color=INK_PRIMARY, fontsize=14.5, fontweight="bold", va="top")
fig.text(0.06, 0.925, "Ryzen 9 5900X, N=24 addon threads (12 for conditions 4-5), mean ± stdev across 4 independent 45s runs",
          color=INK_MUTED, fontsize=9.5, va="top")

plt.tight_layout(rect=[0, 0, 1, 0.87])
plt.savefig("/home/claude/thread-affinity-benchmark/results/p99-comparison.png",
            facecolor=SURFACE, bbox_inches="tight")
plt.close()

# ---------------------------------------------------------------------------
# Chart 2: p99 vs max, per-run points, showing why max isn't trusted
# ---------------------------------------------------------------------------
fig, ax = plt.subplots(figsize=(9, 5.6), dpi=200)
fig.patch.set_facecolor(SURFACE)
ax.set_facecolor(SURFACE)

jitter = [-0.13, -0.045, 0.045, 0.13]
for i in range(5):
    xs_p99 = [i + j for j in jitter]
    xs_max = [i + j for j in jitter]
    ax.scatter(xs_p99, p99_runs[i], color=SERIES_BLUE, s=46, zorder=4,
               edgecolor=SURFACE, linewidth=0.8)
    ax.scatter(xs_max, max_runs[i], color=SERIES_ORANGE, s=46, zorder=4,
               marker="D", edgecolor=SURFACE, linewidth=0.8)
    # connect each condition's own 4 runs lightly to show the spread
    ax.vlines(i, min(p99_runs[i]), max(p99_runs[i]), color=SERIES_BLUE, alpha=0.15, linewidth=6, zorder=1)
    ax.vlines(i, min(max_runs[i]), max(max_runs[i]), color=SERIES_ORANGE, alpha=0.15, linewidth=6, zorder=1)

ax.set_xticks(range(5))
ax.set_xticklabels(conditions, fontsize=9.5, color=INK_SECONDARY)
ax.set_ylabel("Added delay above the 10ms floor (ms)", color=INK_SECONDARY, fontsize=10)
ax.grid(axis="y", color=GRIDLINE, linewidth=0.8, zorder=0)
ax.set_axisbelow(True)
for spine in ["top", "right", "left"]:
    ax.spines[spine].set_visible(False)
ax.spines["bottom"].set_color(BASELINE_AXIS)
ax.tick_params(axis="y", colors=INK_MUTED, labelsize=9)
ax.tick_params(axis="x", length=0)

# legend (2 series -> legend required)
from matplotlib.lines import Line2D
legend_elems = [
    Line2D([0], [0], marker="o", color="none", markerfacecolor=SERIES_BLUE, markersize=8, label="p99 (4 runs)"),
    Line2D([0], [0], marker="D", color="none", markerfacecolor=SERIES_ORANGE, markersize=7, label="max (4 runs)"),
]
leg = ax.legend(handles=legend_elems, loc="upper left", frameon=False, fontsize=9.5,
                 labelcolor=INK_SECONDARY, handletextpad=0.6, bbox_to_anchor=(0.01, 1.0))

fig.text(0.06, 0.97, "Same 4 runs: p99 clusters tightly, max doesn't",
          color=INK_PRIMARY, fontsize=14.5, fontweight="bold", va="top")
fig.text(0.06, 0.925, "Each dot is one 45s run. Thick vertical bands span each condition's own min-max. p99 CV ≈ 2-3%; max CV ≈ 33-80%.",
          color=INK_MUTED, fontsize=9.5, va="top")

plt.tight_layout(rect=[0, 0, 1, 0.87])
plt.savefig("/home/claude/thread-affinity-benchmark/results/p99-vs-max-spread.png",
            facecolor=SURFACE, bbox_inches="tight")
plt.close()

print("wrote p99-comparison.png and p99-vs-max-spread.png")
