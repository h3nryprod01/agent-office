// The chest badge: a persona's avatar when it has one, otherwise the harness mark.
// One 64px canvas per character, drawn once (and again if an avatar image lands) —
// not part of the per-frame repaint budget.

import type { AgentLook } from "./look";
import { avatarIsImage } from "./look";

const css = (n: number): string => "#" + n.toString(16).padStart(6, "0");
export const BADGE_PX = 64;

/** images are cached by URL: ten agents sharing one avatar fetch it once */
const images = new Map<string, HTMLImageElement | "loading" | "failed">();
/** everyone who asked for an image while it was still loading — all repaint when it lands */
const waiting = new Map<string, Set<() => void>>();

/** user-perceived characters (an emoji family is one), at most `n` */
function graphemes(s: string, n: number): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new () => { segment(x: string): Iterable<{ segment: string }> } }).Segmenter;
  const all = Seg ? [...new Seg().segment(s)].map((g) => g.segment) : [...s];
  return all.slice(0, n);
}

/** Draw the badge. `onImage` fires when an avatar image finishes loading so the caller can repaint. */
export function drawBadge(ctx: CanvasRenderingContext2D, look: AgentLook, onImage?: () => void): void {
  const S = BADGE_PX, r = S / 2;
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = "rgba(10,14,22,.92)";
  ctx.beginPath(); ctx.arc(r, r, r - 2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = css(look.trim); ctx.lineWidth = 4; ctx.stroke();

  const avatar = look.persona?.avatar?.trim();
  if (avatar && avatarIsImage(avatar)) {
    const c = images.get(avatar);
    if (c && c !== "loading" && c !== "failed") {
      ctx.save();
      ctx.beginPath(); ctx.arc(r, r, r - 5, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(c, 5, 5, S - 10, S - 10);
      ctx.restore();
      return;
    }
    if (c !== "failed" && onImage) {
      const set = waiting.get(avatar) ?? new Set<() => void>();
      set.add(onImage);
      waiting.set(avatar, set);
    }
    if (!c) {
      images.set(avatar, "loading");
      const img = new Image();
      img.crossOrigin = "anonymous"; // set before src, so a drawn image can never taint the canvas
      const done = (v: HTMLImageElement | "failed"): void => {
        images.set(avatar, v);
        const set = waiting.get(avatar);
        waiting.delete(avatar);
        if (v !== "failed") set?.forEach((f) => f());
      };
      img.onload = () => done(img);
      img.onerror = () => done("failed");
      img.src = avatar;
    }
    // loading or failed: fall through to the harness mark — never a blank badge
  } else if (avatar) {
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const glyphs = graphemes(avatar, 2); // an emoji can be several code points; two characters max
    ctx.font = `${glyphs.length > 1 ? 24 : 34}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.fillText(glyphs.join(""), r, r + 2);
    return;
  }
  drawMark(ctx, look, r);
}

/** the harness mark, drawn as shapes so it never depends on a font having the glyph */
function drawMark(ctx: CanvasRenderingContext2D, look: AgentLook, r: number): void {
  const col = css(look.trim);
  ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineCap = "round"; ctx.lineJoin = "round";
  switch (look.family) {
    case "claude": // eight-ray burst
      ctx.lineWidth = 5;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ctx.beginPath(); ctx.moveTo(r + Math.cos(a) * 6, r + Math.sin(a) * 6); ctx.lineTo(r + Math.cos(a) * 20, r + Math.sin(a) * 20); ctx.stroke();
      }
      break;
    case "codex": // < / >
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(r - 6, r - 12); ctx.lineTo(r - 18, r); ctx.lineTo(r - 6, r + 12); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r + 6, r - 12); ctx.lineTo(r + 18, r); ctx.lineTo(r + 6, r + 12); ctx.stroke();
      break;
    case "gemini": // four-point sparkle
      ctx.beginPath();
      ctx.moveTo(r, r - 22); ctx.quadraticCurveTo(r, r, r + 22, r); ctx.quadraticCurveTo(r, r, r, r + 22);
      ctx.quadraticCurveTo(r, r, r - 22, r); ctx.quadraticCurveTo(r, r, r, r - 22); ctx.fill();
      break;
    case "hermes": // wing + bar
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(r, r + 18); ctx.lineTo(r, r - 14); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r, r - 6); ctx.quadraticCurveTo(r - 22, r - 20, r - 22, r - 4); ctx.moveTo(r, r - 6); ctx.quadraticCurveTo(r + 22, r - 20, r + 22, r - 4); ctx.stroke();
      break;
    case "claude-worker": { // hex nut with the lane's initial
      ctx.beginPath();
      for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3 + Math.PI / 6; ctx.lineTo(r + Math.cos(a) * 22, r + Math.sin(a) * 22); }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#0d1117"; ctx.font = "bold 26px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(look.glyph || "W", r, r + 2);
      break;
    }
    default: // unknown harness: a plain dot, so the badge never lies
      ctx.beginPath(); ctx.arc(r, r, 8, 0, Math.PI * 2); ctx.fill();
  }
}
