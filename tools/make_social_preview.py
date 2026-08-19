#!/usr/bin/env python3
"""Generate the dsh-power-button social preview banner (1280x640).

Design: dark theme matching the DSH UI (deep navy/black), a large power icon
(circle + vertical bar) as the hero element, plugin name, and a one-line value
proposition. Pure matplotlib, no external deps.
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Rectangle
from matplotlib.font_manager import FontProperties
import numpy as np

W, H = 1280, 640
DPI = 2  # render at 2x then the output is exactly 1280x640 px? No — figsize*DPI.
# Use figsize=(1280/100, 640/100) at dpi=100 => 1280x640 px exactly.

BG_TOP = '#0d1117'      # GitHub dark background
BG_BOTTOM = '#010409'
ACCENT = '#3fb950'       # green accent (restart ok) — DSH uses green for success
ACCENT_DIM = '#238636'
TEXT = '#e6edf3'
MUTED = '#8b949e'
POWER_STROKE = '#e6edf3'

fig, ax = plt.subplots(figsize=(W / 100, H / 100), dpi=100)
fig.patch.set_facecolor(BG_TOP)
ax.set_facecolor(BG_TOP)
ax.set_xlim(0, 100)
ax.set_ylim(0, 50)
ax.axis('off')

# Subtle vertical gradient (top -> bottom)
grad = np.linspace(0, 1, 256).reshape(-1, 1)
grad_img = np.repeat(grad, 512, axis=1)
ax.imshow(grad_img, extent=[0, 100, 0, 50], aspect='auto', origin='lower',
          cmap=plt.cm.colors.LinearSegmentedColormap.from_list(
              'bg', [BG_BOTTOM, BG_TOP]))

# ---- Hero: large power icon on the left ----
cx, cy, r = 24, 25, 16
# Circle
ax.add_patch(Circle((cx, cy), r, fill=False, lw=4.5, edgecolor=POWER_STROKE, zorder=3))
# Vertical bar (the "1" of the power symbol), a thick line from top of circle down to center
bar_w = 3.2
bar_top = cy + r * 0.98
bar_bot = cy - r * 0.12
ax.add_patch(Rectangle((cx - bar_w / 2, bar_bot), bar_w, bar_top - bar_bot,
                       facecolor=POWER_STROKE, zorder=3))
# Small gap at the very top of the bar (power symbol convention)
ax.add_patch(Rectangle((cx - bar_w / 2, cy + r * 0.86), bar_w, (bar_top - (cy + r * 0.86)) * 0.5,
                       facecolor=BG_TOP, zorder=4))

# ---- Title ----
fp_title = FontProperties(family='DejaVu Sans', weight='bold', size=30)
fp_sub = FontProperties(family='DejaVu Sans', size=16)
fp_body = FontProperties(family='DejaVu Sans', size=13)

ax.text(52, 32, 'dsh-power-button', color=TEXT, fontproperties=fp_title, zorder=5)
ax.text(52, 27, 'Restart / Shutdown DeepSeek Harness in one click',
        color=MUTED, fontproperties=fp_sub, zorder=5)

# ---- Feature chips ----
chips = [
    ('Restart', 'graceful reload'),
    ('Shutdown', 'clean stop'),
    ('Model tool', 'agent-invokable'),
]
chip_y = 18
chip_w = 26
gap = 2.5
x0 = 52
for i, (head, desc) in enumerate(chips):
    x = x0 + i * (chip_w + gap)
    ax.add_patch(Rectangle((x, chip_y - 3.5), chip_w, 7, facecolor='#161b22',
                           edgecolor='#30363d', lw=1, zorder=3))
    ax.text(x + chip_w / 2, chip_y - 0.6, head, color=ACCENT, ha='center',
            fontproperties=FontProperties(family='DejaVu Sans', weight='bold', size=11), zorder=4)
    ax.text(x + chip_w / 2, chip_y - 2.6, desc, color=MUTED, ha='center',
            fontproperties=FontProperties(family='DejaVu Sans', size=7.5), zorder=4)

# ---- Footer ----
ax.text(52, 8, 'A plugin for the DeepSeek Harness ecosystem',
        color=MUTED, fontproperties=FontProperties(family='DejaVu Sans', size=11), zorder=5)

out = 'assets/social-preview.png'
import os
os.makedirs('assets', exist_ok=True)
fig.savefig(out, dpi=100, facecolor=BG_TOP, bbox_inches=None, pad_inches=0)
print(f'wrote {out}')
