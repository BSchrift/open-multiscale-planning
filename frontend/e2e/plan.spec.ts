import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

// Monday Nov 2, 2026, 2pm. Calendar quarters: this stretch is Oct 1 to Dec 31, the next Jan 1 to Mar 31.
const NOW = new Date('2026-11-02T20:00:00Z');

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2027-06-30' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'First loaf', due: '2027-01-20' } },
  { type: 'milestone', id: 'm2', fields: { project_id: 'p1', title: 'Share a loaf', due: '2027-05-01' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Shape the dough', estimate_min: 120 } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Invite friends', estimate_min: 60 } },
  { type: 'practice', id: 'pr1', fields: { title: 'Stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [420] } },
];
// This stretch has been planned, so planning is for the next one.
const planned: Seed = { type: 'settings', id: 'settings', fields: { plan_stretch: { last_planned: '2026-10-01' } } };

async function openPlan(page: Page, phone: boolean, seeds: readonly Seed[] = [...records, planned]) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, seeds);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Plan/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Plan' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible();
}

const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const finish = (page: Page, phone: boolean) => (phone ? page.locator('.flowdock').getByRole('button', { name: 'Finish' }) : page.getByRole('button', { name: 'Finish', exact: true }));
const main = (page: Page, phone: boolean, name: string) => (phone ? page.locator('.flowbot').getByRole('button', { name }) : page.getByRole('button', { name }));

test('plans the next stretch: a milestone in by name and by dragging, then Finish', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openPlan(page, phone);
  await expect(page.getByText('This stretch: Oct 1 to Dec 31. Next planning: Dec 24.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current plan, Oct 1 to Dec 31' })).toContainText('No milestones in this plan.');

  await page.getByRole('button', { name: 'Plan now' }).click();
  await expect(page.getByRole('heading', { name: 'Step 1 of 5, Goals. Are these still your goals?' })).toBeFocused();
  if (phone) await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await steps.getByRole('button', { name: /Projects/ }).click();
  await expect(page.getByRole('heading', { name: 'Step 3 of 5, Projects. What will you reach by Mar 31?' })).toBeFocused();

  // By name, with the pinned Undo.
  const add = page.getByRole('button', { name: 'Add milestone Share a loaf to this plan' });
  if (phone) await expectTapTarget(add);
  await add.click();
  const undo = page.getByRole('button', { name: 'Undo: Added Share a loaf to this plan, by Mar 31.' });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(add).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: /^Undo:/ })).toHaveCount(0);

  // By dragging its hollow diamond into the band.
  const diamond = page.getByRole('button', { name: 'Milestone: Share a loaf, May 1, not in this plan. Change its date' });
  if (phone) await expectTapTarget(diamond);
  const track = page.getByRole('group', { name: /^Bake a sourdough loaf, Oct 1 to Jun 30/ });
  const box = (await track.boundingBox())!;
  const from = (await diamond.boundingBox())!;
  // The axis runs from two weeks before today to a week after the latest end.
  const lo = day('2026-10-19');
  const hi = day('2027-07-07');
  const x = box.x + ((day('2027-02-15') - lo) / (hi - lo)) * box.width;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, from.y + from.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /^Undo: Added Share a loaf to this plan, Feb 1\d\.$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take milestone Share a loaf out of this plan' })).toHaveAttribute('aria-pressed', 'true');
  await expect(phone ? page.locator('.flowbot').getByRole('button', { name: 'Continue with 2 milestones' }) : page.getByRole('button', { name: 'Continue with 2 milestones' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('projects.png') });

  await steps.getByRole('button', { name: /Finish/ }).click();
  await expect(page.getByRole('heading', { name: /Ready for Jan 1 to Mar 31$/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'What changed' })).toContainText('Added Share a loaf to this plan');
  await finish(page, phone).click();
  await expect(page.getByText('Your plan for Jan 1 to Mar 31 is set.')).toBeVisible();
  const nextPlan = page.getByRole('region', { name: 'Next plan, Jan 1 to Mar 31' });
  await expect(nextPlan).toContainText('Share a loaf');
  await expect(nextPlan).toContainText('First loaf');
  await page.screenshot({ path: info.outputPath('plan.png') });
  expect(errors).toEqual([]);
});

test('never planned, plans this stretch from today, its end changed, then the next comes as before', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openPlan(page, phone, records);

  await expect(page.getByText('This stretch: Nov 2 to Dec 31. Time to plan your first stretch.')).toBeVisible();
  await page.getByRole('button', { name: 'Plan your first stretch' }).click();
  await expect(page.getByRole('heading', { name: /Are these still your goals\?$/ })).toBeVisible();
  await expect(page.getByText('Your first stretch: Nov 2 to Dec 31')).toBeVisible();
  await page.getByRole('button', { name: 'Change' }).click();
  const dates = page.getByRole('form', { name: 'First stretch dates' });
  await dates.getByLabel('Ends').fill('2027-01-31');
  await dates.getByRole('button', { name: 'Set dates' }).click();
  await expect(page.getByText('Your first stretch: Nov 2 to Jan 31')).toBeVisible();

  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await steps.getByRole('button', { name: /Projects/ }).click();
  await expect(page.getByRole('heading', { name: /What will you reach by Jan 31\?$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take milestone First loaf out of this plan' })).toHaveAttribute('aria-pressed', 'true');
  await steps.getByRole('button', { name: /Finish/ }).click();
  await expect(page.getByRole('heading', { name: /Ready for Nov 2 to Jan 31$/ })).toBeVisible();
  await finish(page, phone).click();
  await expect(page.getByText('Your plan for Nov 2 to Jan 31 is set.')).toBeVisible();
  await expect(page.getByText('This stretch: Nov 2 to Jan 31. Next planning: Jan 24.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current plan, Nov 2 to Jan 31' })).toContainText('First loaf');
  expect(errors).toEqual([]);
});

test('types a date for a milestone, changes cadence in place, and resumes planning where it was, with Undo still there', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openPlan(page, phone);

  await page.getByRole('button', { name: 'Change planning cadence' }).click();
  const editor = page.getByRole('group', { name: 'Change planning cadence' });
  await editor.getByRole('combobox', { name: 'How often' }).selectOption('every');
  await editor.getByRole('slider', { name: 'Every' }).fill('6');
  await editor.getByRole('combobox', { name: 'In' }).selectOption('weeks');
  if (phone) await expectTapTarget(editor.getByRole('combobox', { name: 'In' }));
  await expect(editor).toContainText('Next stretch: Jan 1 to Feb 11');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Every 6 weeks' })).toBeVisible();
  await expect(page.getByText('Your new cadence starts Jan 1.')).toBeVisible();

  await page.getByRole('button', { name: 'Plan now' }).click();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await main(page, phone, 'Goals look right').click();
  await steps.getByRole('button', { name: /Projects/ }).click();
  await expect(page.getByRole('heading', { name: /What will you reach by Feb 11\?$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Change the date of First loaf, Jan 20' }).click();
  const form = page.getByRole('form', { name: 'Date for First loaf' });
  await form.getByLabel('Date for First loaf').fill('2027-02-01');
  await form.getByRole('button', { name: 'Set date' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo: First loaf, Feb 1.' })).toBeVisible();

  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(page.getByRole('button', { name: 'Continue planning' })).toBeVisible();
  // Kept on the device: after a reload too, planning comes back to the same step, with the same Undo.
  await page.waitForTimeout(600);
  await page.reload();
  if (phone) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Plan/ }).click();
  } else {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Plan' }).click();
  }
  await page.getByRole('button', { name: 'Continue planning' }).click();
  await expect(page.getByRole('heading', { name: /What will you reach by Feb 11\?$/ })).toBeVisible();
  await expect(page.locator('.welcome').getByText('Welcome back. Goals are done. You were on Projects.')).toBeVisible();
  await expect(steps.getByRole('button', { name: /Goals, done$/ })).toBeVisible();
  await steps.getByRole('button', { name: /Finish/ }).click();
  const changed = page.getByRole('region', { name: 'What changed' });
  await changed.getByRole('button', { name: 'Undo: First loaf, Feb 1.' }).click();
  await expect(changed).toContainText('You kept everything as it was.');
  await steps.getByRole('button', { name: /Projects/ }).click();
  await expect(page.getByRole('button', { name: 'Change the date of First loaf, Jan 20' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a goal’s projects are blocks that open a preview over Goals, and the project itself after saving planning', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openPlan(page, phone);
  await page.getByRole('button', { name: 'Plan now' }).click();
  const heading = page.getByRole('heading', { name: 'Step 1 of 5, Goals. Are these still your goals?' });
  await expect(heading).toBeFocused();
  const block = page.getByRole('region', { name: 'Learn to bake bread' }).getByRole('button', { name: 'Open project Bake a sourdough loaf' });
  await expect(block).toContainText('On track');
  await page.screenshot({ path: info.outputPath(`goals-step-${info.project.name}.png`) });

  // From the keyboard on desktop, from a tap on phone; either way, closing gives focus back to the block.
  if (phone) {
    await expectTapTarget(block);
    await block.click();
  } else {
    for (let i = 0; i < 10 && !(await block.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(block).toBeFocused();
    await page.keyboard.press('Enter');
  }
  const sheet = page.getByRole('dialog', { name: 'Bake a sourdough loaf' });
  await expect(sheet.getByText('Goal: Learn to bake bread. Runs Oct 1 to Jun 30.')).toBeVisible();
  await expect(sheet.getByRole('img', { name: /Milestone First loaf, due Jan 20/ })).toBeVisible();
  const close = sheet.getByRole('button', { name: 'Close', exact: true });
  const open = sheet.getByRole('button', { name: 'Open project in Goals' });
  if (phone) await Promise.all([expectTapTarget(close), expectTapTarget(open)]);
  await expect(open).toBeInViewport();
  await page.screenshot({ path: info.outputPath(`project-preview-${info.project.name}.png`) });
  if (phone) await close.click();
  else await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(block).toBeFocused();
  await expect(heading).toBeVisible();

  await block.click();
  await open.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Bake a sourdough loaf' })).toBeVisible();
  await expect(page.getByText('Planning is saved, so you can continue it later.')).toBeVisible();
  // Phone keeps the Plan page under More, as it was left.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: phone ? 'More' : 'Plan' }).click();
  await page.getByRole('button', { name: 'Continue planning' }).click();
  await expect(page.locator('.welcome').getByText('Welcome back. You were on Goals.')).toBeVisible();
  await expect(heading).toBeFocused();
  expect(errors).toEqual([]);
});

test('Goals asks for some when there are none, and the Inbox lists a big one whole, with Process over an inert flow', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const inbox: Seed[] = Array.from({ length: 214 }, (_, i) => ({ type: 'task', id: `i${i}`, fields: { kind: 'inbox', title: `Inbox item ${i + 1}` } }));
  await openPlan(page, phone, [planned, ...inbox]);
  await page.getByRole('button', { name: 'Plan now' }).click();
  await expect(page.getByRole('heading', { name: 'Step 1 of 5, Goals. What are your goals?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New goal' })).toBeVisible();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await expect(steps.getByRole('button', { name: /Inbox, 214 items$/ })).toBeVisible();
  await main(page, phone, 'Continue without goals').click();
  await steps.getByRole('button', { name: /Inbox/ }).click();
  await expect(page.getByText('214 items. If one needs a new project, practice or goal, make it from its card.')).toBeVisible();
  await expect(page.getByText('Inbox item 214', { exact: true })).toBeAttached();
  await main(page, phone, 'Process 214 items').click();
  const cards = page.getByRole('dialog', { name: 'Process Inbox' });
  await expect(cards).toBeVisible();
  // Behind Process the flow is inert, so a screen reader stays on the cards.
  await expect(page.locator('.planflow')).toHaveAttribute('inert', '');
  await cards.getByRole('button', { name: /^One offs/ }).click();
  await expect(cards.getByText('Sent to One offs.')).toBeVisible();
  await (phone ? cards.getByRole('button', { name: 'Back to planning' }).click() : page.keyboard.press('Escape'));
  await expect(page.getByText('1 sorted. 213 still in your Inbox.')).toBeFocused();
  await expect(steps.getByRole('button', { name: /Inbox, 213 items$/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an empty Inbox says so, and goes on to Finish', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openPlan(page, phone);
  await page.getByRole('button', { name: 'Plan now' }).click();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await steps.getByRole('button', { name: /Inbox/ }).click();
  await expect(page.getByText('Your Inbox is empty. Anything you capture lands here.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Process/ })).toHaveCount(0);
  await main(page, phone, 'Continue to Finish').click();
  await expect(page.getByRole('heading', { name: /Ready for Jan 1 to Mar 31$/ })).toBeFocused();
});

test('Add makes a goal from any step, Esc gives focus back to it, and Undo takes it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openPlan(page, phone);
  await page.getByRole('button', { name: 'Plan now' }).click();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await steps.getByRole('button', { name: /Practices/ }).click();
  const add = page.getByRole('button', phone ? { name: 'Add a goal, practice, project or Inbox task' } : { name: '+ Add', exact: true });
  if (phone) await expectTapTarget(add);
  await add.click();
  const menu = page.getByRole('dialog', { name: 'Add' });
  await expect(menu.getByRole('button').first()).toHaveText('Practice');
  if (phone) await expectTapTarget(menu.getByRole('button', { name: 'Goal' }));
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await add.click();
  await menu.getByRole('button', { name: 'Goal' }).click();
  await page.getByRole('textbox', { name: 'New goal' }).fill('Keep fit');
  await page.getByRole('form', { name: 'Add goal' }).getByRole('button', { name: 'Add goal' }).click();
  await expect(add).toBeFocused();
  await page.getByRole('button', { name: 'Undo: Added goal Keep fit.' }).click();
  await steps.getByRole('button', { name: /Goals/ }).click();
  await expect(page.getByRole('region', { name: 'Learn to bake bread' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Keep fit' })).toHaveCount(0);
});

test('Add opens over the pinned Does it fit line, so every kind can be picked where it is drawn', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openPlan(page, phone);
  await page.getByRole('button', { name: 'Plan now' }).click();
  await expect(page.getByRole('region', { name: 'Does it fit?' })).toBeVisible();
  await page.getByRole('button', phone ? { name: 'Add a goal, practice, project or Inbox task' } : { name: '+ Add', exact: true }).click();
  const kinds = page.getByRole('dialog', { name: 'Add' }).locator('.addmenu').getByRole('button');
  await expect(kinds).toHaveText(['Goal', 'Task to Inbox', 'Project', 'Practice']);
  // What's drawn at each button's centre is that button, not the pinned line over it, so a click there picks it.
  for (const kind of await kinds.all()) {
    const hit = await kind.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return el.contains(top) ? 'itself' : (top?.closest('[class]')?.className ?? 'nothing');
    });
    expect(hit, `what's drawn over ${await kind.textContent()}`).toBe('itself');
  }
});

