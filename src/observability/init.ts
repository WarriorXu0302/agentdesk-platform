import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';
import { log } from '../log.js';
import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';

const DEFAULT_TRACES_ENDPOINT = 'http://localhost:6006/v1/traces';
const DEFAULT_SERVICE_NAME = `${PLATFORM_PROTOCOL_NAMESPACE}-host`;
const DEFAULT_SERVICE_VERSION = '2.0.44';
const SHUTDOWN_TIMEOUT_MS = 5000;

const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || DEFAULT_TRACES_ENDPOINT,
});

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
  [ATTR_SERVICE_VERSION]: DEFAULT_SERVICE_VERSION,
  [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV || 'development',
});

const instrumentations = getNodeAutoInstrumentations({
  '@opentelemetry/instrumentation-fs': {
    enabled: false,
  },
});

export const sdk = new NodeSDK({
  traceExporter,
  resource,
  instrumentations,
});

export function initObservability(): boolean {
  if (process.env.OTEL_SDK_DISABLED === 'true') {
    log.info('Observability SDK disabled via OTEL_SDK_DISABLED=true');
    return false;
  }

  try {
    sdk.start();
    log.info('Observability SDK started');
    return true;
  } catch (err) {
    log.warn('Failed to start Observability SDK', { err });
    return false;
  }
}

export async function shutdownObservability(): Promise<void> {
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('shutdown timed out')), SHUTDOWN_TIMEOUT_MS),
  );

  try {
    await Promise.race([sdk.shutdown(), timeout]);
    log.info('Observability SDK shut down');
  } catch (err) {
    log.warn('Failed to shut down Observability SDK', { err });
  }
}
