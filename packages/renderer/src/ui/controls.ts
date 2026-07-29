import type { MockEventSource } from "../events/MockEventSource";

const SPEEDS = [0.5, 1, 2, 4];

/**
 * Plain-DOM playback controls for the mock source: Play/Pause, speed,
 * Restart, progress + FPS readout. Not rendered inside the Pixi canvas
 * on purpose — this panel disappears once the real pipeline is wired in.
 */
export function mountControls(
  root: HTMLElement,
  source: MockEventSource,
  onRestart: () => void,
  getFps: () => number,
): void {
  root.innerHTML = `
    <button id="btn-play"></button>
    <span class="speeds">${SPEEDS.map(
      (s) => `<button class="btn-speed" data-speed="${s}">${s}x</button>`,
    ).join("")}</span>
    <button id="btn-restart">↺ Restart</button>
    <span id="progress"></span>
    <span id="fps"></span>
  `;

  const playBtn = root.querySelector<HTMLButtonElement>("#btn-play")!;
  const progress = root.querySelector<HTMLElement>("#progress")!;
  const fpsEl = root.querySelector<HTMLElement>("#fps")!;

  playBtn.addEventListener("click", () => source.toggle());
  root.querySelector("#btn-restart")!.addEventListener("click", () => {
    onRestart();
    source.restart();
    source.play();
  });
  for (const btn of root.querySelectorAll<HTMLButtonElement>(".btn-speed")) {
    btn.addEventListener("click", () => source.setSpeed(Number(btn.dataset.speed)));
  }

  source.onProgress = ({ simTimeMs, durationMs, playing, speed }) => {
    playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
    progress.textContent = `${(simTimeMs / 1000).toFixed(1)}s / ${(durationMs / 1000).toFixed(0)}s`;
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".btn-speed")) {
      btn.classList.toggle("active", Number(btn.dataset.speed) === speed);
    }
  };

  setInterval(() => {
    fpsEl.textContent = `${Math.round(getFps())} fps`;
  }, 500);
}
