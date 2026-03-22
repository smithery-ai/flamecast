import { type CSSProperties } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Helper to create CSS custom properties style objects without type assertions.
 * React.CSSProperties doesn't include CSS custom properties (--*) by default.
 */
export function cssVars(vars: Record<string, string | number | undefined>): CSSProperties {
  // oxlint-disable-next-line no-type-assertion/no-type-assertion
  return vars as CSSProperties;
}
