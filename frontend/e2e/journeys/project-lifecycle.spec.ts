import { expect, test } from '@playwright/test';
import { addMilestones, addProject, addTasks, chicago, firstRun, goals, jumpTo, openProject, start, tab, TZ } from './journey';

// A milestone passes its date, the project asks what to do, the date moves with Undo; then one project is finished
// and one dropped, each after asking, and Archived brings one back with its open work.

test.use({ timezoneId: TZ, actionTimeout: 15_000 });

test('an overdue milestone, then finishing, dropping and restoring projects', async ({ page }, info) => {
  test.setTimeout(180_000);
  const phone = info.project.name === 'phone';
  const goal = 'Keep the house in shape';
  const errors = await start(page, chicago('2026-11-02', '09:00')); // Monday.
  await firstRun(page, goal);
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await tab(page, phone, 'Goals');
  const fence = await addProject(page, phone, goal, 'Paint the garden fence', '2026-12-18');
  await addMilestones(fence, [{ name: 'Supplies bought', due: '2026-11-04' }]);
  await addTasks(fence, 'Supplies bought', [
    { title: 'Choose a colour', step: 2, estimate: '30m' },
    { title: 'Buy the paint', step: 4, estimate: '1h' },
  ]);
  await fence.getByRole('checkbox', { name: 'Choose a colour done' }).click();
  await expect(fence.getByRole('button', { name: 'Show 1 completed' })).toBeVisible();
  if (phone) await page.getByRole('button', { name: 'Back to Goals' }).click();
  const shed = await addProject(page, phone, goal, 'Clear out the shed', '2027-01-29');
  await addMilestones(shed, [{ name: 'Shelves up', due: '2026-12-11' }]);

  // Thursday: Supplies bought was due yesterday.
  await jumpTo(page, chicago('2026-11-05', '09:00'));
  await tab(page, phone, 'Today');
  await goals(page, phone);
  await expect(page.getByRole('button', { name: /^Paint the garden fence/ }).first()).toContainText('Overdue');
  let project = await openProject(page, phone, goal, 'Paint the garden fence');
  const fix = project.getByRole('group', { name: 'Supplies bought was due Nov 4' });
  await expect(fix).toContainText('1 of 2 tasks done, 1h left.');
  await fix.getByRole('button', { name: 'Move date' }).click();
  await expect(fix.getByLabel('New due date')).toHaveValue('2026-11-12');
  await expect(fix).toContainText('Project goes from Overdue to');
  await fix.getByRole('button', { name: 'Move to Nov 12' }).click();
  await expect(fix).toHaveCount(0);
  await expect(project.getByText(/^Nov 5: Moved Supplies bought from Nov 4 to Nov 12\./)).toBeVisible();
  await expect(project.getByRole('group', { name: 'Milestone: Supplies bought' })).toContainText('1 of 2 done, due Nov 12, was Nov 4');

  // Undo puts the date and the question back.
  await project.getByRole('button', { name: 'Undo' }).click();
  await expect(fix).toBeVisible();
  await expect(project.getByRole('group', { name: 'Milestone: Supplies bought' })).toContainText('1 of 2 done, due Nov 4');
  await fix.getByRole('button', { name: 'Move date' }).click();
  await fix.getByRole('button', { name: 'Move to Nov 12' }).click();
  await expect(project.getByText('Replanned: 8 days later')).toBeVisible();

  // The goal no longer reads Overdue.
  await goals(page, phone);
  await expect(page.getByRole('button', { name: new RegExp(`^${goal}`) }).first()).not.toContainText('Overdue');

  // Finish asks first, and cancels the open work.
  project = await openProject(page, phone, goal, 'Paint the garden fence');
  await project.getByRole('button', { name: 'Project settings' }).click();
  await project.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(project.getByText('Finish this project?')).toBeVisible();
  await project.getByRole('button', { name: 'Yes, finish' }).click();
  await expect(page.getByText('Finished. Open tasks cancelled.')).toBeVisible();

  // Drop asks too; Cancel keeps it.
  project = await openProject(page, phone, goal, 'Clear out the shed');
  await project.getByRole('button', { name: 'Project settings' }).click();
  await project.getByRole('button', { name: 'Drop', exact: true }).click();
  await expect(project.getByText('Drop this project?')).toBeVisible();
  await project.getByRole('alert').getByRole('button', { name: 'Cancel' }).click();
  await expect(project.getByText('Drop this project?')).toHaveCount(0);
  await project.getByRole('button', { name: 'Drop', exact: true }).click();
  await project.getByRole('button', { name: 'Yes, drop' }).click();
  await expect(page.getByText('Dropped.')).toBeVisible();

  // Both wait under Archived; the goal now has nothing active, but it changed just now, so it isn't asked whether
  // it's still a goal.
  await goals(page, phone);
  await expect(page.getByRole('button', { name: new RegExp(`^${goal}`) }).first()).toBeVisible();
  await expect(page.getByText('Still a goal?')).toHaveCount(0);
  await page.getByRole('button', { name: 'Archived (2)' }).click();
  await expect(page.getByRole('button', { name: 'Restore Clear out the shed' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore Paint the garden fence' }).click();
  await expect(page.getByRole('button', { name: 'Archived (1)' })).toBeVisible();

  // Restored with the work that finishing cancelled.
  project = await openProject(page, phone, goal, 'Paint the garden fence');
  await expect(project.getByRole('button', { name: 'Edit task Buy the paint, 1h' })).toBeVisible();
  await project.getByRole('button', { name: 'Show 1 completed' }).click();
  await expect(project.getByRole('checkbox', { name: 'Choose a colour done' })).toBeChecked();

  // Weekly planning offers the restored project, and not the dropped one.
  await tab(page, phone, 'Today');
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  if (phone) await expect(page.getByRole('region', { name: 'Tasks in Paint the garden fence' })).toBeVisible();
  else await expect(page.getByRole('button', { name: /^Paint the garden fence,/ })).toBeVisible();
  await expect(page.getByText('Clear out the shed').filter({ visible: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
