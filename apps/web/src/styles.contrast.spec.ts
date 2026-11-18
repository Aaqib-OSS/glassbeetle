/// <reference types="node" />

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

interface Color {
  rgb: Rgb;
  alpha: number;
}

const styles = readFileSync('src/styles.scss', 'utf8');

const COLOR = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*(\d+)%\s*\)/g;

const THEMES = ['light', 'dark'] as const;
const FILLS = [
  { name: 'clear', token: 'gb-glass-clear' },
  { name: 'regular', token: 'gb-glass-regular' },
  { name: 'thick', token: 'gb-glass-thick' },
] as const;
const DESKTOPS = [
  { name: 'black', rgb: [0, 0, 0] as Rgb },
  { name: 'mid grey', rgb: [128, 128, 128] as Rgb },
  { name: 'white', rgb: [255, 255, 255] as Rgb },
];

type Theme = (typeof THEMES)[number];

function parseColor(value: string, label: string): Color {
  const match = value.match(new RegExp(COLOR.source));
  if (!match) {
    throw new Error(`Could not read a colour from ${label}: ${value}`);
  }

  const [, r, g, b, alpha] = match;
  return { rgb: [Number(r), Number(g), Number(b)], alpha: Number(alpha) / 100 };
}

function parseLightDark(value: string, label: string): Record<Theme, Color> {
  const values = [...value.matchAll(COLOR)];
  if (values.length !== 2) {
    throw new Error(`Expected a light and dark colour in ${label}: ${value}`);
  }

  return {
    light: parseColor(values[0][0], `${label} light`),
    dark: parseColor(values[1][0], `${label} dark`),
  };
}

function token(name: string): Record<Theme, Color> {
  const declaration = styles.match(new RegExp(`--${name}:\\s*light-dark\\(([^;]+)\\);`));
  if (!declaration) {
    throw new Error(`Could not find --${name} in styles.scss`);
  }

  return parseLightDark(declaration[1], name);
}

const DESKTOP_TINT = (() => {
  const declaration = styles.match(
    /html\.gb-desktop body\s*\{[^}]*?background:\s*light-dark\(([^;]+)\);/s,
  );
  if (!declaration) {
    throw new Error('Could not find the desktop body tint in styles.scss');
  }

  return parseLightDark(declaration[1], 'html.gb-desktop body background');
})();

const INK = token('gb-glass-ink');

function over(foreground: Color, background: Rgb): Rgb {
  return foreground.rgb.map(
    (channel, index) => foreground.alpha * channel + (1 - foreground.alpha) * background[index],
  ) as Rgb;
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function composite(theme: Theme, fill: string, desktop: Rgb): { background: Rgb; text: Rgb } {
  const fillToken = FILLS.find((candidate) => candidate.name === fill);
  if (!fillToken) {
    throw new Error(`Unknown glass fill: ${fill}`);
  }

  let background = over(DESKTOP_TINT[theme], desktop);
  background = over(token(fillToken.token)[theme], background);

  return { background, text: over(INK[theme], background) };
}

function ratio(theme: Theme, fill: string, desktop: Rgb): number {
  const { background, text } = composite(theme, fill, desktop);
  return contrast(text, background);
}

describe('Glass text contrast', () => {
  for (const theme of THEMES) {
    for (const fill of FILLS) {
      if (fill.name === 'thick') {
        continue;
      }

      for (const desktop of DESKTOPS) {
        it(`keeps ${theme} ${fill.name} text at WCAG AA over a ${desktop.name} desktop`, () => {
          expect(ratio(theme, fill.name, desktop.rgb)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it('keeps the thick sheet at its current contrast', () => {
    expect(ratio('dark', 'thick', [255, 255, 255])).toBeCloseTo(9.02, 2);
    expect(ratio('light', 'thick', [0, 0, 0])).toBeCloseTo(7.38, 2);
  });
});
