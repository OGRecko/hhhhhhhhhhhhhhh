import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const project = process.env.GCP_PROJECT_ID;
const service = process.env.CLOUD_RUN_SERVICE;
const email = process.env.MONITORING_ALERT_EMAIL;
if (!project || !service || !email) throw new Error('GCP_PROJECT_ID, CLOUD_RUN_SERVICE and MONITORING_ALERT_EMAIL are required');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Invalid MONITORING_ALERT_EMAIL');
if (!/^[a-z][a-z0-9-]{0,62}$/.test(project)) throw new Error('Invalid GCP_PROJECT_ID');
if (!/^[a-z][a-z0-9-]{0,99}$/.test(service)) throw new Error('Invalid CLOUD_RUN_SERVICE');

const run = (args) => execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const json = (args) => JSON.parse(run([...args, '--format=json']));
const escapedService = service.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const baseFilter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${escapedService}"`;
const dir = mkdtempSync(join(tmpdir(), 'cavity-monitoring-'));

try {
  let channels = json(['beta', 'monitoring', 'channels', 'list', `--project=${project}`]);
  let channel = channels.find((c) => c.type === 'email' && c?.labels?.email_address === email);
  if (!channel) {
    const f = join(dir, 'channel.json');
    writeFileSync(f, JSON.stringify({
      type: 'email',
      displayName: `Cavity Audio production alerts — ${email}`,
      labels: { email_address: email },
      enabled: true,
    }));
    channel = json(['beta', 'monitoring', 'channels', 'create', `--project=${project}`, `--channel-content-from-file=${f}`]);
  }

  const channelName = channel.name;
  const common = {
    enabled: true,
    combiner: 'OR',
    notificationChannels: [channelName],
    documentation: {
      content: 'Cavity Audio production alert. Investigate Cloud Run logs, worker failures, queue health and job latency.',
    },
  };
  const policies = [
    {
      ...common,
      displayName: 'Cavity Audio — Cloud Run 5xx >= 5%',
      conditions: [{
        displayName: '5xx request ratio',
        conditionThreshold: {
          filter: `${baseFilter} AND metric.type="run.googleapis.com/request_count" AND metric.labels.response_code_class="5xx"`,
          denominatorFilter: `${baseFilter} AND metric.type="run.googleapis.com/request_count"`,
          aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_RATE', crossSeriesReducer: 'REDUCE_SUM' }],
          denominatorAggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_RATE', crossSeriesReducer: 'REDUCE_SUM' }],
          comparison: 'COMPARISON_GT',
          thresholdValue: 0.05,
          duration: '300s',
        },
      }],
    },
    {
      ...common,
      displayName: 'Cavity Audio — Cloud Run p95 latency > 5s',
      conditions: [{
        displayName: 'p95 request latency',
        conditionThreshold: {
          filter: `${baseFilter} AND metric.type="run.googleapis.com/request_latencies"`,
          aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_PERCENTILE_95', crossSeriesReducer: 'REDUCE_MAX' }],
          comparison: 'COMPARISON_GT',
          thresholdValue: 5000,
          duration: '600s',
        },
      }],
    },
    {
      ...common,
      displayName: 'Cavity Audio — Cloud Run ERROR logs',
      conditions: [{
        displayName: 'Cloud Run error logs',
        conditionMatchedLog: { filter: `${baseFilter} AND severity>=ERROR` },
      }],
    },
  ];

  const existing = json(['monitoring', 'policies', 'list', `--project=${project}`]);
  for (const policy of policies) {
    const old = existing.find((p) => p.displayName === policy.displayName);
    const f = join(dir, `policy-${policies.indexOf(policy)}.json`);
    writeFileSync(f, JSON.stringify(policy));
    if (old?.name) run(['monitoring', 'policies', 'update', old.name, `--project=${project}`, `--policy-from-file=${f}`]);
    else run(['monitoring', 'policies', 'create', `--project=${project}`, `--policy-from-file=${f}`]);
  }

  console.log(JSON.stringify({
    project,
    service,
    notificationChannel: channelName,
    note: 'Email notification channels require Google verification before notifications are delivered.',
    policies: policies.map((p) => p.displayName),
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
