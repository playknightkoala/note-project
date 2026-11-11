import type { VersionInfo } from '../shared/version.ts';
import { isNewerVersion } from '../shared/version.ts';
import { releases } from '../shared/releases.ts';

export function versionInfo(version: string): VersionInfo {
  return { version, releases: releases.filter(release => !isNewerVersion(release.version, version)) };
}
