// Lets Node import the Worker as the bundler does: `import D from './stories.json'` without an import attribute.
import { register } from 'node:module';
register('./json-hooks.mjs', import.meta.url);
