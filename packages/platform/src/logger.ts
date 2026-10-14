import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export interface LoggerConfig {
  name: string;
  level: string;
  /** Human-readable output for local development. Keep JSON everywhere else. */
  pretty?: boolean;
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    name: config.name,
    level: config.level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.token',
      ],
      censor: '[redacted]',
    },
  };
  if (config.pretty) {
    options.transport = { target: 'pino-pretty', options: { colorize: true } };
  }
  return pino(options);
}
