// Redirects `@netlify/blobs` to the in-memory mock so functions can be tested offline.
// Usage: node --import ./tests/helpers/register-blobs-mock.mjs tests/<file>.test.mjs
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
const mock = ${JSON.stringify(new URL('./blobs-mock.mjs', import.meta.url).href)};
export async function resolve(specifier, context, next) {
  if (specifier === '@netlify/blobs') return { url: mock, shortCircuit: true };
  return next(specifier, context);
}`));
