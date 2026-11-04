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

test('plans the next stretch: a milestone in by name and by dragging, then Finish', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openPlan(page, phone);
  await expect(page.getByText('This stretch: Oct 1 to Dec 31. Next planning: Dec 24.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current plan, Oct 1 to Dec 31' })).toContainText('No milestones in this plan.');

  await page.getByRole('button', { name: 'Plan now' }).click();
  await expect(page.getByRole('heading', { name: 'How is Oct 1 to Dec 31 going?' })).toBeVisible();
  if (phone) await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await steps.getByRole('button', { name: /Projects$/ }).click();
  await expect(page.getByRole('heading', { name: 'What will you reach by Mar 31?' })).toBeVisible();

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

  await steps.getByRole('button', { name: /Finish$/ }).click();
  await expect(page.getByRole('heading', { name: 'Ready for Jan 1 to Mar 31' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'What changed' })).toContainText('Added Share a loaf to this plan');
  await (phone ? page.locator('.flowdock').getByRole('button', { name: 'Finish' }) : page.getByRole('button', { name: 'Finish', exact: true })).click();
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
  await expect(page.getByRole('heading', { name: 'How have the last few weeks gone?' })).toBeVisible();
  await expect(page.getByText('Your first stretch: Nov 2 to Dec 31')).toBeVisible();
  await page.getByRole('button', { name: 'Change' }).click();
  const dates = page.getByRole('form', { name: 'First stretch dates' });
  await dates.getByLabel('Ends').fill('2027-01-31');
  await dates.getByRole('button', { name: 'Set dates' }).click();
  await expect(page.getByText('Your first stretch: Nov 2 to Jan 31')).toBeVisible();

  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await steps.getByRole('button', { name: /Projects$/ }).click();
  await expect(page.getByRole('heading', { name: 'What will you reach by Jan 31?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take milestone First loaf out of this plan' })).toHaveAttribute('aria-pressed', 'true');
  await steps.getByRole('button', { name: /Finish$/ }).click();
  await expect(page.getByRole('heading', { name: 'Ready for Nov 2 to Jan 31' })).toBeVisible();
  await (phone ? page.locator('.flowdock').getByRole('button', { name: 'Finish' }) : page.getByRole('button', { name: 'Finish', exact: true })).click();
  await expect(page.getByText('Your plan for Nov 2 to Jan 31 is set.')).toBeVisible();
  await expect(page.getByText('This stretch: Nov 2 to Jan 31. Next planning: Jan 24.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current plan, Nov 2 to Jan 31' })).toContainText('First loaf');
  expect(errors).toEqual([]);
});

test('types a date for a milestone, changes cadence in place, and resumes planning', async ({ page }, info) => {
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
  await page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: /Projects$/ }).click();
  await expect(page.getByRole('heading', { name: 'What will you reach by Feb 11?' })).toBeVisible();
  await page.getByRole('button', { name: 'Change the date of First loaf, Jan 20' }).click();
  const form = page.getByRole('form', { name: 'Date for First loaf' });
  await form.getByLabel('Date for First loaf').fill('2027-02-01');
  await form.getByRole('button', { name: 'Set date' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo: First loaf, Feb 1.' })).toBeVisible();

  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(page.getByRole('button', { name: 'Continue planning' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue planning' }).click();
  await expect(page.getByRole('heading', { name: 'What will you reach by Feb 11?' })).toBeVisible();
  expect(errors).toEqual([]);
});
