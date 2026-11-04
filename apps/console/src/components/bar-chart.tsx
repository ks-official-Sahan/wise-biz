"use client";

import { bars } from "@/lib/reports.ts";

/**
 * Daily bars drawn with plain SVG (no chart library on the page). The chart is a picture of the table beneath it, which
 * is the accessible version: every value is readable there. Colours come from the console tokens, so light and dark
 * both work and the bars keep a 3:1 contrast against the card.
 */
export function BarChart({
  series,
  label,
  format,
}: {
  readonly series: readonly { day: string; minor: number }[];
  readonly label: string;
  readonly format: (minor: number) => string;
}) {
  const W = 600;
  const H = 140;
  const shape = bars(series, W, H);
  const first = series[0];
  const last = series.at(-1);
  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H + 4)}`}
        width="100%"
        role="img"
        aria-label={`${label}, ${first?.day ?? ""} to ${last?.day ?? ""}`}
        preserveAspectRatio="none"
        style={{ height: 160, display: "block" }}
      >
        <line x1="0" y1={H + 1} x2={W} y2={H + 1} stroke="var(--wb-color-border)" strokeWidth="1" />
        {shape.map((b) => (
          <rect
            key={b.day}
            x={b.x}
            y={b.y}
            width={b.w}
            height={Math.max(b.h, 1)}
            rx="2"
            fill="var(--wb-color-accent)"
          >
            <title>{`${b.day}: ${format(series.find((s) => s.day === b.day)?.minor ?? 0)}`}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="muted" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>{first?.day}</span>
        <span>{last?.day}</span>
      </figcaption>
    </figure>
  );
}
