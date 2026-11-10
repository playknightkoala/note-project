import type { Migration } from '../migrate.ts';

/**
 * One link per share: the public link. What signed-in accounts get (`account_role`) is now a setting of that link
 * and is granted by opening it, no longer by knowing the page's own address.
 *
 * A share that was open to accounts without a public link therefore loses that setting here, together with the
 * record of who had opened it. Switching the public link on would expose the page to people without an account,
 * which its owner never chose; the owner switches it on and sets the accounts' role again. Shares that already had
 * both keep everything.
 */
export const migration: Migration = {
  id: '0011_share_single_link',
  up: `DELETE FROM share_visitors WHERE page_id IN (SELECT page_id FROM page_shares WHERE link_token IS NULL);
  UPDATE page_shares SET account_role = NULL WHERE link_token IS NULL AND account_role IS NOT NULL;`,
};
