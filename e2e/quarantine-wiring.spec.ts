import { resolveQuarantineMode } from '../src/lib/test-stability';
import { expect, test } from './test-fixtures';

test('quarantine mode wiring @quarantine', async () => {
  expect(resolveQuarantineMode()).toBe('quarantine-only');
});
