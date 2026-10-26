# L8 visual — before / after

Captured from `?mock=1` (fake data only). Headless Chrome, Apple M3 Max, 1440×900 @2x,
vsync off (`--disable-frame-rate-limit`) so the number is frame cost, not the display cap.

| Scene | Before (HEAD 3b01230) | After L8 |
|---|---|---|
| `?stress=30` (36 agents, 11 on screen) | 360–389 fps · p50 2.3–2.6 ms | 271–352 fps · p50 2.6–3.6 ms |
| `?stress=30` + 30 walk-in characters | 281–314 fps · p50 3.0–3.3 ms | 222–247 fps · p50 3.8–4.4 ms |

Runs alternated before/after three times; budget is ≥ 55 fps. With vsync on both sit at the display cap.

- `before-stress30.jpg` — the office as it was.
- `after-dev-day.jpg`, `after-dev-night.jpg` — dev floor at 10:00 and 21:30 (`?hour=`).
- `after-studio-dusk.jpg` — content-studio room at 17:36 (`?room=studio`).
- `after-estate-noon.jpg` — real-estate sales floor (`?room=estate`).
- `after-zoom-agents.jpg` — uniforms by harness / worker lane, walk and seated poses.
- `hover-rack.jpg`, `hover-lift.jpg` — hover names a clickable place.
