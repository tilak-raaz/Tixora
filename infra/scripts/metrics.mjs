#!/usr/bin/env node
// Reads /metrics from every API replica and worker in the full stack and prints them side by
// side (ADR 0015). The replicas publish no ports, so each one is read from inside its container.
//
//   node infra/scripts/metrics.mjs            one row per replica and per worker
//   node infra/scripts/metrics.mjs --routes   also the busiest routes on each replica
/* eslint-disable no-console -- a command-line report: printing is its job */
import { execFileSync } from 'node:child_process';

const COMPOSE = ['compose', '-f', 'infra/docker-compose.yml', '--profile', 'full'];
const PORTS = { api: 4000, worker: 9100 };
const showRoutes = process.argv.includes('--routes');

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function containers() {
  const out = docker([...COMPOSE, 'ps', '--format', 'json', 'api', 'worker']).trim();
  if (!out) return [];
  // Older Compose prints one JSON array, newer one object per line.
  const parsed = out.startsWith('[') ? JSON.parse(out) : out.split('\n').map((l) => JSON.parse(l));
  return parsed
    .filter((c) => c.State === 'running')
    .map((c) => ({ name: c.Name, service: c.Service }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function scrape({ name, service }) {
  const script = `fetch('http://127.0.0.1:${PORTS[service]}/metrics').then((r) => r.text()).then((t) => process.stdout.write(t))`;
  return parse(docker(['exec', name, 'node', '-e', script]));
}

/** Prometheus text format -> [{ name, labels, value }]. */
function parse(text) {
  const samples = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels = {};
    for (const [, key, value] of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[key] = value;
    }
    samples.push({ name: m[1], labels, value: Number(m[3]) });
  }
  return samples;
}

const pick = (samples, name, where = () => true) =>
  samples.filter((s) => s.name === name && where(s.labels));
const sum = (samples, name, where) => pick(samples, name, where).reduce((t, s) => t + s.value, 0);

/** A quantile from cumulative histogram buckets, interpolated inside the bucket. */
function quantile(samples, name, q, where = () => true) {
  const byLe = new Map();
  for (const s of pick(samples, `${name}_bucket`, where)) {
    byLe.set(s.labels.le, (byLe.get(s.labels.le) ?? 0) + s.value);
  }
  const buckets = [...byLe.entries()]
    .map(([le, count]) => ({ le: le === '+Inf' ? Infinity : Number(le), count }))
    .sort((a, b) => a.le - b.le);
  const total = buckets.at(-1)?.count ?? 0;
  if (!total) return undefined;
  const target = q * total;
  let prevLe = 0;
  let prevCount = 0;
  for (const { le, count } of buckets) {
    if (count >= target) {
      if (le === Infinity) return prevLe;
      const inBucket = count - prevCount;
      return inBucket ? prevLe + ((target - prevCount) / inBucket) * (le - prevLe) : le;
    }
    prevLe = le;
    prevCount = count;
  }
  return prevLe;
}

const ms = (seconds) => (seconds === undefined ? '-' : `${Math.round(seconds * 1000)} ms`);
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

function table(rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const width = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(width[i])).join('  ');
  console.log(line(keys));
  console.log(line(width.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(keys.map((k) => r[k])));
  console.log();
}

const list = containers();
if (!list.length) {
  console.error('No running api or worker containers. Start the stack with `make stack`.');
  process.exit(1);
}
// A container that cannot be read (still starting, or an image from before metrics existed) is
// listed at the end instead of stopping the report.
const unreachable = [];
const scraped = list.flatMap((c) => {
  try {
    return [{ ...c, samples: scrape(c) }];
  } catch (err) {
    const reason = String(err.stderr ?? err.message).match(/ECONNREFUSED|ENOTFOUND|[^\n]+/)?.[0];
    unreachable.push(`${c.name}: ${reason ?? 'no answer'}`);
    return [];
  }
});
const HTTP = 'bmt_http_request_duration_seconds';

const apis = scraped.filter((c) => c.service === 'api');
console.log('API replicas (since each one started)\n');
table(
  apis.map(({ name, samples: s }) => {
    const status = (re) => sum(s, `${HTTP}_count`, (l) => re.test(l.status));
    const holds = (outcome) => sum(s, 'bmt_holds_total', (l) => l.outcome === outcome);
    return {
      replica: name,
      requests: sum(s, `${HTTP}_count`),
      '2xx': status(/^2/),
      '4xx': status(/^4(?!29)/),
      // Not '429': JavaScript lists integer-like keys before all others, whatever the order.
      '429s': status(/^429$/),
      '5xx': status(/^5/),
      p50: ms(quantile(s, HTTP, 0.5)),
      p95: ms(quantile(s, HTTP, 0.95)),
      'holds ok/early/taken': `${holds('held')}/${holds('rejected_early')}/${holds('seats_taken')}`,
      streams: sum(s, 'bmt_seat_streams'),
      'pool busy/wait': `${sum(s, 'bmt_db_pool_connections', (l) => l.state === 'busy')}/${sum(s, 'bmt_db_pool_waiting_queries')}`,
      'loop lag p99': ms(sum(s, 'nodejs_eventloop_lag_p99_seconds')),
      cpu: `${sum(s, 'process_cpu_seconds_total').toFixed(1)} s`,
      memory: mb(sum(s, 'process_resident_memory_bytes')),
    };
  }),
);

if (showRoutes) {
  for (const { name, samples: s } of apis) {
    const routes = new Map();
    for (const sample of pick(s, `${HTTP}_count`)) {
      const key = `${sample.labels.method} ${sample.labels.route}`;
      routes.set(key, (routes.get(key) ?? 0) + sample.value);
    }
    const top = [...routes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`${name}: busiest routes\n`);
    table(
      top.map(([key, count]) => {
        const [method, route] = key.split(' ');
        const where = (l) => l.method === method && l.route === route;
        return {
          route: key,
          requests: count,
          p50: ms(quantile(s, HTTP, 0.5, where)),
          p95: ms(quantile(s, HTTP, 0.95, where)),
        };
      }),
    );
  }
}

const workers = scraped.filter((c) => c.service === 'worker');
if (workers.length) {
  console.log('Workers (jobs since each one started)\n');
  table(
    workers.map(({ name, samples: s }) => ({
      worker: name,
      'jobs done': sum(s, 'bmt_jobs_total', (l) => l.result === 'completed'),
      'attempts failed': sum(s, 'bmt_jobs_total', (l) => l.result === 'failed'),
      'job p95': ms(quantile(s, 'bmt_job_duration_seconds', 0.95)),
      'loop lag p99': ms(sum(s, 'nodejs_eventloop_lag_p99_seconds')),
      memory: mb(sum(s, 'process_resident_memory_bytes')),
    })),
  );
  // Queue depth and outbox lag are read from Redis and Postgres: the same on every worker.
  const s = workers[0].samples;
  console.log('Queues and outbox (shared)\n');
  table(
    [...new Set(pick(s, 'bmt_queue_jobs').map((x) => x.labels.queue))].map((queue) => {
      const depth = (state) =>
        sum(s, 'bmt_queue_jobs', (l) => l.queue === queue && l.state === state);
      return {
        queue,
        waiting: depth('waiting'),
        active: depth('active'),
        delayed: depth('delayed'),
        failed: depth('failed'),
      };
    }),
  );
  console.log(
    `outbox: ${sum(s, 'bmt_outbox_unpublished')} unpublished, oldest ${ms(sum(s, 'bmt_outbox_oldest_seconds'))}`,
  );
}

if (unreachable.length) {
  console.log('\nNot read (no metrics yet? rebuild with `make stack`):');
  for (const line of unreachable) console.log(`  ${line}`);
}
