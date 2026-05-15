import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverRoot = path.resolve(__dirname, '..');
const appRoot = path.resolve(serverRoot, '..');

export function resolveServerPath(...segments) {
  return path.join(serverRoot, ...segments);
}

export function resolveAppRoot(...segments) {
  return path.join(appRoot, ...segments);
}
