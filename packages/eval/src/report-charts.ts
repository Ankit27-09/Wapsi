/**
 * INLINE SVG CHARTS
 *
 * Hand-rolled, and deliberately. The report has to open from a `file://` URL on a machine
 * with no network — a judge should be able to double-click it — so a CDN chart library is
 * not an option, and bundling one to draw four charts is not a trade worth making.
 *
 * Everything below emits a self-contained `<svg>` with no script, no external font, and no
 * fetch. The page works offline, forever, and in an email attachment.
 */

const INK = '#e6edf3';
const MUTED = '#7d8590';
const GRID = '#21262d';
const ACCENT = '#2f81f7';
const GOOD = '#3fb950';
const WARN = '#d29922';
const BAD = '#f85149';

export interface BarDatum {
  readonly label: string;
  readonly value: number;
  readonly caption: string;
  readonly highlight?: boolean;
}

/**
 * Horizontal bars. Used for the arm comparison, where the labels are words and the
 * magnitudes span two orders of magnitude.
 */
export function barChart(data: readonly BarDatum[], options: { readonly width?: number } = {}): string {
  const width = options.width ?? 760;
  const rowHeight = 44;
  const labelWidth = 190;
  const height = data.length * rowHeight + 20;
  const max = Math.max(...data.map((d) => d.value), 1);
  const plotWidth = width - labelWidth - 150;

  const rows = data
    .map((datum, i) => {
      const y = i * rowHeight + 14;
      const barWidth = Math.max(2, (datum.value / max) * plotWidth);
      const fill = datum.highlight === true ? ACCENT : MUTED;

      return `
    <text x="${labelWidth - 12}" y="${y + 14}" text-anchor="end" fill="${INK}"
          font-size="13" font-family="ui-monospace,monospace">${escapeXml(datum.label)}</text>
    <rect x="${labelWidth}" y="${y}" width="${barWidth}" height="22" rx="3" fill="${fill}"/>
    <text x="${labelWidth + barWidth + 10}" y="${y + 16}" fill="${INK}"
          font-size="13" font-family="ui-monospace,monospace">${escapeXml(datum.caption)}</text>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="arm comparison">${rows}
</svg>`;
}

export interface LinePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A line with an optional marked point.
 *
 * Used for the value frontier: net value against how aggressive the policy is allowed to
 * be. The marker is where the shipped policy actually sits, which is the whole point of
 * drawing the curve — it shows the chosen operating point is on the right side of the peak
 * rather than merely asserting it.
 */
export function lineChart(
  points: readonly LinePoint[],
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly xLabel: string;
    readonly yLabel: string;
    readonly marker?: LinePoint;
    readonly markerLabel?: string;
    readonly formatY?: (value: number) => string;
  },
): string {
  const width = options.width ?? 760;
  const height = options.height ?? 300;
  const pad = { top: 20, right: 28, bottom: 46, left: 84 };

  if (points.length === 0) return '';

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  // Zero is included in the y range on purpose: a chart of net value that does not show
  // where zero is invites the reader to misjudge how close a strategy came to losing money.
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(...ys);

  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const sx = (x: number): number =>
    pad.left + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
  const sy = (y: number): number =>
    pad.top + plotH - (yMax === yMin ? plotH / 2 : ((y - yMin) / (yMax - yMin)) * plotH);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.x)},${sy(p.y)}`).join(' ');
  const formatY = options.formatY ?? ((v: number): string => String(Math.round(v)));

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = pad.top + plotH * t;
      const value = yMax - (yMax - yMin) * t;
      return `
    <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="${GRID}"/>
    <text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" fill="${MUTED}"
          font-size="11" font-family="ui-monospace,monospace">${escapeXml(formatY(value))}</text>`;
    })
    .join('');

  const marker =
    options.marker === undefined
      ? ''
      : `
    <line x1="${sx(options.marker.x)}" y1="${pad.top}" x2="${sx(options.marker.x)}"
          y2="${pad.top + plotH}" stroke="${WARN}" stroke-dasharray="4 3"/>
    <circle cx="${sx(options.marker.x)}" cy="${sy(options.marker.y)}" r="5" fill="${WARN}"/>
    <text x="${sx(options.marker.x) + 10}" y="${sy(options.marker.y) - 10}" fill="${WARN}"
          font-size="12" font-family="ui-monospace,monospace">${escapeXml(options.markerLabel ?? '')}</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeXml(options.yLabel)}">
    ${gridLines}
    <path d="${path}" fill="none" stroke="${ACCENT}" stroke-width="2"/>
    ${marker}
    <text x="${width / 2}" y="${height - 8}" text-anchor="middle" fill="${MUTED}"
          font-size="12" font-family="ui-monospace,monospace">${escapeXml(options.xLabel)}</text>
</svg>`;
}

/** A histogram, for the sweep's distribution of outcomes across perturbed worlds. */
export function histogram(
  values: readonly number[],
  options: { readonly bins?: number; readonly formatX: (value: number) => string },
): string {
  if (values.length === 0) return '';

  const width = 760;
  const height = 260;
  const pad = { top: 16, right: 20, bottom: 44, left: 48 };
  const binCount = options.bins ?? 24;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const counts = new Array<number>(binCount).fill(0);

  for (const value of values) {
    const index = Math.min(binCount - 1, Math.floor(((value - min) / span) * binCount));
    counts[index] = (counts[index] ?? 0) + 1;
  }

  const peak = Math.max(...counts, 1);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const barW = plotW / binCount;

  const bars = counts
    .map((count, i) => {
      const h = (count / peak) * plotH;
      return `<rect x="${pad.left + i * barW}" y="${pad.top + plotH - h}"
        width="${Math.max(1, barW - 1.5)}" height="${h}" fill="${GOOD}" opacity="0.75"/>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="distribution">
    <line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="${GRID}"/>
    ${bars}
    <text x="${pad.left}" y="${height - 12}" fill="${MUTED}" font-size="11"
          font-family="ui-monospace,monospace">${escapeXml(options.formatX(min))}</text>
    <text x="${width - pad.right}" y="${height - 12}" text-anchor="end" fill="${MUTED}"
          font-size="11" font-family="ui-monospace,monospace">${escapeXml(options.formatX(max))}</text>
</svg>`;
}

/**
 * A reliability diagram: stated confidence against observed accuracy.
 *
 * The diagonal is perfect calibration. Points below it are OVERCONFIDENCE, which is the
 * direction that costs money — the system acts where it should have quarantined. Drawing
 * the diagonal is what makes the gap legible without a caption.
 */
export function reliabilityDiagram(
  bins: readonly { readonly meanConfidenceBps: number; readonly accuracyBps: number; readonly count: number }[],
): string {
  const size = 340;
  const pad = 44;
  const plot = size - pad * 2;
  const scale = (bps: number): number => (bps / 10_000) * plot;

  const maxCount = Math.max(...bins.map((b) => b.count), 1);

  const points = bins
    .map((bin) => {
      const cx = pad + scale(bin.meanConfidenceBps);
      const cy = size - pad - scale(bin.accuracyBps);
      const r = 4 + (bin.count / maxCount) * 7;
      const overconfident = bin.accuracyBps < bin.meanConfidenceBps;
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${overconfident ? BAD : GOOD}" opacity="0.85"/>`;
    })
    .join('');

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" role="img" aria-label="reliability diagram">
    <rect x="${pad}" y="${pad}" width="${plot}" height="${plot}" fill="none" stroke="${GRID}"/>
    <line x1="${pad}" y1="${size - pad}" x2="${size - pad}" y2="${pad}" stroke="${MUTED}" stroke-dasharray="4 3"/>
    ${points}
    <text x="${size / 2}" y="${size - 12}" text-anchor="middle" fill="${MUTED}"
          font-size="11" font-family="ui-monospace,monospace">stated confidence →</text>
    <text x="14" y="${size / 2}" fill="${MUTED}" font-size="11"
          font-family="ui-monospace,monospace" transform="rotate(-90 14 ${size / 2})">actual accuracy →</text>
</svg>`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
