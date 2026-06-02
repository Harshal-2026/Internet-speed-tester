# AI Declaration & Development Prompts

This document lists the AI assistant declaration and prompts used to construct the AeroSpeed Speed Test Visualizer.

---

## AI Assistant Declaration

- **Agent Name**: Antigravity
- **Creator**: Google DeepMind Team
- **Model**: Gemini 3.5 Flash (Medium)
- **Role**: Agentic AI pair-programming assistant specialized in clean architectures, premium modern aesthetics, and standard-compliant web development.

---

## Development Prompts Sequence

Below are the core system guides and prompt structures used during the lifecycle of this project:

### 1. Goal Formulation
The prompt set by the user:
> Build a beautiful internet speed test tool like Fast.com but with memory — it tracks your speed history and visualizes it with stunning charts. Measure download speed, upload speed, and ping/latency with a single click.
> ... Include animated speed gauge, IndexedDB persistence, daily/weekly/monthly line charts, ISP average comparison, time of day heatmap analysis, and shareable results card.

### 2. Styling Instructions
- Dark mode theme utilizing cyber-neon glow accents (deep slate `#070913` with glassmorphic cards and border gradients).
- Logarithmic piece-wise interpolation for the gauge needle to keep both DSL speeds and Gigabit speeds readable.
- Dual canvas architecture separating particle flows from dial/needle calculations to optimize layout repaints.

### 3. Engine Design
- Implementing sequential HEAD fetches for Ping/Jitter calculations.
- Chunked fetch streams for download tests with size escalation and a hard 70MB transfer ceiling.
- Uint8Array payload uploads with a hard 25MB ceiling to ensure total test footprint remains below 100MB.
- Dynamic fail-safe simulation triggers to ensure full system testability in isolated development environments.
