import { defineConfig } from 'tsdown'

/**
 * Type declarations for the client bundle (consumers of `./client`).
 * Emits `lib/client-dts.d.ts` to avoid colliding with the banner-wrapped
 * `lib/client.js`; `pnpm build` copies it to `lib/client.d.ts`.
 */
export default defineConfig({
  entry: { 'client-dts': 'src/client/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  dts: true,
  clean: false,
  tsconfig: 'tsconfig.prepare.json',
})
