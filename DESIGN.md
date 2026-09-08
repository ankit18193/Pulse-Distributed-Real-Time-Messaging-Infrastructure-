# Pulse Design System — "Mission Control" Specification

**Document**: `DESIGN.md`  
**Version**: `1.0.0`  
**Status**: APPROVED  
**Target**: Pulse Infrastructure Console & Phase 9 Frontend Dashboard  

---

## 1. Design Philosophy & Aesthetic Thesis

Pulse is **distributed real-time messaging infrastructure**, not an end-user chat app or generic marketing site. Its design language is modeled after mission-critical observability consoles (Cloudflare Radar, Datadog Systems, NASA Mission Control, Grafana Enterprise, and Vercel Analytics).

### Core Tenets
1. **Calm Surface Hierarchy**: Dark obsidian void surfaces that recede, allowing glowing real-time telemetry, connection nodes, and throughput curves to be the primary focal points.
2. **Dense, Scannable Utility**: High information density without visual clutter. Data-first layout with zero decorative fluff.
3. **No AI Slop**: No generic 3-column SaaS marketing grids, no icons in colored circles, no pastel gradients, no floating decorative blobs, no emoji bullets.
4. **Sub-Second Feedback & Motion with Purpose**: Transitions are crisp (100–150ms ease-out) and serve only to indicate state changes (pulsing status beacons, live rolling waveform streams, tabular number flips).
5. **Colorblind-Safe Redundancy**: Every status color (green, amber, red) is accompanied by a shape/glyph (`[● OK]`, `[▲ WARN]`, `[✖ ERR]`, `[◌ IDLE]`).

---

## 2. Color Palette & Semantic Tokens

```css
:root {
  /* Surface Layers (Deep Obsidian Void) */
  --pulse-bg-space: #07090E;         /* Global viewport canvas */
  --pulse-bg-surface: #0E131F;       /* Primary panel / cockpit surface */
  --pulse-bg-card: #141A29;          /* Modular telemetry card */
  --pulse-bg-card-hover: #1D263B;    /* Interactive card hover */
  --pulse-bg-sunken: #0A0D15;        /* Terminal logs / code viewports */

  /* Borders & Grid Rules */
  --pulse-border-subtle: rgba(255, 255, 255, 0.08);
  --pulse-border-medium: rgba(255, 255, 255, 0.15);
  --pulse-border-accent: rgba(6, 182, 212, 0.4);

  /* Typography & Text */
  --pulse-text-primary: #F3F4F6;     /* 95% White - Headlines, critical metrics */
  --pulse-text-secondary: #9CA3AF;   /* 60% Gray - Field labels, table headers */
  --pulse-text-muted: #6B7280;       /* 40% Gray - Timestamps, helper notes */
  --pulse-text-inverse: #07090E;     /* Text on bright badge chips */

  /* Telemetry & Brand Accents */
  --pulse-accent-cyan: #06B6D4;      /* Ingress traffic / Primary brand / Inbound frames */
  --pulse-accent-emerald: #10B981;   /* Healthy status / Broadcast egress / Redis connected */
  --pulse-accent-amber: #F59E0B;     /* Degraded cluster / Event-loop lag warning (>20ms) */
  --pulse-accent-crimson: #EF4444;   /* Node offline / Auth rejected / Connection error */
  --pulse-accent-violet: #8B5CF6;    /* RouteX Edge Gateway / Proxied routes */

  /* Glow Filters */
  --pulse-glow-cyan: 0 0 12px rgba(6, 182, 212, 0.35);
  --pulse-glow-emerald: 0 0 12px rgba(16, 185, 129, 0.35);
  --pulse-glow-amber: 0 0 12px rgba(245, 158, 11, 0.35);
  --pulse-glow-crimson: 0 0 12px rgba(239, 68, 68, 0.35);
}
```

---

## 3. Typography Hierarchy

| Level | Family | Size / Line Height | Weight | Usage |
| :--- | :--- | :--- | :--- | :--- |
| **Display KPI** | JetBrains Mono / Monospace | `32px` / `36px` | `700` Bold | Big metric numbers (Conns, Msg/s, p99 Lag). `font-variant-numeric: tabular-nums` |
| **Section Title** | Inter / System Sans | `18px` / `24px` | `600` SemiBold | Subsystem titles, view headers, table titles |
| **Card Header** | Inter / System Sans | `13px` / `16px` | `600` SemiBold | Uppercase card labels with `letter-spacing: 0.05em` |
| **Body / Labels** | Inter / System Sans | `14px` / `20px` | `400` Regular | Descriptions, table cells, form labels |
| **Code / Logs** | JetBrains Mono / Monospace | `12px` / `18px` | `400` Regular | JSON wire frames, raw headers, connection IDs, timestamps |
| **Micro Badges** | JetBrains Mono / Monospace | `11px` / `14px` | `600` SemiBold | `[● OK]`, `[▲ WARN]`, `inst-a8f1`, `v0.1.0` |

---

## 4. Spacing Scale & Layout Grid

- **Base Unit**: `4px`
- **Spacing Steps**: `4px (1)`, `8px (2)`, `12px (3)`, `16px (4)`, `24px (6)`, `32px (8)`, `48px (12)`.
- **Card Padding**: `16px` (compact) or `20px` (standard).
- **Border Radius**:
  - Cards & Panels: `8px` (clean, technical, not bubbly).
  - Buttons & Inputs: `6px`.
  - Badges & Pills: `4px` or `9999px` (capsules).
- **Viewport Layout**:
  - Sticky Global Status Header: `56px` height.
  - Left Navigation Rail: `64px` collapsed (icon-only), `220px` expanded.
  - Main Telemetry Workspace: `flex: 1`, padded `20px`, scrollable.

---

## 5. Component Patterns & Rules

### 5.1 Telemetry Metric Card
- **Header**: Compact uppercase label + optional subtitle or percentage delta.
- **Value**: Large monospace number with `font-variant-numeric: tabular-nums` to eliminate jitter during rapid 1s polling updates.
- **Footer**: Sparkline or status caption (e.g. `Normal (<10ms)`).

### 5.2 Real-Time SVG Waveform
- **Aspect Ratio**: Fluid 100% width, fixed `180px` height.
- **Rendering**: Native SVG `<path>` with cubic bezier smoothing.
- **Time Window**: Rolling 60 seconds (1 tick per second).
- **Channels**:
  - Ingress msg/s: Electric Cyan line with 0.15 alpha gradient fill below.
  - Egress msg/s: Emerald line with 0.20 alpha gradient fill below.
- **Zero Memory Drift**: Fixed length array (60 data points max).

### 5.3 Subsystem Topology Matrix
- Schematic grid representing `[Clients] -> [RouteX Gateway] -> [Pulse Core] <-> [Redis Cluster]`.
- Nodes render dynamic status beacons:
  - **Healthy**: Steady glowing emerald dot `[● OK]`.
  - **Degraded**: Pulsing amber triangle `[▲ DEGRADED]`.
  - **Offline**: Crimson cross `[✖ OFFLINE]`.

### 5.4 Traffic Sandbox & Frame Inspector
- Split viewport:
  - Left: Interactive Connection & Dispatch Form (Server URL, User ID, Room ID, Payload, 1-Click Load Generator button).
  - Right: Terminal-style wire inspector showing raw JSON frames with direction badges (`INBOUND` in cyan, `OUTBOUND` in emerald) and instant "Copy JSON" button.

---

## 6. Accessibility & Keyboard Navigation (A11y)

1. **Contrast Compliance**: All text tokens achieve WCAG AAA contrast against dark surfaces (>5.5:1 ratio).
2. **Keyboard Navigation**:
   - `Alt+1`: Cockpit Overview
   - `Alt+2`: Rooms & Clients
   - `Alt+3`: RouteX Gateway
   - `Alt+4`: Traffic Sandbox
   - `Space` / `P`: Pause / Resume telemetry polling
3. **Focus States**: High-visibility cyan focus outline (`2px solid var(--pulse-accent-cyan)`, `outline-offset: 2px`).
4. **Touch Targets**: Minimum `44px x 44px` on all mobile/tablet interactive controls.
