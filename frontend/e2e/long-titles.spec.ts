import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openSeeded, startPlanningThenUndo } from './seed';
import type { Seed } from './seed';

// A title with nowhere to break, as a pasted link makes, stays inside its card on every screen that shows one, at the
// narrowest phone and a laptop's width.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago, with this week not yet planned.
const WEEK = '2026-11-02';
// 200 characters and not one place a line may break.
const long = (what: string) => (what + 'Supercalifragilisticexpialidocious'.repeat(7)).slice(0, 200);
const block = (id: string, owner: Record<string, string>, start: string, end: string): Seed => ({
  type: 'time_block',
  id,
  fields: { ...owner, start, end, tz: 'America/Chicago' },
});

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: long('Goal'), state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: long('Project'), state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: long('Milestone'), due: '2026-11-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: long('Task'), estimate_min: 45 } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: long('Finished'), estimate_min: 30, done_at: '2026-11-02T16:00:00Z' } },
  { type: 'task', id: 'o1', fields: { kind: 'one_off', title: long('Oneoff'), estimate_min: 20, schedule: { type: 'once', from: '2026-11-04' } } },
  { type: 'practice', id: 'pr', fields: { title: long('Practice'), target_min: 15, per: 'day', preferred_times: [420], state: 'active' } },
  { type: 'week_pick', id: `pick:${WEEK}:t1`, fields: { week_start: WEEK, task_id: 't1', minutes: 45 } },
  { type: 'week_pick', id: `pick:${WEEK}:o1`, fields: { week_start: WEEK, task_id: 'o1', minutes: 20 } },
  // Done today: the task, its time and a practice's.
  block('b1', { task_id: 't2' }, '2026-11-02T15:00:00Z', '2026-11-02T15:30:00Z'),
  { type: 'block_outcome', id: 'outcome:b1', fields: { result: 'done', answered_at: '2026-11-02T16:00:00Z' } },
  block('b2', { practice_id: 'pr' }, '2026-11-02T13:00:00Z', '2026-11-02T13:15:00Z'),
  { type: 'block_outcome', id: 'outcome:b2', fields: { result: 'done', logged_min: 15, answered_at: '2026-11-02T16:00:00Z' } },
];

/**
 * The box holding each title is as wide as what's in it, the title stays inside every box around it up to the screen,
 * and neither the screen nor the page scrolls sideways.
 */
async function expectContained(page: Page, screen: string) {
  // The page showing, or a flow over the pages.
  const shown = page.locator('.flowpane, .pane[aria-hidden="false"]').first();
  await expect(shown.getByText(/Supercalifragilistic/).first()).toBeVisible();
  const spills = await shown.evaluate((root) => {
    const out = new Set<string>();
    const name = (el: Element) => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')}`;
    const page = document.documentElement;
    if (page.scrollWidth > page.clientWidth) out.add(`the page scrolls sideways: ${page.scrollWidth}px in ${page.clientWidth}px`);
    if (root.scrollWidth > root.clientWidth + 1) out.add(`the screen scrolls sideways: ${root.scrollWidth}px in ${root.clientWidth}px`);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent?.includes('Supercalifragilistic')) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const title = range.getBoundingClientRect();
      let holder = true;
      for (let el = text.parentElement; el && el !== root; el = el.parentElement) {
        const style = getComputedStyle(el);
        // An inline box has no width of its own.
        if (style.display === 'inline' || style.display === 'contents' || el.getClientRects().length === 0) continue;
        // A box that clips or scrolls, such as a calendar event's, keeps the title inside it, cut short.
        if (style.overflowX !== 'visible') break;
        if (holder && el.scrollWidth > el.clientWidth + 1) out.add(`${name(el)} is ${el.clientWidth}px wide, holding ${el.scrollWidth}px: ${text.textContent.slice(0, 20)}`);
        holder = false;
        // By the title's own edges, as the boxes around it can hold other things, such as a timeline's end marker.
        const box = el.getBoundingClientRect();
        if (title.right > box.right + 1 || title.left < box.left - 1) out.add(`${text.textContent.slice(0, 20)} runs out of ${name(el)}`);
      }
    }
    return [...out];
  });
  // Soft, so one run lists every screen that spills.
  expect.soft(spills, screen).toEqual([]);
}

test('a 200-character title with nowhere to break stays inside its card', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  if (!phone) await page.setViewportSize({ width: 1280, height: 860 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const nav = page.getByRole('navigation', { name: 'Main' });
  const tab = async (name: string) => {
    if (phone && !['Today', 'Week', 'Inbox', 'Goals'].includes(name)) {
      await nav.getByRole('button', { name: 'More' }).click();
      await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    } else {
      await nav.getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) }).click();
    }
  };

  // Goals, a goal's projects, and a project's milestones and tasks.
  await tab('Goals');
  await expectContained(page, 'Goals');
  await page.getByRole('button', { name: /^.?\s*GoalSuper/ }).first().click();
  await expectContained(page, 'a goal');
  await page.screenshot({ path: info.outputPath('goals.png'), fullPage: true });
  await page.getByRole('button', { name: /^.?\s*ProjectSuper/ }).first().click();
  await expect(page.locator('.pane[aria-hidden="false"]').getByText(/^TaskSuper/).first()).toBeVisible();
  await expectContained(page, 'a project');
  await page.screenshot({ path: info.outputPath('project.png'), fullPage: true });

  await tab('Plan');
  await expectContained(page, 'Plan');
  await page.screenshot({ path: info.outputPath('plan.png'), fullPage: true });

  await tab('Done');
  await expectContained(page, 'Done');
  await page.screenshot({ path: info.outputPath('done.png'), fullPage: true });

  await tab('Today');
  await startPlanningThenUndo(page);
  await page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: phone ? 'Schedule' : '3. Schedule' }).click();
  await expectContained(page, 'Schedule');
  await page.screenshot({ path: info.outputPath('schedule.png'), fullPage: true });

  expect(errors).toEqual([]);
});
