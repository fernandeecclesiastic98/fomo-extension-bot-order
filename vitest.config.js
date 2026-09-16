import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // Les tests DOM (jsdom + observateur de mutations) passent en ~0,5 s mais ont dépassé 5 s
    // sous la charge de la porte complète : un délai trop court y fabrique de faux rouges.
    testTimeout: 15_000,
  },
});
