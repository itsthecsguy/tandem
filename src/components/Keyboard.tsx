import { type CSSProperties, useMemo } from "react";

import { describeBinding, keyFace, parseBinding, targetLayer } from "../../shared/bindings";
import type { LayoutKey } from "../../shared/types";
import { layerColor } from "../lib/layers";
import { fitFont } from "../lib/text";

const U = 56;
const GAP = 5;

/** Bindings for drawing plain, solid keys, as in an outline of the keyboard. */
export const PLAIN_KEYS: string[] = new Array(128).fill("&kp A");

interface Props {
  layout: LayoutKey[];
  bindings: string[];
  layerNames: string[];
  selected?: number | null;
  /** Keys to point at, e.g. in the setup guide or while hovering a layer. */
  highlight?: number[];
  highlightColor?: string;
  /** Keys held down to reach this layer, drawn in the layer's color. */
  held?: number[];
  heldColor?: string;
  /** Bindings a transparent key falls through to, usually the base layer. */
  fallback?: string[];
  changed?: Set<number>;
  /** A key that was just pressed on the keyboard, briefly marked. */
  pressed?: number | null;
  onSelect?: (index: number) => void;
  /** Small, unlabeled drawing. Keys in `labels` still get a label. */
  compact?: boolean;
  labels?: Record<number, string>;
}

function corners(k: LayoutKey): [number, number][] {
  const pts: [number, number][] = [
    [k.x, k.y],
    [k.x + k.w, k.y],
    [k.x, k.y + k.h],
    [k.x + k.w, k.y + k.h],
  ];
  if (!k.r) return pts;
  const a = (k.r * Math.PI) / 180;
  return pts.map(([x, y]) => {
    const dx = x - k.rx;
    const dy = y - k.ry;
    return [k.rx + dx * Math.cos(a) - dy * Math.sin(a), k.ry + dx * Math.sin(a) + dy * Math.cos(a)];
  });
}


export function Keyboard({
  layout,
  bindings,
  layerNames,
  selected,
  highlight = [],
  highlightColor,
  held = [],
  heldColor,
  fallback,
  changed,
  pressed,
  onSelect,
  compact,
  labels,
}: Props) {
  const box = useMemo(() => {
    const all = layout.flatMap(corners);
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const pad = 0.15;
    return {
      x: (Math.min(...xs) - pad) * U,
      y: (Math.min(...ys) - pad) * U,
      w: (Math.max(...xs) - Math.min(...xs) + pad * 2) * U,
      h: (Math.max(...ys) - Math.min(...ys) + pad * 2) * U,
    };
  }, [layout]);

  return (
    <svg
      className={`keyboard${compact ? " keyboard--compact" : ""}`}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      role="group"
      aria-label="Keyboard layout"
    >
      {layout.map((k) => {
        const binding = parseBinding(bindings[k.index] ?? "&none");
        const face = keyFace(binding, layerNames);
        const through = binding.kind === "trans" && fallback ? keyFace(parseBinding(fallback[k.index] ?? "&none"), layerNames) : null;
        const target = targetLayer(binding);
        const holdColor = target !== null ? layerColor(target) : undefined;

        const isSelected = selected === k.index;
        const isHighlighted = highlight.includes(k.index);
        const isHeld = held.includes(k.index);
        const x = k.x * U + GAP / 2;
        const y = k.y * U + GAP / 2;
        const w = k.w * U - GAP;
        const h = k.h * U - GAP;
        const cls = [
          "key",
          isSelected && "key--selected",
          isHighlighted && "key--highlight",
          isHeld && "key--held",
          face.muted && "key--muted",
          through && "key--through",
          changed?.has(k.index) && "key--changed",
          pressed === k.index && "key--pressed",
          onSelect && "key--interactive",
        ]
          .filter(Boolean)
          .join(" ");

        const tap = through ? through.tap : face.tap;
        const hold = through ? undefined : face.hold;
        const holdY = y + h - 9;
        const tapY = hold ? y + h / 2 - 3 : y + h / 2 + 1;
        const style = {
          "--hl": isHighlighted ? highlightColor : undefined,
          "--held": isHeld ? heldColor : undefined,
        } as CSSProperties;

        return (
          <g
            key={k.index}
            className={cls}
            style={style}
            transform={k.r ? `rotate(${k.r} ${k.rx * U} ${k.ry * U})` : undefined}
            onClick={onSelect ? () => onSelect(k.index) : undefined}
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
            aria-label={describeBinding(binding, layerNames)}
            aria-pressed={onSelect ? isSelected : undefined}
            onKeyDown={
              onSelect
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(k.index);
                    }
                  }
                : undefined
            }
          >
            {!compact && <title>{describeBinding(binding, layerNames)}</title>}
            <rect className="key__shadow" x={x} y={y + 1.5} width={w} height={h} rx={9} />
            <rect className="key__cap" x={x} y={y} width={w} height={h} rx={9} />
            {compact && labels?.[k.index] && (
              <text className="key__tap" x={x + w / 2} y={y + h / 2 + 1} fontSize={15}>
                {labels[k.index]}
              </text>
            )}
            {!compact && (
              <>
                <text className="key__tap" x={x + w / 2} y={tapY} fontSize={fitFont(tap, 17, w - 14)}>
                  {tap}
                </text>
                {hold && (
                  <text
                    className="key__hold"
                    x={x + w / 2}
                    y={holdY}
                    fontSize={fitFont(hold, 10, w - 12)}
                    style={holdColor ? { fill: holdColor } : undefined}
                  >
                    {hold}
                  </text>
                )}
                {holdColor && <rect className="key__layer-bar" x={x + 9} y={y + h - 3.5} width={w - 18} height={2} rx={1} style={{ fill: holdColor }} />}
                {face.repeat && !through && (
                  <g className="key__repeat" transform={`translate(${x + w - 12} ${y + 11})`}>
                    <circle r={6.5} />
                    <text y={0.5}>2×</text>
                  </g>
                )}
                {changed?.has(k.index) && <circle className="key__changed-dot" cx={x + 9} cy={y + 9} r={3} />}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
