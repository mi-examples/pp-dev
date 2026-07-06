import { describe, it, expect } from 'vitest';
import { nearestCorner } from '../../../src/client/panel-position.js';

describe('nearestCorner', () => {
  const VW = 1000;
  const VH = 800;

  it('maps each quadrant to its corner', () => {
    expect(nearestCorner(10, 10, VW, VH)).toBe('top-left');
    expect(nearestCorner(990, 10, VW, VH)).toBe('top-right');
    expect(nearestCorner(10, 790, VW, VH)).toBe('bottom-left');
    expect(nearestCorner(990, 790, VW, VH)).toBe('bottom-right');
  });

  it('resolves points just inside quadrant boundaries', () => {
    expect(nearestCorner(499, 399, VW, VH)).toBe('top-left');
    expect(nearestCorner(500, 399, VW, VH)).toBe('top-right');
    expect(nearestCorner(499, 400, VW, VH)).toBe('bottom-left');
  });

  it('resolves the exact center toward bottom-right', () => {
    expect(nearestCorner(VW / 2, VH / 2, VW, VH)).toBe('bottom-right');
  });
});
