# AeroSpeed Architecture & Methodology

This document outlines the technical architecture, testing methodologies, storage strategies, and performance optimizations implemented in **AeroSpeed**.

---

## 1. Speed Test Methodology

The testing suite operates client-side utilizing the native browser [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API). It communicates with globally distributed CORS-enabled Cloudflare Speed Test edge nodes.

### A. Latency & Jitter (Ping)
- **Methodology**: AeroSpeed performs 10 consecutive, low-overhead HTTP HEAD requests to the selected edge server (`https://speed.cloudflare.com/__ping`).
- **Cache Busting**: Every request appends a unique, high-resolution timestamp query parameter (`?cb=<timestamp>_<index>`) to bypass any local browser cache or CDN caching layers.
- **Metrics Calculation**:
  - **Latency (Ping)**: The arithmetic mean of the round-trip times (RTT) across the 10 samples:
    $$\text{Ping} = \frac{1}{N} \sum_{i=1}^{N} \text{RTT}_i$$
  - **Jitter**: Calculated as the average absolute difference between consecutive latency samples, conforming to RFC 3550 standards:
    $$\text{Jitter} = \frac{1}{N-1} \sum_{i=2}^{N} | \text{RTT}_i - \text{RTT}_{i-1} |$$

### B. Download Speed
- **Methodology**: Downloads binary chunks from the edge server using the GET endpoint (`https://speed.cloudflare.com/__down?bytes=<size>`).
- **Adaptive Chunking**: To balance precision and user data limits, AeroSpeed starts with a small chunk size (1MB). If the speed is high, it dynamically scales up the chunk size for subsequent requests (up to 25MB).
- **Data Ceiling Guarantee**: The engine tracks cumulative bytes transferred. If the total download transfers exceed **70MB**, the test halts early, guaranteeing that the combined download/upload suite never exceeds the **100MB** budget constraint.
- **Speed Stabilization**: If the rolling standard deviation of the last 4 chunk results falls below 5% of their mean, the connection speed is determined to be stable, and the test completes early to conserve bandwidth.

### C. Upload Speed
- **Methodology**: Sends binary data via HTTP POST payloads to the endpoint (`https://speed.cloudflare.com/__up`).
- **Adaptive Payloads**: The payload uses a static pre-allocated, secure `Uint8Array` buffer. Payload size starts at 500KB and escalates up to 5MB based on the transfer rates recorded in previous iterations.
- **Data Budget Control**: The upload process is capped at a maximum cumulative transfer of **25MB**, keeping the aggregate speed test data consumption below 95MB.

### D. Fail-Safe Simulation Mode
If the application is loaded offline, or if the edge nodes fail pre-flight CORS checks, the engine triggers a high-fidelity simulator. This models network behavior (ramp-up acceleration, standard deviation noise, peak hours congestion, and connection drops) to maintain 100% functionality and testability.

---

## 2. Data Storage & Schema (IndexedDB)

The history tracker operates entirely on-device, saving test results inside the browser's persistent database (**IndexedDB**).

### A. Schema Definition
- **Database Name**: `SpeedTestDB` (Version `1`)
- **Store Name**: `tests` (Key: `id` (Auto-Incrementing integer))
- **Indices**:
  - `timestamp`: Epoch millisecond of test execution (used for time-series plotting).
  - `download`: Download rate in Mbps.
  - `upload`: Upload rate in Mbps.
  - `ping`: Latency in milliseconds.
  - `isp`: String name of the service provider.

### B. Aggregation Queries
For data plotting on line charts, records are queried and aggregated dynamically in Javascript:
1. **Daily View**: Groups records by `YYYY-MM-DD` and averages the download/upload/ping speeds.
2. **Weekly View**: Groups records by `YYYY-Www` (Year + ISO Week Number).
3. **Monthly View**: Groups records by `YYYY-MM` (Year + Month).

---

## 3. Performance & Visual Optimizations

To deliver a premium, responsive UX, several front-end optimizations are active:

1. **Chart Decimation & Easing**:
   - For line charts (Trend Chart), when the data size grows large (e.g. 1+ year of daily points, i.e., > 360 points), Chart.js animations are disabled (`duration: 0`), and line markers are hidden (`pointRadius: 0`) to bypass redundant canvas paint cycles.
   - Point decimation handles rendering over a year of daily data at a fluid 60fps.
2. **Double Canvas Speed Gauge**:
   - The speed visualizer uses two overlaying `<canvas>` tags:
     - **Particle Canvas** (Behind): Updates and draws flow particles representing active packets at 60fps.
     - **Gauge Canvas** (Front): Draws the gauge borders, text labels, and the glowing dial needle.
3. **Piece-wise Linear Needle Scale**:
   - The gauge needle does not scale linearly. Doing so would squeeze common home speeds (5 - 80 Mbps) into the first 8% of a 1Gbps gauge.
   - We map speed values to needle percentages using a piece-wise linear interpolation curve across thresholds `[0, 1, 5, 10, 50, 100, 250, 500, 1000]`. This keeps low-speed, mid-speed, and gigabit fiber tests all visually engaging and clearly readable.
4. **Native Exporter**:
   - Rather than relying on heavy HTML-to-Image libraries, the result card is drawn directly onto an off-screen HTML5 Canvas and exported as a high-resolution 960x640 `.png`. This guarantees speed, removes external package weight, and avoids CSS rendering errors.
5. **Liquid Droplet Cursor Simulation**:
   - Renders interactive fluid trails using a full-viewport `<canvas>` element layered above the UI with pointer events deactivated.
   - Droplets are drawn as dynamic ellipses `ctx.ellipse()` where the minor and major axes ($R_x, R_y$) scale dynamically based on cursor movement vectors, gravity acceleration ($g$), and random surface tension wobble harmonics:
     $$R_x = R_{\text{base}} \cdot (1 - \text{stretch}_{\text{motion}} + \text{wobble}_{\text{harmonic}})$$
     $$R_y = R_{\text{base}} \cdot (1 + \text{stretch}_{\text{motion}} - \text{wobble}_{\text{harmonic}})$$
   - Spawning quantities and initial launch speeds correlate directly to cursor velocity vectors. Individual droplet decay models apply drag coefficients and linear opacity fades to guarantee a fluid 60 FPS repaint.

