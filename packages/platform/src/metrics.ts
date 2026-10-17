import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { Pool } from 'pg';
import type { Logger } from './logger';

/**
 * Metrics in the Prometheus text format, one registry per process (ADR 0015). Each API replica
 * and each worker reports its own numbers; nothing is aggregated in the process, so a slow or
 * failing replica stands out instead of being averaged away.
 */
export { Counter, Gauge, Histogram, Registry };

export interface MetricsRegistryOptions {
  /** `api` or `worker`; a label on every series. */
  service: string;
  /** Which process this is; defaults to the hostname (the container ID in Docker). */
  instance?: string;
  /** Reports the pool's connections and how many queries are waiting for one. */
  pool?: Pool;
}

export function createMetricsRegistry(opts: MetricsRegistryOptions): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: opts.service, instance: opts.instance ?? hostname() });
  // CPU, memory, event loop lag, garbage collection, open handles.
  collectDefaultMetrics({ register: registry });

  const pool = opts.pool;
  if (pool) {
    new Gauge({
      name: 'bmt_db_pool_connections',
      help: 'Postgres connections in this process pool, by state',
      labelNames: ['state'] as const,
      registers: [registry],
      collect() {
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'busy' }, pool.totalCount - pool.idleCount);
      },
    });
    new Gauge({
      name: 'bmt_db_pool_waiting_queries',
      help: 'Queries waiting for a free Postgres connection; above 0 means the pool is the bottleneck',
      registers: [registry],
      collect() {
        this.set(pool.waitingCount);
      },
    });
  }
  return registry;
}

/** The Prometheus text for a registry, with the content type to send it with. */
export async function renderMetrics(
  registry: Registry,
): Promise<{ contentType: string; body: string }> {
  return { contentType: registry.contentType, body: await registry.metrics() };
}

export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * A tiny HTTP server for processes that serve no HTTP of their own (the worker): GET /metrics
 * and GET /healthz. It listens inside the container only; nothing publishes or proxies the port.
 */
export async function startMetricsServer(opts: {
  port: number;
  registry: Registry;
  logger: Logger;
}): Promise<MetricsServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET') {
      res.writeHead(405).end();
    } else if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    } else if (path === '/metrics') {
      renderMetrics(opts.registry).then(
        ({ contentType, body }) => res.writeHead(200, { 'Content-Type': contentType }).end(body),
        (err: unknown) => {
          opts.logger.warn({ err }, 'could not collect metrics');
          res.writeHead(500).end();
        },
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
