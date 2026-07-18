import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: false,
    include: ['**/*.test.ts'],
    // Unit tests opt into hybrid retrieval explicitly with mocked I/O. Keeping
    // the legacy integration fixtures offline avoids accidental live calls.
    env: { SONNY_HYBRID_RETRIEVAL: 'off' },
  },
});
