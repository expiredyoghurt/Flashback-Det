import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (url.endsWith('.json') && !context.importAttributes?.type) {
    const source = `export default ${readFileSync(fileURLToPath(url), 'utf8')};`;
    return { format: 'module', source, shortCircuit: true };
  }
  return next(url, context);
}
