// The package itself is ESM ("type": "module"). Without this marker Node would
// read the CommonJS build output in dist/cjs as ESM and fail on `require`.
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  '{\n  "type": "commonjs"\n}\n',
);
