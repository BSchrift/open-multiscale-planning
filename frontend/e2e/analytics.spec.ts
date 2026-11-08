import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-06T18:00:00Z'); // Friday noon, in the week of Monday Nov 2.

let n = 0;
function block(task: string, start: string, mins: number, result?: 'done' | 'partly' | 'not'): Seed[] {
  const id = `blk${++n}`;
  const end = new Date(Date.parse(start) + mins * 60_000).toISOString();
  const out: Seed[] = [{ type: 'time_block', id, fields: { task_id: task, start, end, tz: 'America/Chicago' } }];
  if (result) out.push({ type: 'block_outcome', id: `outcome:${id}`, fields: { result, answered_at: NOW.toISOString() } });
  return out;
}

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active', order: 1 } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Sourdough', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', title: 'Feed the starter' } },
  { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Clean the windows' } },
  // This week: Monday done, Tuesday not done, Wednesday's one off done, Thursday unanswered.
  ...block('t1', '2026-11-02T15:00:00Z', 60, 'done'),
  ...block('t1', '2026-11-03T15:00:00Z', 60, 'not'),
  ...block('o1', '2026-11-04T15:00:00Z', 60, 'done'),
  ...block('t1', '2026-11-05T15:00:00Z', 60),
  // Five Tuesday evenings that didn't hold.
  ...['2026-09-29', '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27'].flatMap((d) => block('t1', `${d}T23:00:00Z`, 60, 'not')),
];

async function openAnalytics(page: Page, phone: boolean) {
  await page.clock.setFixedTime(NOW);
  await openSeeded(page, records);
  // Thursday's unanswered block asks on whatever page is showing; leave it unanswered.
  await page.getByRole('dialog', { name: 'Block finished' }).getByRole('button', { name: 'Answer later' }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    const row = page.getByRole('button', { name: /^Analytics/ });
    await expect(row).toContainText('50% reliable this week, 2h of 4h so far');
    await row.click();
    await expect(page.getByRole('button', { name: 'Back to More' })).toBeVisible();
  } else {
    await nav.getByRole('button', { name: 'Analytics' }).click();
  }
  await expect(pane(page, 'Analytics').getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
}

test('reads a week, moves between weeks, and acts on a pattern', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openAnalytics(page, phone);
  const p = pane(page, 'Analytics');

  await expect(p.getByText('Nov 2 to Nov 8')).toBeVisible();
  await expect(p.getByText('This week, so far')).toBeVisible();
  await expect(p.getByText('2h delivered of 4h planned, with the week still in progress.')).toBeVisible();
  await expect(p.getByRole('img', { name: 'Project tasks: 1 done, 0 partly, 1 not done' })).toBeVisible();
  await expect(p.getByText("1 block went unanswered and isn't included.", { exact: false })).toBeVisible();
  await expect(p.getByRole('button', { name: 'Next week' })).toBeDisabled();

  await p.getByRole('button', { name: 'Previous week' }).click();
  await expect(p.getByText('Oct 26 to Nov 1')).toBeVisible();
  await expect(p.getByText('Past week')).toBeVisible();

  if (phone) {
    for (const name of ['Week', 'This stretch', 'Previous week', 'Next week']) {
      const box = await p.getByRole('button', { name, exact: true }).boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
    }
    await p.getByRole('button', { name: "Show each week's numbers" }).click();
    await expect(p.getByRole('button', { name: "Hide each week's numbers" })).toHaveAttribute('aria-expanded', 'true');
  }

  await p.getByRole('button', { name: 'This stretch' }).click();
  await expect(p.getByText('This stretch, Oct 1 to Dec 31')).toBeVisible();
  await expect(p.getByText('Tuesday evenings rarely hold: 0 of the last 5 blocks were done.')).toBeVisible();
  await p.getByRole('button', { name: 'Stop suggesting them' }).click();
  await expect(p.getByText('Tuesday evenings are no longer suggested.')).toBeVisible();
  await p.getByRole('button', { name: 'Suggest them again' }).click();
  await expect(p.getByRole('button', { name: 'Stop suggesting them' })).toBeVisible();

  await page.screenshot({ path: info.outputPath('analytics.png'), fullPage: true });
  expect(errors).toEqual([]);
});
