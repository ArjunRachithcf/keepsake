// The one source of the version is this package's package.json (bundled in by esbuild); test/version.contract.test.ts
// checks every other place it is written says the same.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
