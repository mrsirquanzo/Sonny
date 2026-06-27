import { describe, it, expect } from 'vitest';
import { PACKAGE_OK } from './index.js';

describe('scaffold', () => {
  it('loads the shared package', () => {
    expect(PACKAGE_OK).toBe(true);
  });
});
