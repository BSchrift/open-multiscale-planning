import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { openSeeded } from './seed';
import type { Seed } from './seed';

// A lived-in week, then every screen in turn: each renders without errors and without sideways scrolling.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-04T16:20:00Z'); // Wednesday 10:20am in Chicago, mid-week.
const WEEK = '2026-11-02';
// Chicago is six hours behind UTC in November.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const tz = 'America/Chicago';

const task = (id: string, fields: Record<string, unknown>): Seed => ({ type: 'task', id, fields });
const block = (id: string, of: { task?: string; practice?: string }, day: number, from: string, to: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'time_block',
  id,
  fields: { ...(of.task ? { task_id: of.task } : { practice_id: of.practice }), start: at(day, from), end: at(day, to), tz, ...extra },
});
const outcome = (blockId: string, result: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'block_outcome',
  id: `outcome:${blockId}`,
  fields: { result, answered_at: at(4, '08:00'), ...extra },
});
const pick = (taskId: string, minutes: number): Seed => ({ type: 'week_pick', id: `pick:${WEEK}:${taskId}`, fields: { week_start: WEEK, task_id: taskId, minutes } });

const week: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Write a book', state: 'active' } },
  { type: 'objective', id: 'g2', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'objective', id: 'g3', fields: { title: 'Keep the house in shape', state: 'active' } },

  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Finish the first draft', state: 'active', start: '2026-09-01', end: '2026-12-20', weekly_aim: 360 } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Outline done', due: '2026-10-15', met_at: '2026-10-14T18:00:00Z' } },
  { type: 'milestone', id: 'm2', fields: { project_id: 'p1', title: 'Half the chapters', start: '2026-10-16', due: '2026-11-20' } },
  { type: 'milestone', id: 'm3', fields: { project_id: 'p1', title: 'Full draft', due: '2026-12-15' } },
  task('t1', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Sketch the chapter list', estimate_min: 120, done_at: '2026-10-10T18:00:00Z' }),
  task('t2', { kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Draft chapter four', estimate_min: 90, done_at: at(2, '10:30') }),
  task('t3', { kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Draft chapter five', estimate_min: 180, remaining_min: 120 }),
  task('t4', { kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Revise chapter three', estimate_min: 90 }),
  task('t5', { kind: 'project', project_id: 'p1', milestone_id: 'm3', title: 'Draft the closing chapter', estimate_min: 240 }),

  { type: 'project', id: 'p2', fields: { objective_id: 'g2', title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2026-11-30', weekly_aim: 180 } },
  { type: 'milestone', id: 'm4', fields: { project_id: 'p2', title: 'A starter that rises', due: '2026-10-30' } },
  { type: 'milestone', id: 'm5', fields: { project_id: 'p2', title: 'First good loaf', due: '2026-11-25' } },
  task('t6', { kind: 'project', project_id: 'p2', milestone_id: 'm4', title: 'Feed the starter twice a day', estimate_min: 60 }),
  task('t7', { kind: 'project', project_id: 'p2', milestone_id: 'm5', title: 'Bake a test loaf', estimate_min: 180 }),

  { type: 'project', id: 'p3', fields: { objective_id: 'g3', title: 'Paint the garden fence', state: 'active', start: '2026-11-01', end: '2027-01-31' } },
  { type: 'milestone', id: 'm6', fields: { project_id: 'p3', title: 'Supplies bought', due: '2026-11-10' } },
  task('t8', { kind: 'project', project_id: 'p3', milestone_id: 'm6', title: 'Measure the fence', estimate_min: 45 }),
  task('t9', { kind: 'project', project_id: 'p3', milestone_id: 'm6', title: 'Choose a colour', estimate_min: 30 }),
  task('t10', { kind: 'project', project_id: 'p3', title: 'Paint the first side', estimate_min: 240 }),

  { type: 'project', id: 'p4', fields: { objective_id: 'g3', title: 'Clear out the shed', state: 'paused', start: '2026-08-01', end: '2027-03-31' } },
  { type: 'project', id: 'p5', fields: { objective_id: 'g2', title: 'Try a rye bread', state: 'finished', start: '2026-06-01', end: '2026-08-31' } },

  { type: 'practice', id: 'pr1', fields: { title: 'Morning stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [450] } },
  { type: 'practice', id: 'pr2', fields: { objective_id: 'g1', title: 'Read fiction', target_min: 120, per: 'week', state: 'active', preferred_times: [1260] } },

  task('o1', { kind: 'one_off', title: 'Renew the library card', estimate_min: 30, schedule: { type: 'once', from: '2026-11-04' } }),
  task('o2', { kind: 'one_off', title: 'Pay the water bill', estimate_min: 15, schedule: { type: 'recurring', every: 1, unit: 'month', anchor: '2026-10-06' }, next_due: '2026-11-06' }),
  task('o3', { kind: 'one_off', title: 'Descale the kettle', estimate_min: 20, schedule: { type: 'window', min: 2, max: 3, unit: 'month' }, next_due: '2026-12-01' }),
  task('o4', { kind: 'one_off', title: 'Wash the windows', estimate_min: 90, schedule: { type: 'seasonal', months: [4, 10] }, next_due: '2027-04-01' }),
  task('o5', { kind: 'one_off', title: 'Sort old photos', estimate_min: 60 }),
  task('o6', { kind: 'one_off', title: 'Return the borrowed ladder', estimate_min: 20, done_at: at(3, '18:00') }),
  { type: 'task_completion', id: 'c1', fields: { task_id: 'o6', done_at: at(3, '18:00') } },

  task('i1', { kind: 'inbox', title: 'Look up a bike repair shop' }),
  task('i2', { kind: 'inbox', title: 'Order more coffee beans', estimate_min: 15 }),
  task('i3', { kind: 'inbox', title: 'Ideas for the garden in spring' }),

  { type: 'week_plan', id: `week:${WEEK}`, fields: { week_start: WEEK, finished_at: at(2, '08:00') } },
  pick('t3', 180),
  pick('t4', 90),
  pick('t6', 60),
  pick('t7', 180),
  pick('t8', 45),
  pick('o1', 30),
  pick('o2', 15),

  // Monday
  block('b1', { practice: 'pr1' }, 2, '07:30', '07:45'),
  block('b2', { task: 't2' }, 2, '09:00', '10:30', { started_at: at(2, '09:02') }),
  block('b3', { task: 't6' }, 2, '14:00', '15:00'),
  // Tuesday
  block('b4', { practice: 'pr1' }, 3, '07:30', '07:45'),
  block('b5', { task: 't3' }, 3, '09:00', '11:00'),
  block('b6', { practice: 'pr2' }, 3, '21:00', '21:30'),
  // Wednesday, today
  block('b7', { practice: 'pr1' }, 4, '07:30', '07:45'),
  block('b8', { task: 't4' }, 4, '10:00', '11:30', { started_at: at(4, '10:01') }),
  block('b9', { task: 'o1' }, 4, '12:00', '12:30'),
  block('b10', { task: 't7' }, 4, '15:00', '17:00'),
  // Thursday
  block('b11', { practice: 'pr1' }, 5, '07:30', '07:45'),
  block('b12', { task: 't3' }, 5, '09:00', '11:00'),
  block('b13', { task: 't8' }, 5, '16:00', '16:45'),
  // Friday
  block('b14', { practice: 'pr1' }, 6, '07:30', '07:45'),
  block('b15', { task: 'o2' }, 6, '11:00', '11:15'),
  block('b16', { practice: 'pr2' }, 6, '21:00', '22:00'),
  // Saturday
  block('b17', { task: 't7' }, 7, '10:00', '11:00'),

  outcome('b1', 'done', { logged_min: 15 }),
  outcome('b2', 'done'),
  outcome('b3', 'partly', { remaining_min: 30 }),
  outcome('b4', 'done', { logged_min: 15 }),
  outcome('b5', 'not'),
  outcome('b6', 'done', { logged_min: 30 }),
  outcome('b7', 'done', { logged_min: 10 }),

  { type: 'calendar_source', id: 'cs1', fields: { google_id: 'work', name: 'Work', mode: 'block' } },
  { type: 'calendar_source', id: 'cs2', fields: { google_id: 'family', name: 'Family', mode: 'info' } },
  {
    type: 'calendar',
    id: 'calendar',
    fields: {
      connected: true,
      synced_at: at(4, '10:00'),
      events: [
        { id: 'e1', calendar: 'work', title: 'Team meeting', start: at(4, '13:00'), end: at(4, '14:00') },
        { id: 'e2', calendar: 'work', title: 'Car service', start: at(5, '14:00'), end: at(5, '15:00') },
        { id: 'e3', calendar: 'family', title: 'School play', start: at(6, '18:00'), end: at(6, '19:30') },
      ],
    },
  },
];

async function visible(page: Page) {
  return page.locator('.flowpane, .pane[aria-hidden="false"]').last();
}

/** Screenshots the visible page top to bottom, and checks nothing scrolls sideways. */
async function look(page: Page, info: TestInfo, name: string) {
  await page.waitForTimeout(150);
  const pane = await visible(page);
  const size = await pane.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, height: el.scrollHeight, view: el.clientHeight }));
  expect(size.scroll, `${name} scrolls sideways`).toBeLessThanOrEqual(size.client);
  const body = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(body.scroll, `${name} widens the page`).toBeLessThanOrEqual(body.client);
  for (let i = 0, top = 0; i < 4 && top < size.height; i++, top += size.view) {
    await pane.evaluate((el, y) => el.scrollTo({ top: y }), top);
    await page.screenshot({ path: info.outputPath(`${name}-${i}.png`), scale: 'css' });
  }
  await pane.evaluate((el) => el.scrollTo({ top: 0 }));
}

async function tab(page: Page, phone: boolean, name: string) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone && !['Today', 'Week', 'Inbox', 'Goals'].includes(name)) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.locator('.pane[aria-hidden="false"]').getByRole('button', { name: new RegExp(`^${name}`) }).click();
  } else {
    await nav.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  }
  await expect(page.locator(`.pane[aria-hidden="false"][aria-label="${name}"] h1, .pane[aria-hidden="false"][aria-label="${name}"] h2`).first()).toBeVisible();
}

test('every screen of a lived-in week renders cleanly', async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, week);
  await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  await look(page, info, 'today');

  // A toast floats over the page in the app's own type, with Undo in reach.
  await page.getByRole('region', { name: 'Current block' }).getByRole('button', { name: 'Mark done now' }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Marked done after 19m.');
  expect(await toast.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  expect(await toast.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Instrument Sans');
  await page.screenshot({ path: info.outputPath('toast.png'), scale: 'css' });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('region', { name: 'Current block' }).getByRole('button', { name: 'Mark done now' })).toBeVisible();

  for (const name of ['Week', 'Inbox', 'Goals', 'Plan', 'One offs', 'Analytics', 'Settings']) {
    await tab(page, phone, name);
    await look(page, info, name.toLowerCase().replace(' ', ''));
  }
  if (phone) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
    await look(page, info, 'more');
  }

  await tab(page, phone, 'Goals');
  await page.getByRole('button', { name: /^Write a book/ }).first().click();
  await look(page, info, 'goal');
  await page.getByRole('button', { name: /^Finish the first draft/ }).first().click();
  await look(page, info, 'project');

  await tab(page, phone, 'Inbox');
  await page.getByRole('button', { name: /^Process 3 items/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(150);
  await page.screenshot({ path: info.outputPath('process.png'), scale: 'css' });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: phone ? 'Capture a task' : /^Capture/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Capture' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('capture.png'), scale: 'css' });
  await page.keyboard.press('Escape');

  expect(errors).toEqual([]);
});

test('the planning flows of a lived-in week render cleanly', async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, week);

  await tab(page, phone, 'Week');
  await page.getByRole('button', { name: 'Next week' }).first().click();
  await page.getByRole('button', { name: /^Plan next week|^Start planning/ }).first().click();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await expect(steps).toBeVisible();
  for (const step of ['Inbox', 'Pick', 'Schedule', 'Review']) {
    await steps.getByRole('button', { name: new RegExp(step) }).click();
    await look(page, info, `planning-${step.toLowerCase().replace(' ', '')}`);
  }
  await page.getByRole('button', { name: 'Save and exit' }).click();

  await tab(page, phone, 'Plan');
  await page.getByRole('button', { name: /planning|Plan now|Plan (the next|your first) stretch/ }).first().click();
  const planSteps = page.getByRole('navigation', { name: /steps/ });
  await expect(planSteps).toBeVisible();
  for (const step of ['Look back', 'Practices', 'Projects', 'Time', 'Finish']) {
    await planSteps.getByRole('button', { name: new RegExp(step) }).click();
    await look(page, info, `plan-${step.toLowerCase().replace(' ', '')}`);
  }
  expect(errors).toEqual([]);
});

test('the links between areas reach their page and come back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, week);
  const shown = (label: string) => page.locator(`.pane[aria-hidden="false"][aria-label="${label}"]`);

  if (phone) {
    // Today: work that needs a new time goes to the Week, ready to place, and Cancel comes back.
    await page.getByRole('button', { name: /needs? a new time/ }).click();
    await page.getByRole('dialog', { name: 'Needs a new time' }).getByRole('button', { name: 'Place on calendar' }).click();
    await expect(shown('Week')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(shown('Today')).toBeVisible();
    // Back where it was left, sheet and all.
    await page.getByRole('dialog', { name: 'Needs a new time' }).getByRole('button', { name: 'Close' }).click();
  }

  // Week to that week's analytics, and back.
  await tab(page, phone, 'Week');
  await page.getByRole('button', { name: "See this week's analytics" }).click();
  await expect(shown('Analytics')).toBeVisible();
  await expect(shown('Analytics').getByText('Nov 2 to Nov 8', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Week' }).click();
  await expect(shown('Week')).toBeVisible();

  // Inbox: one item straight into Process.
  await tab(page, phone, 'Inbox');
  await shown('Inbox').getByRole('button', { name: phone ? /^Order more coffee beans/ : 'Assign' }).nth(phone ? 0 : 1).click();
  await expect(page.getByRole('dialog')).toContainText('Order more coffee beans');
  await page.keyboard.press('Escape');

  // Settings to the cadence, edited in place on the Plan page.
  await tab(page, phone, 'Settings');
  await page.getByRole('button', { name: 'Change planning cadence' }).click();
  await expect(shown('Plan')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Change planning cadence' })).toBeVisible();
  expect(errors).toEqual([]);
});
