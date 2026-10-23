import { describe, expect, it } from 'vitest';

import {
  addHistogram,
  analyticsInterval,
  emptyHistogram,
  estimatePercentile,
  truncateAnalyticsBucket,
} from '../src/operations/analytics.js';

describe('M6 analytics aggregation', () => {
  it('returns no percentile when there is no traffic', () => {
    expect(estimatePercentile(emptyHistogram(), 0.5)).toBeNull();
    expect(estimatePercentile(emptyHistogram(), 0.95)).toBeNull();
  });

  it('estimates p50 and p95 from cumulative latency buckets', () => {
    const histogram = {
      count: 20,
      errorCount: 2,
      durationSumMs: 2_000,
      durationLe10: 1,
      durationLe25: 5,
      durationLe50: 10,
      durationLe100: 18,
      durationLe250: 19,
      durationLe500: 20,
      durationLe1000: 20,
    };
    expect(estimatePercentile(histogram, 0.5)).toBe(50);
    expect(estimatePercentile(histogram, 0.95)).toBe(250);
  });

  it('adds metric buckets without losing counts or timings', () => {
    const aggregate = emptyHistogram();
    addHistogram(aggregate, {
      count: 3,
      errorCount: 1,
      durationSumMs: 75,
      durationLe10: 0,
      durationLe25: 3,
      durationLe50: 3,
      durationLe100: 3,
      durationLe250: 3,
      durationLe500: 3,
      durationLe1000: 3,
    });
    expect(aggregate).toMatchObject({
      count: 3,
      errorCount: 1,
      durationSumMs: 75,
      durationLe25: 3,
    });
  });

  it('preserves minute buckets for live analytics windows', () => {
    expect(analyticsInterval(30 * 60 * 1000)).toBe('minute');
    expect(analyticsInterval(24 * 60 * 60 * 1000)).toBe('hour');
    expect(analyticsInterval(7 * 24 * 60 * 60 * 1000)).toBe('day');
    expect(
      truncateAnalyticsBucket(
        new Date('2026-10-23T12:34:56.789Z'),
        'minute',
      ).toISOString(),
    ).toBe('2026-10-23T12:34:00.000Z');
  });
});
