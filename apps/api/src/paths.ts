import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, resolved from this file (apps/api/src/paths.ts). */
export const ROOT_DIR = fileURLToPath(new URL('../../../', import.meta.url));

export const ENV_FILE = path.join(ROOT_DIR, '.env');
export const MIGRATIONS_DIR = path.join(ROOT_DIR, 'db', 'migrations');
