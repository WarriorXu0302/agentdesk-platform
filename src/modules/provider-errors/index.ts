/**
 * Provider-error delivery-action handler.
 *
 * The container's poll loop emits a `kind='system', action='provider_error'`
 * outbound whenever `provider.query(...)` throws. The host catches it here
 * and increments `frontlane_provider_errors_total{provider, code}`.
 *
 * Without this hook the metric stays at zero regardless of what the
 * container is actually encountering — a dashboard hazard worse than no
 * metric at all.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { providerErrorsTotal } from '../../metrics.js';
import type { Session } from '../../types.js';

function readString(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

async function handleProviderError(content: Record<string, unknown>, session: Session): Promise<void> {
  const provider = readString(content, 'provider');
  const code = readString(content, 'code');
  try {
    providerErrorsTotal.labels(provider, code).inc();
  } catch (err) {
    // prom-client rarely throws, but a label-name mismatch or overflow
    // shouldn't crash the delivery loop. Just log and drop.
    log.warn('provider_error metric increment failed', { sessionId: session.id, err });
  }
}

registerDeliveryAction('provider_error', handleProviderError);
