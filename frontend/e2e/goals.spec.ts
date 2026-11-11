import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'objective', id: 'g2', fields: { title: 'Run a 10k', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Make a starter', due: '2026-10-25' } },
  { type: 'milestone', id: 'm2', fields: { project_id: 'p1', title: 'First loaf', due: '2026-11-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Mix flour and water', estimate_min: 60, done_at: '2026-10-20T15:00:00Z' } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Feed the starter', estimate_min: 120 } },
  { type: 'task', id: 't3', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Shape the dough', estimate_min: 240 } },
  { type: 'practice', id: 'pr1', fields: { title: 'Stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [420] } },
];

async function openGoals(page: Page) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();
}

async function openProject(page: Page, phone: boolean) {
  await page.getByRole('button', { name: /^Learn to bake bread/ }).click();
  await page.getByRole('button', { name: /^Bake a sourdough loaf/ }).click();
  if (phone) await expect(page.getByRole('heading', { level: 1, name: 'Bake a sourdough loaf' })).toBeVisible();
}

test('answers the overdue question and adds and edits tasks on a project', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openGoals(page);
  await expect(page.getByRole('button', { name: /^Learn to bake bread/ })).toContainText('Overdue');
  // Just seeded, so it isn't asked whether it's still a goal; that waits until nothing under it changes for a cadence.
  await expect(page.getByRole('button', { name: /^Run a 10k/ })).not.toContainText('Still a goal');
  await openProject(page, phone);

  const fix = page.getByRole('group', { name: 'Make a starter was due Oct 25' });
  await expect(fix).toContainText('1 of 2 tasks done, 2h left.');
  await fix.getByRole('button', { name: 'Move date' }).click();
  await expect(fix).toContainText('Project goes from Overdue to Behind.');
  await fix.getByRole('button', { name: 'Move to Nov 9' }).click();
  await expect(page.getByText('Nov 2: Moved Make a starter from Oct 25 to Nov 9. Project went from Overdue to Behind.')).toBeVisible();
  await expect(page.getByText('Replanned: 15 days later')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(fix).toBeVisible();

  // The next open milestone starts open; the rest are folded with their progress on the row.
  await expect(page.getByRole('button', { name: 'Make a starter tasks' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'First loaf tasks' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('group', { name: 'Milestone: First loaf' })).toContainText('0 of 1 done, due Nov 20');

  // Ticking the milestone's last open task answers the question, and the task goes behind Show completed with Undo,
  // focus landing there; shown again, unticking brings the question back.
  const check = page.getByRole('checkbox', { name: 'Feed the starter done' });
  if (phone) await expectTapTarget(page.locator('.taskcheck').first());
  await check.click();
  await expect(fix).toHaveCount(0);
  await expect(page.getByText('Completed Feed the starter.')).toBeVisible();
  await expect(check).toHaveCount(0);
  const starter = page.getByRole('group', { name: 'Milestone: Make a starter' });
  const show = starter.getByRole('button', { name: 'Show 2 completed' });
  await expect(show).toBeFocused();
  if (phone) await expectTapTarget(show);
  await show.click();
  await expect(starter.getByRole('button', { name: 'Hide completed' })).toHaveAttribute('aria-expanded', 'true');
  // A click, as uncheck() wants the box changed at once, and it shows what was saved, a moment later.
  await check.click();
  await expect(fix).toBeVisible();

  const add = page.getByRole('button', { name: 'Add task to Make a starter' });
  if (phone) await expectTapTarget(add);
  await add.click();
  const editor = page.getByRole('dialog', { name: 'Add task' });
  await expect(editor).toBeVisible();
  // WebKit draws a native select at its own height whatever min-height says, so check one is a full target.
  if (phone) await expectTapTarget(editor.getByRole('combobox', { name: 'Milestone' }));
  await editor.getByLabel('Title').fill('Proof the dough');
  await editor.getByRole('button', { name: 'Add' }).click();
  await expect(editor.getByText('Added Proof the dough.')).toBeVisible();
  if (phone) await expectTapTarget(editor.getByRole('button', { name: 'Done' }));
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit task Proof the dough, 1h' })).toBeVisible();

  // From the keyboard: Enter opens the task's popup, Esc closes it and puts focus back on its row.
  const row = page.getByRole('button', { name: 'Edit task Feed the starter, 2h' });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Feed the starter' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row).toBeFocused();

  await page.screenshot({ path: info.outputPath('project.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('adds a goal and a project, finishes it after asking, and restores it from Archived', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openGoals(page);
  if (phone) await page.getByRole('button', { name: '+ New goal' }).click();
  await page.getByRole('textbox', { name: 'New goal' }).fill('Write a book');
  await page.getByRole('textbox', { name: 'New goal' }).press('Enter');
  await page.getByRole('button', { name: /^Write a book/ }).click();

  await page.getByRole('button', { name: phone ? '+ Project' : 'Add project' }).click();
  const form = page.getByRole('form', { name: 'Add project' });
  await form.getByLabel('Name').fill('Draft chapters');
  await form.getByLabel('Ends').fill('2027-02-01');
  await form.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByText('Project added, Nov 2 to Feb 1.')).toBeVisible();
  // WebKit doesn't focus a tapped button, so only desktop has focus to give back.
  if (!phone) await expect(page.getByRole('button', { name: 'Add project' })).toBeFocused();

  await page.getByRole('button', { name: /^Draft chapters/ }).click();
  await page.getByRole('button', { name: 'Project settings' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByText('Finish this project?')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, finish' }).click();
  await expect(page.getByText('Finished. Open tasks cancelled.')).toBeVisible();
  if (phone) await expect(page.getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();

  await page.getByRole('button', { name: 'Archived (1)' }).click();
  await page.getByRole('button', { name: 'Restore Draft chapters' }).click();
  await expect(page.getByRole('button', { name: /^Draft chapters/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('goals.png'), fullPage: true });
});

test('Project settings open in a dialog: Esc drops changes, Save applies them, and Finish and Drop are red', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openGoals(page);
  await openProject(page, phone);
  const settings = page.getByRole('button', { name: 'Project settings' });
  await settings.click();
  const dialog = page.getByRole('dialog', { name: 'Project settings' });
  await expect(dialog.getByRole('button', { name: 'Change end date' })).toHaveCount(0);
  const drop = dialog.getByRole('button', { name: 'Drop', exact: true });
  await expect(drop).toHaveCSS('color', 'rgb(179, 38, 30)');
  await expect(dialog.getByRole('button', { name: 'Finish', exact: true })).toHaveCSS('color', 'rgb(179, 38, 30)');
  await drop.click();
  await expect(dialog.getByText('Drop this project?')).toBeVisible();
  // Off the button, so desktop's hover colour doesn't count.
  if (!phone) await page.mouse.move(0, 0);
  await expect(dialog.getByRole('button', { name: 'Yes, drop' })).toHaveCSS('background-color', 'rgb(179, 38, 30)');
  // Dark mode takes the dark palette's red.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(dialog.getByRole('button', { name: 'Yes, drop' })).toHaveCSS('background-color', 'rgb(240, 138, 128)');
  await page.emulateMedia({ colorScheme: 'light' });
  await dialog.getByRole('alert').getByRole('button', { name: 'Cancel dropping' }).click();
  // Back on Drop, though a tap on WebKit focuses the dialog rather than the button tapped.
  await expect(drop).toBeFocused();

  await dialog.getByLabel('Name').fill('Bake two loaves');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();

  await settings.click();
  await expect(dialog.getByLabel('Name')).toHaveValue('Bake a sourdough loaf');
  await dialog.getByLabel('Name').fill('Bake two loaves');
  await dialog.getByLabel('Ends').fill('2027-01-15');
  if (phone) await expectTapTarget(dialog.getByRole('button', { name: 'Save' }));
  await page.screenshot({ path: info.outputPath('project-settings.png') });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Nov 2: Done moved to Jan 15.')).toBeVisible();
  if (phone) await expect(page.getByRole('heading', { level: 1, name: 'Bake two loaves' })).toBeVisible();
  else await expect(page.getByRole('button', { name: /^Bake two loaves/ })).toBeVisible();
  await expect(settings).toBeFocused();
});

test('renames a goal from the pen in its title, and deletes it after a warning, with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openGoals(page);
  await page.getByRole('button', { name: /^Learn to bake bread/ }).click();
  const pen = page.getByRole('button', { name: 'Rename Learn to bake bread' });
  if (phone) await expectTapTarget(pen);
  await pen.click();
  const name = page.getByRole('textbox', { name: 'Goal name' });
  await expect(name).toBeFocused();
  await name.fill('Bake good bread');
  await name.press('Enter');
  await expect(page.getByRole('button', { name: /^Bake good bread/ })).toBeVisible();

  await page.getByRole('button', { name: 'Rename Bake good bread' }).click();
  const deleteGoal = page.getByRole('button', { name: 'Delete goal' });
  await deleteGoal.click();
  const ask = page.getByRole('dialog', { name: 'Delete Bake good bread?' });
  // Phone WebKit doesn't focus a tapped button, so this checks focus comes back to it anyway.
  await page.keyboard.press('Escape');
  await expect(deleteGoal).toBeFocused();
  await deleteGoal.click();
  await expect(ask).toContainText('1 project: Bake a sourdough loaf, with 2 milestones and 3 tasks');
  await page.screenshot({ path: info.outputPath('delete-goal.png') });
  await ask.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByText('Deleted Bake good bread.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Bake good bread/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Bake good bread/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Bake a sourdough loaf/ })).toBeVisible();
});

test('edits a practice with no goal and links it to one', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openGoals(page);
  await page.getByRole('button', { name: phone ? 'Practices with no goal' : 'Practices with no goal 1 practice', exact: true }).click();
  await page.getByRole('button', { name: /^Stretch/ }).click();
  const scope = phone ? page.getByRole('dialog', { name: 'Edit practice' }) : page;
  await expect(scope.getByRole('slider', { name: 'Target' })).toBeVisible();
  await scope.getByLabel('Goal', { exact: true }).selectOption('Run a 10k');
  if (phone) await scope.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /^Run a 10k/ })).not.toContainText('Still a goal');
  await page.getByRole('button', { name: /^Run a 10k/ }).click();
  await expect(page.getByRole('button', { name: /^Stretch/ })).toBeVisible();
});
