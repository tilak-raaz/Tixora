import { createLogger, createPool, loadEnvFile, runMigrations } from '@bmt/platform';
import { loadConfig } from '../config';
import { ENV_FILE, MIGRATIONS_DIR } from '../paths';

loadEnvFile(ENV_FILE);
const config = loadConfig();
const logger = createLogger({
  name: 'migrate',
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === 'development',
});
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: 1,
  applicationName: 'bmt-migrate',
  logger,
});

try {
  const { applied, skipped } = await runMigrations(pool, MIGRATIONS_DIR, logger);
  logger.info(
    { applied: applied.length, alreadyApplied: skipped.length },
    applied.length ? 'migrations complete' : 'database already up to date',
  );
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
