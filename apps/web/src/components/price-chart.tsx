"use client";

import { useId } from "react";

// A Polymarket-style price chart: a filled area under the Yes-probability line,
// 0-100% on the y-axis, time on the x. Used in the contestant panel's market
// block. Pure SVG, no deps; `points` is the market sparkline ([t, price]).
export function PriceChart({
  points,
  height = 96,
  className,
}: {
  points: [number, number][];
  height?: number;
  className?: string;
}) {
  const gradId = useId();
  const w = 300;
  const h = height;
  const padY = 6;
  const toY = (p: number) => padY + (1 - p) * (h - 2 * padY);

  // Always render a chart. With fewer than two points there is no history to
  // draw a slope from, so show a flat horizontal line at the single point's
  // value (or at 50% if we have nothing yet) rather than an empty placeholder.
  if (points.length < 2) {
    const y = points.length === 1 ? points[0]![1] : 0.5;
    const flatY = toY(y);
    const stroke = "#34d399";
    const area = `M0,${flatY.toFixed(1)} L${w},${flatY.toFixed(1)} L${w},${h} L0,${h} Z`;
    return (
      <svg
        className={className}
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Yes probability history, now ${Math.round(y * 100)} percent`}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* 50% guide line */}
        <line x1="0" y1={toY(0.5)} x2={w} y2={toY(0.5)} stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" strokeDasharray="3 3" />
        <path d={area} fill={`url(#${gradId})`} />
        <line x1="0" y1={flatY} x2={w} y2={flatY} stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <circle cx={w} cy={flatY} r="3.5" fill={stroke} />
      </svg>
    );
  }

  const xs = points.map((p) => p[0]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const spanX = maxX - minX || 1;
  const toX = (t: number) => ((t - minX) / spanX) * w;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const up = last[1] >= first[1];
  const stroke = up ? "#34d399" : "#fb7185";
  const lastX = toX(last[0]);
  const lastY = toY(last[1]);

  return (
    <svg
      className={className}
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Yes probability history, now ${Math.round(last[1] * 100)} percent`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* 50% guide line */}
      <line x1="0" y1={toY(0.5)} x2={w} y2={toY(0.5)} stroke="currentColor" strokeOpacity="0.12" strokeWidth="1" strokeDasharray="3 3" />
      <path d={area} fill={`url(#${gradId})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r="3.5" fill={stroke} />
    </svg>
  );
}
