import { z } from 'zod';

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const versionInfoSchema = z.object({
  version: versionSchema,
  releases: z.array(z.object({ version: versionSchema, title: z.string().max(200), changes: z.array(z.string().max(2000)).max(30) })).max(30).default([]),
});
export type VersionInfo = z.infer<typeof versionInfoSchema>;

export function isNewerVersion(candidate: string, current: string): boolean {
  if (!versionSchema.safeParse(candidate).success || !versionSchema.safeParse(current).success) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}
