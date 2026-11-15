import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane, readRecord } from './seed';
import type { Seed } from './seed';

// Stretch planning's cadence choices and its way through the steps, beyond plan.spec.ts and the next-stretch journey.

test.use({ timezoneId: 'America/Chicago' });

// Monday Nov 2, 2026, 2pm. Calendar quarters: this stretch is Oct 1 to Dec 31, the next Jan 1 to Mar 31.
const NOW = new Date('2026-11-02T20:00:00Z');

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2027-06-30' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'First loaf', due: '2027-01-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Shape the dough', estimate_min: 120 } },
];
// This stretch has been planned, so planning is for the next one.
const planned: Seed = { type: 'settings', id: 'settings', fields: { plan_stretch: { last_planned: '2026-10-01' } } };
const noCadence: Seed = { type: 'settings', id: 'settings', fields: { plan_cadence: null } };

const steps = (page: Page) => page.getByRole('navigation', { name: 'Planning steps' });
const heading = (page: Page, name: string | RegExp) => page.getByRole('heading', { name });
/** A step's main button: in the bar along the bottom on phone. */
const main = (page: Page, phone: boolean, name: string) => (phone ? page.locator('.flowbot').getByRole('button', { name, exact: true }) : page.getByRole('button', { name, exact: true }));
const cadence = (page: Page) => pane(page, 'Plan').getByRole('region', { name: 'Planning cadence' });

async function goPlan(page: Page, phone: boolean) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    const back = page.getByRole('button', { name: 'Back to More' });
    if (await back.isVisible()) await back.click();
    await pane(page, 'More').getByRole('button', { name: /^Plan/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Plan' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Plan' })).toBeVisible();
}

async function open(page: Page, phone: boolean, seeds: readonly Seed[]) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, seeds);
  await goPlan(page, phone);
  return errors;
}

test('with no cadence, Start planning asks how often first, and the first stretch follows the choice', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone, [...records, noCadence]);
  await expect(cadence(page).getByRole('heading', { name: 'Set your planning cadence' })).toBeVisible();
  await cadence(page).getByRole('button', { name: 'Start planning' }).click();

  // Calendar quarters to start, from tomorrow.
  await expect(heading(page, 'Step 1 of 6, Start. How often do you want to plan?')).toBeFocused();
  const card = page.locator('.cadfields');
  await expect(card.getByLabel('Starting')).toHaveValue('2026-11-03');
  await expect(page.getByText('Your first stretch: Nov 3 to Dec 31')).toBeVisible();
  await card.getByRole('combobox', { name: 'How often' }).selectOption('every');
  await expect(page.getByText('Your first stretch: Nov 3 to Dec 2')).toBeVisible();
  await card.getByRole('combobox', { name: 'In' }).selectOption('weeks');
  await card.getByRole('slider', { name: 'Every' }).fill('6');
  await expect(card.getByRole('slider', { name: 'Every' })).toHaveAttribute('aria-valuetext', 'Every 6 weeks');
  await expect(page.getByText('Your first stretch: Nov 3 to Dec 14')).toBeVisible();
  if (phone) for (const name of ['How often', 'In']) await expectTapTarget(card.getByRole('combobox', { name }));
  await main(page, phone, 'Continue').click();
  await expect(heading(page, 'Step 2 of 6, Goals. Are these still your goals?')).toBeFocused();

  // Each change was saved as it was made.
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(cadence(page).getByRole('heading', { name: 'Every 6 weeks' })).toBeVisible();
  await expect(cadence(page).getByText('Your first stretch starts Nov 3.')).toBeVisible();
  await expect(cadence(page).getByRole('button', { name: 'Continue planning' })).toBeVisible();
  expect(errors).toEqual([]);
});

test("planned without a cadence, the stretch starts in three days, Finish says to plan whenever you like, and its toast's Undo takes the plan back", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone, [...records, noCadence]);
  await cadence(page).getByRole('button', { name: 'Plan without a cadence' }).click();
  await expect(heading(page, 'Step 1 of 5, Goals. Are these still your goals?')).toBeFocused();
  await expect(page.getByText('Planning for: Nov 5 to Feb 5')).toBeVisible();
  await steps(page).getByRole('button', { name: /Finish/ }).click();
  await expect(heading(page, /Ready for Nov 5 to Feb 5$/)).toBeFocused();
  await expect(page.getByText('Plan again whenever you like.')).toBeVisible();
  await (phone ? page.locator('.flowdock').getByRole('button', { name: 'Finish' }) : page.getByRole('button', { name: 'Finish', exact: true })).click();

  const toast = page.locator('.toast');
  await expect(toast).toContainText('Your plan for Nov 5 to Feb 5 is set.');
  const next = page.getByRole('region', { name: 'Next plan, Nov 5 to Feb 5' });
  await expect(next).toContainText('First loaf');
  // The first plan this device has made: Undo puts back settings that had no stretch at all.
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(next).toHaveCount(0);
  await expect(cadence(page).getByRole('button', { name: 'Continue planning' })).toBeVisible();
  expect((await readRecord(page, 'settings', 'settings'))?.plan_stretch ?? {}).not.toHaveProperty('last_planned');
  expect(errors).toEqual([]);
});

test('a new cadence can end this plan now, which opens planning for a stretch from tomorrow', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone, [...records, planned]);
  await cadence(page).getByRole('button', { name: 'Change planning cadence' }).click();
  const editor = page.getByRole('group', { name: 'Change planning cadence' });
  await editor.getByRole('combobox', { name: 'How often' }).selectOption('every');
  await editor.getByRole('slider', { name: 'Every' }).fill('2');
  // By default the change waits for this plan to end.
  const when = editor.getByRole('group', { name: 'When should it start?' });
  await expect(when.getByRole('radio', { name: 'When this plan ends, Dec 31' })).toBeChecked();
  await expect(editor.getByText('Next stretch: Jan 1 to Feb 28')).toBeVisible();
  const now = when.getByRole('radio', { name: 'End this plan now and start again' });
  if (phone) await expectTapTarget(now.locator('xpath=ancestor::label'));
  await now.check();
  await expect(editor.getByText('New stretch: Nov 3 to Jan 2')).toBeVisible();
  await editor.getByRole('button', { name: 'End this plan and start again' }).click();

  await expect(heading(page, 'Step 1 of 5, Goals. Are these still your goals?')).toBeFocused();
  await expect(page.getByText('Next stretch: Nov 3 to Jan 2')).toBeVisible();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(cadence(page).getByRole('heading', { name: 'Every 2 months' })).toBeVisible();
  await expect(cadence(page).getByText('This stretch: Oct 1 to Nov 2. Time to plan the next stretch.')).toBeVisible();
  await expect(cadence(page).getByRole('button', { name: 'Continue planning' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('turning the schedule off says there will be no stretches; Cancel keeps the cadence, and Save leaves planning to whenever you like', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone, [...records, planned]);
  const change = cadence(page).getByRole('button', { name: 'Change planning cadence' });
  await change.click();
  const editor = page.getByRole('group', { name: 'Change planning cadence' });
  const scheduled = editor.getByRole('checkbox', { name: 'Remind me to plan on a schedule' });
  if (phone) await expectTapTarget(scheduled.locator('xpath=ancestor::label'));
  await scheduled.uncheck();
  await expect(editor.getByText('No stretches or reminders. You can still plan whenever you like.')).toBeVisible();
  await expect(editor.getByRole('combobox', { name: 'How often' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toHaveCount(0);
  await expect(cadence(page).getByRole('heading', { name: 'Calendar quarters' })).toBeVisible();
  await expect(cadence(page).getByText('This stretch: Oct 1 to Dec 31. Next planning: Dec 24.')).toBeVisible();

  // Opened again, the editor starts from what's saved.
  await change.click();
  await expect(scheduled).toBeChecked();
  await scheduled.uncheck();
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(cadence(page).getByRole('heading', { name: 'Set your planning cadence' })).toBeVisible();
  await expect(cadence(page).getByRole('button', { name: 'Plan without a cadence' })).toBeVisible();
  expect((await readRecord(page, 'settings', 'settings'))?.plan_cadence).toBeNull();
  expect(errors).toEqual([]);
});

test('the step arrows move between steps, and Finish names the steps not looked at, with Look now', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone, [...records, planned]);
  await cadence(page).getByRole('button', { name: 'Plan now' }).click();
  await expect(heading(page, 'Step 1 of 5, Goals. Are these still your goals?')).toBeFocused();
  const back = (phone ? page.locator('.flowbot') : page.locator('.stepsnav')).getByRole('button', { name: 'Previous step' });
  if (phone) await expectTapTarget(back);
  await expect(back).toBeDisabled();
  // Phone has no Next arrow: the step's main button goes on.
  await (phone ? main(page, phone, 'Goals look right') : page.getByRole('button', { name: 'Next step' })).click();
  await expect(heading(page, 'Step 2 of 5, Practices. Your practices')).toBeFocused();
  await back.click();
  await expect(heading(page, 'Step 1 of 5, Goals. Are these still your goals?')).toBeFocused();
  await (phone ? main(page, phone, 'Goals look right') : page.getByRole('button', { name: 'Next step' })).click();
  await expect(heading(page, /^Step 2 of 5, Practices/)).toBeVisible();

  await steps(page).getByRole('button', { name: /Finish/ }).click();
  await expect(heading(page, /^Step 5 of 5, Finish/)).toBeFocused();
  if (!phone) await expect(page.getByRole('button', { name: 'Next step' })).toBeDisabled();
  await expect(page.getByText('Not looked at: Projects and Inbox.')).toBeVisible();
  await page.getByRole('button', { name: 'Look now' }).click();
  await expect(heading(page, 'Step 3 of 5, Projects. What will you reach by Mar 31?')).toBeFocused();
  await steps(page).getByRole('button', { name: /Finish/ }).click();
  await expect(page.getByText('Not looked at: Inbox.')).toBeVisible();
  await page.getByRole('button', { name: 'Look now' }).click();
  await expect(heading(page, /^Step 4 of 5, Inbox/)).toBeFocused();
  await steps(page).getByRole('button', { name: /Finish/ }).click();
  await expect(page.getByText(/^Not looked at/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Finish and plan the week sets the plan and opens weekly planning at its Inbox, and the toast's Undo takes the plan back", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone, [...records, planned, { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Rake the leaves' } }]);
  await cadence(page).getByRole('button', { name: 'Plan now' }).click();
  await steps(page).getByRole('button', { name: /Finish/ }).click();
  await main(page, phone, 'Finish and plan the week').click();

  const toast = page.locator('.toast');
  await expect(toast).toContainText('Your plan for Jan 1 to Mar 31 is set.');
  // Its Inbox wasn't sorted in this planning, so the week starts there.
  await expect(steps(page).locator('[aria-current="step"]')).toHaveText(phone ? 'Inbox' : '1. Inbox');
  await expect(page.getByRole('button', { name: 'Process 1 item' })).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toHaveCount(0);

  await page.getByRole('button', { name: 'Save and exit' }).click();
  await goPlan(page, phone);
  // Planning is back where it was, ready to continue, and the next stretch has no plan.
  await expect(cadence(page).getByRole('button', { name: 'Continue planning' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Next plan/ })).toHaveCount(0);
  expect((await readRecord(page, 'settings', 'settings'))?.plan_stretch).toEqual({ last_planned: '2026-10-01' });
  expect(errors).toEqual([]);
});
