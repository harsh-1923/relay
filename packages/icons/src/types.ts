import type { SVGProps } from 'react';

/** A single SVG child element as a [tag, attributes] tuple. */
export type IconNode = [tag: string, attrs: Record<string, string | number>][];

/** The five icon render styles. */
export const ICON_STYLES = ['Stroke', 'Solid', 'Contrast', 'Duo Stroke', 'Duo Solid'] as const;
export type IconStyle = (typeof ICON_STYLES)[number];

/** An icon's shape data, keyed by style. */
export type IconVariants = Record<IconStyle, IconNode>;

/**
 * `size`: width & height in px (or any CSS length). Default 24.
 * `color`: icon color. Sets CSS `color`, which `currentColor` resolves to. Default: inherit.
 * `strokeWidth`: stroke width for stroked styles. Default 2.
 * `absoluteStrokeWidth`: keep stroke visually constant regardless of `size`.
 * `variant`: which style variant to render. Default "Stroke".
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string;
  color?: string;
  strokeWidth?: number | string;
  absoluteStrokeWidth?: boolean;
  variant?: IconStyle;
}
