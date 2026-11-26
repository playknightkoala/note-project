import { expect } from 'vitest';
import type { TestClient } from './app.ts';
import type { ShareStateDto } from '../../src/shared/shares.ts';

/** Establish an accepted direct share through the same two accounts as the UI. */
export async function shareWith(owner: TestClient, recipient: TestClient, pageId: string, email: string, role: string) {
  const response = await owner.request('PUT', `/api/pages/${pageId}/share/members`, { json: { email, role } });
  expect(response.status).toBe(200);
  const { share } = await response.json() as ShareStateDto;
  const invite = share!.invitations.find(item => item.email === email);
  if (invite) expect((await recipient.request('POST', `/api/shares/invitations/${invite.id}/accept`)).status).toBe(204);
  else expect(share!.members).toContainEqual(expect.objectContaining({ email, role }));
}
