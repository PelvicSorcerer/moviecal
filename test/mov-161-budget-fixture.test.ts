import { it, expect } from 'vitest';
import { multiplyBudgetFixture } from '../src/lib/mov-161-budget-fixture';

it('multiplies two numbers (MOV-161 repair-budget drill, round 1)', () => {
  expect(multiplyBudgetFixture(3, 4)).toBe(12);
});
