// A minimal inline trend line — no axes/gridlines (the sparkline convention:
// the shape carries the story, not exact values) and no hover layer, since
// the tile already surfaces the one number that matters (latest latency) as
// text next to it. Per the dataviz skill's stat-tile contract: 2px line,
// round join/cap, single hue.
export function Sparkline({ values, color, width = 72, height = 20 }: { values: number[]; color: string; width?: number; height?: number }) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const pad = 2; // keeps the 2px stroke from clipping at the top/bottom edge

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = pad + (1 - (v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} role="img" aria-label={`Latency trend, ${values[0]}ms to ${values[values.length - 1]}ms`}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
