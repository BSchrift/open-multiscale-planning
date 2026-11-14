import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, touchDrag } from './seed';
import type { Seed } from './seed';

// A project's milestones: the popover that renames and re-dates one and holds Mark met, Not met and Drop; the overdue
// question's other answers; and a task moved from one milestone to another. Every change has its Undo.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm

const records = (overdue: boolean): Seed[] => [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Make a starter', due: overdue ? '2026-10-25' : '2026-11-06' } },
  { type: 'milestone', id: 'm2', fields: { project_id: 'p1', title: 'First loaf', due: '2026-11-20' } },
  { type: 'milestone', id: 'm3', fields: { project_id: 'p1', title: 'Bake for friends', due: '2026-12-05' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Mix flour and water', estimate_min: 60, done_at: '2026-10-20T15:00:00Z' } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Feed the starter', estimate_min: 120 } },
  { type: 'task', id: 't3', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Shape the dough', estimate_min: 240 } },
  { type: 'task', id: 't4', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm2', title: 'Proof the dough', estimate_min: 60 } },
];

async function openProject(page: Page, phone: boolean, overdue = false) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records(overdue));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await page.getByRole('button', { name: /^Learn to bake bread/ }).click();
  await page.getByRole('button', { name: /^Bake a sourdough loaf/ }).click();
  if (phone) await expect(page.getByRole('heading', { level: 1, name: 'Bake a sourdough loaf' })).toBeVisible();
  return errors;
}

const milestone = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^Edit milestone ${name},`) });
const group = (page: Page, name: string) => page.getByRole('group', { name: `Milestone: ${name}` });
const changeLine = (page: Page) => page.locator('.changeline');

test("a milestone's popover renames and re-dates it with the project's status previewed, keeps unsaved changes on Esc, and Undo puts both back", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openProject(page, phone);
  await milestone(page, 'First loaf').click();
  const editor = page.getByRole('dialog', { name: 'Edit milestone' });
  await expect(editor.getByLabel('Name')).toHaveValue('First loaf');
  await expect(editor.getByLabel('Due date')).toHaveValue('2026-11-20');

  // A date before today is refused.
  await editor.getByLabel('Due date').fill('2026-10-30');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor.getByRole('alert')).toHaveText('Pick today or a later date.');

  await editor.getByLabel('Name').fill('First two loaves');
  await editor.getByLabel('Due date').fill('2026-12-10');
  await expect(editor.getByText('Project stays Behind.')).toBeVisible();
  await expect(editor.getByText('This puts it after Bake for friends.')).toBeVisible();
  // Esc keeps what was typed and says so, with focus on Save.
  await page.keyboard.press('Escape');
  await expect(editor.getByRole('alert')).toHaveText("Your changes aren't saved. Save them, or Cancel to drop them.");
  await expect(editor.getByRole('button', { name: 'Save' })).toBeFocused();
  await expect(editor.getByLabel('Name')).toHaveValue('First two loaves');
  if (phone) for (const name of ['Save', 'Cancel', 'Drop milestone']) await expectTapTarget(editor.getByRole('button', { name, exact: true }));
  await page.screenshot({ path: info.outputPath(`milestone-edit-${info.project.name}.png`) });
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByText('Saved First two loaves.')).toBeVisible();
  await expect(milestone(page, 'First two loaves')).toHaveAccessibleName('Edit milestone First two loaves, 0 of 2 done, due Dec 10, was Nov 20');
  await expect(changeLine(page)).toContainText('Nov 2: Moved First loaf from Nov 20 to Dec 10.');

  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(milestone(page, 'First loaf')).toHaveAccessibleName('Edit milestone First loaf, 0 of 2 done, due Nov 20');

  // Cancel drops a change.
  await milestone(page, 'First loaf').click();
  await editor.getByLabel('Name').fill('Second loaf');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toHaveCount(0);
  await expect(milestone(page, 'First loaf')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Mark met and Not met are in the popover of a milestone with no tasks, and the change line undoes them', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openProject(page, phone);
  const editor = page.getByRole('dialog', { name: 'Edit milestone' });

  // One with tasks is met by ticking them, so it has no Mark met.
  await milestone(page, 'First loaf').click();
  await expect(editor.getByRole('button', { name: 'Drop milestone' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Mark met' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Cancel' }).click();

  await milestone(page, 'Bake for friends').click();
  const met = editor.getByRole('button', { name: 'Mark met' });
  if (phone) await expectTapTarget(met);
  await met.click();
  await expect(editor).toHaveCount(0);
  await expect(milestone(page, 'Bake for friends')).toHaveAccessibleName('Edit milestone Bake for friends, Met Nov 2');
  await expect(changeLine(page)).toContainText('Nov 2: Marked Bake for friends done.');
  await changeLine(page).getByRole('button', { name: 'Undo' }).click();
  await expect(milestone(page, 'Bake for friends')).toHaveAccessibleName('Edit milestone Bake for friends, due Dec 5');

  // Met again, Not met takes it back from the popover.
  await milestone(page, 'Bake for friends').click();
  await editor.getByRole('button', { name: 'Mark met' }).click();
  await milestone(page, 'Bake for friends').click();
  await expect(editor.getByLabel('Due date')).toHaveCount(0);
  const notMet = editor.getByRole('button', { name: 'Not met' });
  if (phone) await expectTapTarget(notMet);
  await notMet.click();
  await expect(editor).toHaveCount(0);
  await expect(milestone(page, 'Bake for friends')).toHaveAccessibleName('Edit milestone Bake for friends, due Dec 5');
  await expect(changeLine(page)).toContainText('Nov 2: Marked Bake for friends not met.');
  expect(errors).toEqual([]);
});

test('Drop milestone keeps done tasks, moves open ones to the next milestone or cancels them, each with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openProject(page, phone);
  const editor = page.getByRole('dialog', { name: 'Edit milestone' });

  await milestone(page, 'First loaf').click();
  await editor.getByRole('button', { name: 'Drop milestone' }).click();
  await expect(editor.getByText('Drop First loaf?')).toBeVisible();
  const choice = editor.getByRole('group', { name: '2 open tasks (5h):' });
  await expect(choice.getByRole('radio', { name: 'Move to Bake for friends, due Dec 5' })).toBeChecked();
  if (phone) await expectTapTarget(editor.getByRole('button', { name: 'Back' }));
  // Back returns to the fields, unchanged.
  await editor.getByRole('button', { name: 'Back' }).click();
  await expect(editor.getByLabel('Name')).toHaveValue('First loaf');
  await editor.getByRole('button', { name: 'Drop milestone' }).click();
  await editor.getByRole('button', { name: 'Drop milestone' }).click();
  await expect(editor).toHaveCount(0);

  await expect(group(page, 'First loaf')).toContainText('Dropped Nov 2');
  await expect(milestone(page, 'First loaf')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bake for friends tasks' })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Bake for friends tasks' }).click();
  await expect(group(page, 'Bake for friends').getByRole('button', { name: /^Edit task / })).toHaveText([/Shape the dough.*4h, from First loaf/, /Proof the dough.*1h, from First loaf/]);
  await expect(changeLine(page)).toContainText('Nov 2: Dropped First loaf.');
  await changeLine(page).getByRole('button', { name: 'Undo' }).click();
  await expect(milestone(page, 'First loaf')).toHaveAccessibleName('Edit milestone First loaf, 0 of 2 done, due Nov 20');
  await expect(group(page, 'Bake for friends').getByRole('button', { name: /^Edit task / })).toHaveCount(0);

  // Cancelling instead leaves them under the dropped milestone, cancelled.
  await milestone(page, 'First loaf').click();
  await editor.getByRole('button', { name: 'Drop milestone' }).click();
  await editor.getByRole('radio', { name: 'Cancel them, 5h off the project' }).check();
  await editor.getByRole('button', { name: 'Drop milestone' }).click();
  await expect(editor).toHaveCount(0);
  const dropped = group(page, 'First loaf');
  await page.getByRole('button', { name: 'First loaf tasks' }).click();
  await expect(dropped.getByRole('checkbox', { name: 'Shape the dough done' })).toBeDisabled();
  await expect(dropped).toContainText('Cancelled');
  await changeLine(page).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Edit task Shape the dough, 4h' })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the overdue question's Drop milestone and Mark done each answer it with Undo, and Move date previews a typed date and refuses today", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openProject(page, phone, true);
  const fix = page.getByRole('group', { name: 'Make a starter was due Oct 25' });

  await fix.getByRole('button', { name: 'Move date' }).click();
  await fix.getByLabel('New due date').fill('2026-11-02');
  await expect(fix).toContainText('Pick a date after Nov 2.');
  await expect(fix.getByRole('button', { name: 'Move date' })).toBeDisabled();
  await fix.getByLabel('New due date').fill('2026-11-30');
  await expect(fix).toContainText('Project goes from Overdue to');
  await expect(fix.getByRole('button', { name: 'Move to Nov 30' })).toBeEnabled();
  await fix.getByRole('button', { name: 'Back' }).click();

  await fix.getByRole('button', { name: 'Drop milestone' }).click();
  await expect(fix).toContainText('Its 1 done task stays on record.');
  const choice = fix.getByRole('group', { name: 'Feed the starter (2h):' });
  await expect(choice.getByRole('radio', { name: 'Move to First loaf, due Nov 20' })).toBeChecked();
  await expect(choice.getByRole('radio', { name: 'Cancel it, 2h off the project' })).not.toBeChecked();
  if (phone) await expectTapTarget(fix.getByRole('button', { name: 'Drop milestone' }));
  await fix.getByRole('button', { name: 'Drop milestone' }).click();
  await expect(fix).toHaveCount(0);
  await expect(group(page, 'Make a starter')).toContainText('Dropped Nov 2');
  await expect(changeLine(page)).toContainText('Nov 2: Dropped Make a starter.');
  await changeLine(page).getByRole('button', { name: 'Undo' }).click();
  await expect(fix).toBeVisible();

  const mark = fix.getByRole('button', { name: 'Mark 1 task done' });
  if (phone) await expectTapTarget(mark);
  await mark.click();
  await expect(fix).toHaveCount(0);
  await expect(milestone(page, 'Make a starter')).toHaveAccessibleName('Edit milestone Make a starter, Met Nov 2');
  await expect(page.getByRole('checkbox', { name: 'Feed the starter done' })).toHaveCount(0);
  await changeLine(page).getByRole('button', { name: 'Undo' }).click();
  await expect(fix).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit task Feed the starter, 2h' })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a task's popup moves it to another milestone with Undo, and on phone a held task drags to one", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openProject(page, phone);
  await page.getByRole('button', { name: 'First loaf tasks' }).click();
  await page.getByRole('button', { name: 'Edit task Shape the dough, 4h' }).click();
  const popup = page.locator('.sheet.taskpop[aria-label="Shape the dough"]');
  await popup.getByLabel('Belongs to').selectOption({ label: 'Bake a sourdough loaf, Bake for friends' });
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Moved Shape the dough to Bake a sourdough loaf, Bake for friends.')).toBeVisible();
  await expect(group(page, 'First loaf')).not.toContainText('Shape the dough');
  await expect(milestone(page, 'Bake for friends')).toHaveAccessibleName('Edit milestone Bake for friends, 0 of 1 done, due Dec 5');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(group(page, 'First loaf').getByRole('button', { name: 'Edit task Shape the dough, 4h' })).toBeVisible();

  if (!phone) return expect(errors).toEqual([]);
  // Held, the row lifts and drops on another milestone's group.
  const row = page.getByRole('button', { name: 'Edit task Proof the dough, 1h' });
  const to = (await milestone(page, 'Bake for friends').boundingBox())!;
  await touchDrag(page, row, { x: to.x + to.width / 2, y: to.y + to.height / 2 });
  await expect(page.getByText('Moved Proof the dough to Bake for friends.')).toBeVisible();
  await expect(milestone(page, 'Bake for friends')).toHaveAccessibleName('Edit milestone Bake for friends, 0 of 1 done, due Dec 5');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(milestone(page, 'First loaf')).toHaveAccessibleName('Edit milestone First loaf, 0 of 2 done, due Nov 20');
  expect(errors).toEqual([]);
});
