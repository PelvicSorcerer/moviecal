import { expect, it } from 'vitest';

import { addNumbers } from '../src/utils/dummy-math';

it('adds two positive numbers', () => {
  expect(addNumbers(2, 3)).toBe(5);
});

it('adds negative values', () => {
  expect(addNumbers(-4, 1)).toBe(-3);
});
