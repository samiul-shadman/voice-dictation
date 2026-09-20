import type { ReactNode } from "react";
import { fmtClock } from "../format";

export interface RecordingStyleArgs {
  elapsed: number;
  level: number;
}

export interface TranscriptionStyleArgs {
  percent: number;
}

export interface RecordingStyleEntry {
  id: string;
  name: string;
  desc: string;
  render: (args: RecordingStyleArgs) => ReactNode;
}

export interface TranscriptionStyleEntry {
  id: string;
  name: string;
  desc: string;
  render: (args: TranscriptionStyleArgs) => ReactNode;
}

const ANIM_CSS = `
@keyframes vd-spin { to { transform: rotate(360deg); } }
@keyframes vd-spin-rev { to { transform: rotate(-360deg); } }
@keyframes vd-rec-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.82); }
}
@keyframes vd-halo-fade { 0% { opacity: 0.6; } 100% { opacity: 0; } }
@keyframes vd-wave {
  0%, 100% { transform: scaleY(0.35); }
  50% { transform: scaleY(1); }
}
@keyframes vd-ripple {
  0% { transform: scale(0.3); opacity: 0.55; }
  75% { opacity: 0; }
  100% { transform: scale(2.1); opacity: 0; }
}
@keyframes vd-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes vd-ecg-sweep { from { stroke-dashoffset: 96; } to { stroke-dashoffset: 0; } }
@keyframes vd-sheen-sweep { from { transform: translateX(-110%); } to { transform: translateX(240%); } }
@keyframes vd-bar-sheen { from { background-position: -48px 0; } to { background-position: 120px 0; } }
@keyframes vd-dot-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
  40% { transform: translateY(-5px); opacity: 1; }
}
@keyframes vd-skel { from { background-position: -64px 0; } to { background-position: 64px 0; } }
@keyframes vd-glow-pulse { 0%, 100% { filter: brightness(0.85); } 50% { filter: brightness(1.3); } }
@keyframes vd-caret-blink { 0%, 45% { opacity: 1; } 50%, 100% { opacity: 0; } }

.vd-rec-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--rec);
  animation: vd-rec-pulse 1.4s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}
.vd-halo-ring {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  border: 1.5px solid var(--rec);
  opacity: 0;
  animation: vd-halo-fade 1.7s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}
.vd-delay-1 { animation-delay: 0.55s; }
.vd-delay-2 { animation-delay: 1.1s; }
.vd-wave-bar {
  width: 3px;
  height: 22px;
  border-radius: 999px;
  background: var(--rec);
  opacity: 0.85;
  animation: vd-wave 1.1s ease-in-out infinite;
}
.vd-ripple-ring {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--rec);
  opacity: 0;
  animation: vd-ripple 2.1s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}
.vd-orbit-fast { animation: vd-spin 1.6s linear infinite; }
.vd-orbit-slow { animation: vd-spin-rev 2.4s linear infinite; }
.vd-orb {
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: radial-gradient(circle at 35% 30%, #fda4af, var(--rec) 70%);
  box-shadow: 0 0 12px rgba(244, 63, 94, 0.45);
  animation: vd-breathe 2.6s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}
.vd-ecg-base { stroke: var(--rec); stroke-width: 1.5; opacity: 0.22; fill: none; }
.vd-ecg-pulse {
  stroke: var(--rec);
  stroke-width: 1.6;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 27 69;
  animation: vd-ecg-sweep 1.7s linear infinite;
}
.vd-eq-bar {
  display: block;
  width: 4px;
  border-radius: 999px;
  background: var(--rec);
  transform-origin: center;
}
/* sweep rotates via transform; @property does not animate in the webview */
.vd-sonar-sweep {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: conic-gradient(from 0deg, rgba(244, 63, 94, 0.45), rgba(244, 63, 94, 0) 60deg);
  animation: vd-spin 2.2s linear infinite;
  mask: radial-gradient(circle, transparent 26%, #000 28%);
  -webkit-mask: radial-gradient(circle, transparent 26%, #000 28%);
}
.vd-shimmer-sweep {
  position: absolute;
  top: -25%;
  bottom: -25%;
  left: 0;
  width: 40%;
  background: linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.15), transparent);
  animation: vd-sheen-sweep 2.3s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}
.vd-bounce-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--accent);
  animation: vd-dot-bounce 1.1s ease-in-out infinite;
}
.vd-spinner {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid rgba(139, 124, 247, 0.25);
  border-top-color: var(--accent);
  animation: vd-spin 0.9s linear infinite;
}
.vd-bar-fill {
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 25%, rgba(255, 255, 255, 0.45) 50%, transparent 75%);
  animation: vd-sheen-sweep 1.6s linear infinite;
}
.vd-bar-sheen {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(100deg, transparent 25%, rgba(255, 255, 255, 0.35) 50%, transparent 75%);
  background-size: 48px 100%;
  background-repeat: no-repeat;
  animation: vd-bar-sheen 1.4s linear infinite;
}
.vd-skel-line {
  display: block;
  height: 6px;
  border-radius: 4px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.07) 25%, rgba(255, 255, 255, 0.16) 50%, rgba(255, 255, 255, 0.07) 75%);
  background-size: 64px 100%;
  animation: vd-skel 1.3s linear infinite;
}
.vd-glow-orb {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: radial-gradient(circle at 35% 30%, #c4b5fd, var(--accent) 70%);
  box-shadow: 0 0 14px rgba(139, 124, 247, 0.55);
  animation: vd-glow-pulse 1.8s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
}
.vd-slide-head {
  position: absolute;
  top: 50%;
  width: 8px;
  height: 8px;
  margin: -4px 0 0 -4px;
  border-radius: 999px;
  background: var(--accent-strong);
  box-shadow: 0 0 8px rgba(167, 155, 255, 0.8);
  transition: left 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.vd-caret {
  width: 2px;
  height: 14px;
  margin-left: 2px;
  border-radius: 1px;
  background: var(--accent-strong);
  animation: vd-caret-blink 1s steps(1) infinite;
}
.vd-ring-outer {
  position: relative;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  border: 2px solid rgba(139, 124, 247, 0.2);
  border-top-color: var(--accent);
  animation: vd-spin 1.1s linear infinite;
}
.vd-ring-inner {
  position: absolute;
  inset: 4px;
  border-radius: 999px;
  border: 2px solid rgba(244, 63, 94, 0.2);
  border-bottom-color: var(--rec);
  animation: vd-spin-rev 1.5s linear infinite;
}
`;

const STYLE_TAG_ID = "vd-anim-styles";

function injectStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_TAG_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_TAG_ID;
  tag.textContent = ANIM_CSS;
  document.head.appendChild(tag);
}

injectStyles();

const MONO_CLS = "font-mono text-[13px] tabular-nums text-text";
const REC_LABEL_CLS = "text-[11px] font-semibold tracking-[0.12em] text-rec";
const ECG_PATH = "M0 12 H14 L18 4 L24 20 L28 12 H40 L44 7 L48 17 L52 12 H64";

const LEVEL_BARS = [5, 9, 13, 16, 13, 9, 12, 16, 12, 8, 11, 7];
const WAVE_DELAYS = [0, 130, 260, 390, 260, 130, 0];
const EQ_BARS = [20, 28, 38, 24, 32];
const CURSOR_SEGMENTS = 8;
const RING_RADIUS = 11;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;

const clampPercent = (percent: number): number => Math.max(0, Math.min(100, percent));

const classicRecording: RecordingStyleEntry = {
  id: "classic",
  name: "Classic",
  desc: "Pulsing REC dot, mono timer and 12 live mic-level bars.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-2.5">
      <span className="vd-rec-dot" aria-hidden />
      <span className={REC_LABEL_CLS}>REC</span>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
      <span className="flex items-end gap-[2px]" aria-hidden>
        {LEVEL_BARS.map((mult, i) => (
          <span
            key={i}
            className="w-[3px] rounded-pill bg-rec"
            style={{ height: `calc(4px + var(--voice-level, 0) * ${mult}px)` }}
          />
        ))}
      </span>
    </div>
  ),
};

const pulseHalo: RecordingStyleEntry = {
  id: "pulse-halo",
  name: "Pulse halo",
  desc: "Radiating halo rings whose reach follows the mic level.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-3">
      <span
        className="relative block h-7 w-7"
        style={{ transform: "scale(calc(0.7 + var(--voice-level, 0) * 0.5))" }}
        aria-hidden
      >
        <span className="vd-halo-ring" />
        <span className="vd-halo-ring vd-delay-1" />
        <span className="vd-halo-ring vd-delay-2" />
        <span className="absolute inset-[9px] rounded-full bg-rec" />
      </span>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
    </div>
  ),
};

const waveBars: RecordingStyleEntry = {
  id: "wave-bars",
  name: "Wave bars",
  desc: "Smooth sine wave bars, amplitude scaled by the mic level.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-3">
      <span
        className="flex h-7 items-center gap-[3px]"
        style={{ transform: "scaleY(calc(0.35 + var(--voice-level, 0) * 0.65))" }}
        aria-hidden
      >
        {WAVE_DELAYS.map((delay, i) => (
          <span key={i} className="vd-wave-bar" style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
    </div>
  ),
};

const ripple: RecordingStyleEntry = {
  id: "ripple",
  name: "Ripple",
  desc: "Concentric rings expanding outward with the mic level.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-3">
      <span
        className="relative block h-7 w-7"
        style={{ transform: "scale(calc(0.75 + var(--voice-level, 0) * 0.45))" }}
        aria-hidden
      >
        <span className="vd-ripple-ring" />
        <span className="vd-ripple-ring vd-delay-1" />
        <span className="vd-ripple-ring vd-delay-2" />
        <span className="absolute inset-[10px] rounded-full bg-rec" />
      </span>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
    </div>
  ),
};

const orbit: RecordingStyleEntry = {
  id: "orbit",
  name: "Orbit",
  desc: "Two dots circling a track, cluster size tied to the level.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-3">
      <span
        className="relative block h-7 w-7"
        style={{ transform: "scale(calc(0.85 + var(--voice-level, 0) * 0.3))" }}
        aria-hidden
      >
        <span className="absolute inset-0 rounded-full border border-rec/30" />
        <span className="vd-orbit-fast absolute inset-0">
          <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-rec shadow-[0_0_6px_var(--rec)]" />
        </span>
        <span className="vd-orbit-slow absolute inset-[5px]">
          <span className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 rounded-full bg-rec/70" />
        </span>
      </span>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
    </div>
  ),
};

const breathingOrb: RecordingStyleEntry = {
  id: "breathing-orb",
  name: "Breathing orb",
  desc: "A softly glowing orb that breathes with the mic level.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-3">
      <span
        className="vd-orb"
        style={{ transform: "scale(calc(0.7 + var(--voice-level, 0) * 0.55))" }}
        aria-hidden
      />
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
    </div>
  ),
};

const ecg: RecordingStyleEntry = {
  id: "ecg",
  name: "ECG",
  desc: "Heart-monitor trace with a sweeping pulse highlight.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-3">
      <svg
        width="64"
        height="24"
        viewBox="0 0 64 24"
        aria-hidden
        style={{ transform: "scaleY(calc(0.55 + var(--voice-level, 0) * 0.45))" }}
      >
        <path className="vd-ecg-base" d={ECG_PATH} />
        <path className="vd-ecg-pulse" d={ECG_PATH} />
      </svg>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
    </div>
  ),
};

const equalizer: RecordingStyleEntry = {
  id: "equalizer",
  name: "Equalizer",
  desc: "Bouncy equalizer bars whose heights follow the mic level.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-3">
      <span className="flex h-7 items-center gap-[3px]" aria-hidden>
        {EQ_BARS.map((mult, i) => (
          <span
            key={i}
            className="vd-eq-bar"
            style={{ height: `min(25px, calc(3px + var(--voice-level, 0) * ${mult}px))` }}
          />
        ))}
      </span>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
    </div>
  ),
};

const sonar: RecordingStyleEntry = {
  id: "sonar",
  name: "Sonar",
  desc: "Radar sweep with expanding pings, gain tied to the level.",
  render: ({ elapsed }) => (
    <div className="flex items-center gap-3">
      <span
        className="relative block h-7 w-7"
        style={{ transform: "scale(calc(0.85 + var(--voice-level, 0) * 0.3))" }}
        aria-hidden
      >
        <span className="absolute inset-0 rounded-full border border-rec/25" />
        <span className="vd-ripple-ring" />
        <span className="vd-sonar-sweep" />
        <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rec" />
      </span>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
    </div>
  ),
};

const shimmer: RecordingStyleEntry = {
  id: "shimmer",
  name: "Shimmer",
  desc: "A soft sheen sweeping the pill, brightness follows the level.",
  render: ({ elapsed }) => (
    <div className="relative flex items-center gap-2.5 overflow-hidden">
      <span className="vd-rec-dot" aria-hidden />
      <span className={REC_LABEL_CLS}>REC</span>
      <span className={MONO_CLS}>{fmtClock(elapsed)}</span>
      <span
        className="vd-shimmer-sweep"
        style={{ opacity: "calc(0.25 + var(--voice-level, 0) * 0.55)" }}
        aria-hidden
      />
    </div>
  ),
};

const classicTranscription: TranscriptionStyleEntry = {
  id: "classic",
  name: "Classic",
  desc: "Spinner plus a shimmering progress bar and percent readout.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-2.5">
        <span className="vd-spinner" aria-hidden />
        <span className="relative h-1 w-24 overflow-hidden rounded-pill bg-white/10">
          <span className="absolute inset-y-0 left-0 rounded-pill bg-accent" style={{ width: `${p}%` }} />
          <span className="vd-bar-sheen" aria-hidden />
        </span>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const dots: TranscriptionStyleEntry = {
  id: "dots",
  name: "Dots",
  desc: "Three bouncing dots beside the live percent.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-3">
        <span className="flex items-end gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="vd-bounce-dot" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </span>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const shimmerBar: TranscriptionStyleEntry = {
  id: "shimmer-bar",
  name: "Shimmer bar",
  desc: "Wide bar filling with a shimmering sweep as work proceeds.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-2.5">
        <span className="relative h-2 w-32 overflow-hidden rounded-pill bg-white/10">
          <span
            className="absolute inset-y-0 left-0 overflow-hidden rounded-pill bg-accent"
            style={{ width: `${p}%` }}
          >
            <span className="vd-bar-fill" />
          </span>
        </span>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const skeleton: TranscriptionStyleEntry = {
  id: "skeleton",
  name: "Skeleton",
  desc: "Shimmering skeleton lines hinting at incoming text.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-2.5">
        <span className="flex flex-col gap-1" aria-hidden>
          <span className="vd-skel-line w-20" />
          <span className="vd-skel-line w-14" style={{ animationDelay: "150ms" }} />
          <span className="vd-skel-line w-24" style={{ animationDelay: "300ms" }} />
        </span>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const pulseGlow: TranscriptionStyleEntry = {
  id: "pulse-glow",
  name: "Pulse glow",
  desc: "A glowing orb that swells and brightens with progress.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-3">
        <span
          className="vd-glow-orb"
          style={{ transform: `scale(${(0.75 + (p / 100) * 0.45).toFixed(3)})` }}
          aria-hidden
        />
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const dualOrbit: TranscriptionStyleEntry = {
  id: "dual-orbit",
  name: "Dual orbit",
  desc: "Two counter-rotating orbit dots around the percent.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-3">
        <span className="relative block h-7 w-7" aria-hidden>
          <span className="absolute inset-0 rounded-full border border-accent/20" />
          <span className="vd-orbit-fast absolute inset-0">
            <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-accent" />
          </span>
          <span className="vd-orbit-slow absolute inset-[4px]">
            <span className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 rounded-full bg-accent-strong" />
          </span>
        </span>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const ring: TranscriptionStyleEntry = {
  id: "ring",
  name: "Ring",
  desc: "Circular gauge tracing the real percent via dash offset.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-3">
        {/* SVG attrs can't take var(); stroke goes through inline style, dash offset is the real percent */}
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden style={{ transform: "rotate(-90deg)" }}>
          <circle
            cx="14"
            cy="14"
            r={RING_RADIUS}
            fill="none"
            style={{ stroke: "rgba(139, 124, 247, 0.2)", strokeWidth: 2.5 }}
          />
          <circle
            cx="14"
            cy="14"
            r={RING_RADIUS}
            fill="none"
            strokeLinecap="round"
            style={{
              stroke: "var(--accent)",
              strokeWidth: 2.5,
              strokeDasharray: RING_CIRC,
              strokeDashoffset: RING_CIRC * (1 - p / 100),
              transition: "stroke-dashoffset 250ms cubic-bezier(0.2, 0.8, 0.2, 1)",
            }}
          />
        </svg>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const slideBar: TranscriptionStyleEntry = {
  id: "slide-bar",
  name: "Slide bar",
  desc: "A glowing head sliding along the track with progress.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-2.5">
        <span className="relative h-1.5 w-28 rounded-pill bg-white/10">
          <span
            className="absolute inset-y-0 left-0 rounded-pill bg-accent/70"
            style={{ width: `${p}%` }}
          />
          <span className="vd-slide-head" style={{ left: `${p}%` }} aria-hidden />
        </span>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const cursor: TranscriptionStyleEntry = {
  id: "cursor",
  name: "Cursor",
  desc: "Blinking caret typing its way through the percent.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    const filled = Math.ceil((p / 100) * CURSOR_SEGMENTS);
    return (
      <div className="flex items-center gap-2.5">
        <span className="flex items-center gap-[2px]" aria-hidden>
          {Array.from({ length: CURSOR_SEGMENTS }, (_, i) => (
            <span
              key={i}
              className="h-1.5 w-[5px] rounded-[2px]"
              style={{ background: i < filled ? "var(--accent)" : "rgba(255, 255, 255, 0.12)" }}
            />
          ))}
          <span className="vd-caret" />
        </span>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

const doubleRing: TranscriptionStyleEntry = {
  id: "double-ring",
  name: "Double ring",
  desc: "Two counter-rotating rings circling the percent.",
  render: ({ percent }) => {
    const p = clampPercent(percent);
    return (
      <div className="flex items-center gap-3">
        <span className="vd-ring-outer" aria-hidden>
          <span className="vd-ring-inner" />
        </span>
        <span className={MONO_CLS}>{Math.round(p)}%</span>
      </div>
    );
  },
};

export const recordingStyles: RecordingStyleEntry[] = [
  classicRecording,
  pulseHalo,
  waveBars,
  ripple,
  orbit,
  breathingOrb,
  ecg,
  equalizer,
  sonar,
  shimmer,
];

export const transcriptionStyles: TranscriptionStyleEntry[] = [
  classicTranscription,
  dots,
  shimmerBar,
  skeleton,
  pulseGlow,
  dualOrbit,
  ring,
  slideBar,
  cursor,
  doubleRing,
];

export function getRecordingStyle(id: string): RecordingStyleEntry {
  return recordingStyles.find((s) => s.id === id) ?? classicRecording;
}

export function getTranscriptionStyle(id: string): TranscriptionStyleEntry {
  return transcriptionStyles.find((s) => s.id === id) ?? classicTranscription;
}
