import { GoogleAuth } from 'google-auth-library';
import { secretsEqual } from './config';

export interface CloudTaskDispatcherConfig {
  enabled: boolean;
  projectId: string;
  location: string;
  queue: string;
  targetUrl: string;
  dispatchSecret: string;
}

/**
 * Cloud Tasks is a liveness layer, not an authority layer. Firestore remains
 * the source of truth and claimJob() fences duplicate deliveries. A 409 from
 * Cloud Tasks means the deterministic task already exists and is therefore
 * treated as success.
 */
export class CloudTaskDispatcher {
  private readonly auth: GoogleAuth | null;
  private readonly endpoint: string;

  constructor(private readonly config: CloudTaskDispatcherConfig, credentials?: { client_email: string; private_key: string }) {
    this.auth = config.enabled
      ? new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          credentials,
        })
      : null;
    this.endpoint = `https://cloudtasks.googleapis.com/v2/projects/${encodeURIComponent(config.projectId)}/locations/${encodeURIComponent(config.location)}/queues/${encodeURIComponent(config.queue)}/tasks`;
  }

  get enabled(): boolean { return this.config.enabled; }

  async enqueue(simulationId: string): Promise<boolean> {
    if (!this.config.enabled) return true;
    const client = await this.auth!.getClient();
    const body = Buffer.from(JSON.stringify({ simulationId }), 'utf8').toString('base64');
    const taskName = `${this.endpoint}/${encodeURIComponent(simulationId)}`;
    try {
      await client.request({
        url: this.endpoint,
        method: 'POST',
        data: {
          task: {
            name: taskName,
            httpRequest: {
              httpMethod: 'POST',
              url: this.config.targetUrl,
              headers: {
                'content-type': 'application/json',
                'x-job-dispatch-secret': this.config.dispatchSecret,
              },
              body,
            },
          },
        },
      });
      return true;
    } catch (error: unknown) {
      const responseStatus = error && typeof error === 'object' && 'response' in error
        ? (error as { response?: { status?: unknown } }).response?.status
        : undefined;
      if (responseStatus === 409) return true;
      throw error;
    }
  }

  /** Constant-time check used by the internal task endpoint. */
  authorize(secret: unknown): boolean {
    return secretsEqual(secret, this.config.dispatchSecret);
  }
}
