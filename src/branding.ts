import fs from 'fs';
import path from 'path';

export const PLATFORM_BRAND = 'FrontLane';
export const PLATFORM_NAME = 'FrontLane Agent Platform';
export const PLATFORM_PROTOCOL_NAMESPACE = 'frontlane';
export const MCP_SERVER_NAME = 'frontlane';

export const DEFAULT_FRONTDESK_NAME = 'FrontLane Desk';
export const DEFAULT_FRONTDESK_FOLDER = 'frontlane-frontdesk';
export const LEGACY_FRONTDESK_FOLDER = 'enterprise-frontdesk';

export const DEFAULT_WORKER_FOLDER_PREFIX = 'frontlane';
export const LEGACY_WORKER_FOLDER_PREFIX = 'enterprise';

export function resolveFrontdeskFolderFromGroups(groupsDir: string, configured: string | undefined): string {
  const value = configured?.trim();
  if (value) return value;

  const preferred = path.join(groupsDir, DEFAULT_FRONTDESK_FOLDER);
  if (fs.existsSync(preferred)) return DEFAULT_FRONTDESK_FOLDER;

  const legacy = path.join(groupsDir, LEGACY_FRONTDESK_FOLDER);
  if (fs.existsSync(legacy)) return LEGACY_FRONTDESK_FOLDER;

  return DEFAULT_FRONTDESK_FOLDER;
}

export function buildWorkerFolder(localName: string): string {
  return `${DEFAULT_WORKER_FOLDER_PREFIX}-${localName}`;
}

export function buildLegacyWorkerFolder(localName: string): string {
  return `${LEGACY_WORKER_FOLDER_PREFIX}-${localName}`;
}
