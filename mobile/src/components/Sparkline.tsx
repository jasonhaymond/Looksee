// A small line chart (no axes) of a series of numbers, e.g. a check's response
// time over the last day, with the lowest and highest values labelled so the
// line has a scale. Gaps (null) break the line. Drawn with react-native-svg.

import { useState } from "react";
import { View } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { useTheme } from "../lib/theme";
import { T } from "./ui";

/** @param values the points in time order; @param unit appended to the min/max labels */
export function Sparkline({ values, unit = "", height = 70 }: { values: (number | null)[]; unit?: string; height?: number }) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <T size="s" muted>Not enough data for a chart yet.</T>;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  // Splits the series into runs without gaps; each run is one polyline.
  const runs: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (current.length) runs.push(current.join(" "));
      current = [];
      return;
    }
    const x = (i / (values.length - 1)) * width;
    const y = height - 4 - ((v - min) / span) * (height - 8);
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length) runs.push(current.join(" "));
  const fmt = (n: number) => `${Math.abs(n) >= 100 ? Math.round(n) : Number(n.toFixed(2))}${unit}`;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 ? (
        <Svg width={width} height={height}>
          {runs.map((points, i) => (
            <Polyline key={i} points={points} fill="none" stroke={colors.series} strokeWidth={2} />
          ))}
        </Svg>
      ) : (
        <View style={{ height }} />
      )}
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <T size="s" muted>low {fmt(min)}</T>
        <T size="s" muted>high {fmt(max)}</T>
      </View>
    </View>
  );
}
