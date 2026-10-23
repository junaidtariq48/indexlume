export interface HistogramBucket {
  count: number;
  errorCount: number;
  durationSumMs: number;
  durationLe10: number;
  durationLe25: number;
  durationLe50: number;
  durationLe100: number;
  durationLe250: number;
  durationLe500: number;
  durationLe1000: number;
}

const thresholds: Array<[keyof HistogramBucket, number]> = [
  ['durationLe10', 10],
  ['durationLe25', 25],
  ['durationLe50', 50],
  ['durationLe100', 100],
  ['durationLe250', 250],
  ['durationLe500', 500],
  ['durationLe1000', 1000],
];

export type AnalyticsInterval = 'minute' | 'hour' | 'day';

export function analyticsInterval(durationMs: number): AnalyticsInterval {
  if (durationMs <= 2 * 60 * 60 * 1000) return 'minute';
  if (durationMs <= 2 * 24 * 60 * 60 * 1000) return 'hour';
  return 'day';
}

export function truncateAnalyticsBucket(
  value: Date,
  interval: AnalyticsInterval,
): Date {
  const result = new Date(value);
  if (interval === 'day') result.setUTCHours(0, 0, 0, 0);
  else if (interval === 'hour') result.setUTCMinutes(0, 0, 0);
  else result.setUTCSeconds(0, 0);
  return result;
}

export function estimatePercentile(
  histogram: HistogramBucket,
  percentile: number,
): number | null {
  if (histogram.count <= 0) return null;
  const target = Math.ceil(histogram.count * percentile);
  for (const [field, upperBound] of thresholds) {
    if (histogram[field] >= target) return upperBound;
  }
  return 1001;
}

export function emptyHistogram(): HistogramBucket {
  return {
    count: 0,
    errorCount: 0,
    durationSumMs: 0,
    durationLe10: 0,
    durationLe25: 0,
    durationLe50: 0,
    durationLe100: 0,
    durationLe250: 0,
    durationLe500: 0,
    durationLe1000: 0,
  };
}

export function addHistogram(
  target: HistogramBucket,
  value: HistogramBucket,
): HistogramBucket {
  for (const field of Object.keys(target) as Array<keyof HistogramBucket>) {
    target[field] += value[field];
  }
  return target;
}
