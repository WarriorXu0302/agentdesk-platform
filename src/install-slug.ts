/**
 * Per-checkout install identifiers. Lets two installs coexist on one host
 * without clobbering each other's service registration or the shared agent
 * image tag.
 *
 * Slug is sha1(projectRoot)[:8] — deterministic per checkout path, stable
 * across re-runs, unique enough across installs.
 */
import { createHash } from 'crypto';

import { PLATFORM_PROTOCOL_NAMESPACE } from './branding.js';

export function getInstallSlug(projectRoot: string = process.cwd()): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

/** Docker image base (no tag). e.g. `agentdesk-agent-v2-ab12cd34`. */
export function getContainerImageBase(projectRoot?: string): string {
  return `${PLATFORM_PROTOCOL_NAMESPACE}-agent-v2-${getInstallSlug(projectRoot)}`;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:latest`;
}
