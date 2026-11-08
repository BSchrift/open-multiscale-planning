import { expect, test } from '@playwright/test';
import { addMilestones, addProject, addTasks, chicago, firstRun, goals, jumpTo, openProject, pane, start, tab, TZ } from './journey';

// A first stretch planned from the first day, with some work done, then planning the next one in late December: Look
// back reads what happened, Practices edit in place, Projects puts milestones in the plan, Time sets an aim, and
// Finish sets the plan that the Plan page and the first week of January then follow.

test.use({ timezoneId: TZ, actionTimeout: 15_000 });

test('plans the next stretch from what the last one held', async ({ page }, info) => {
  test.setTimeout(180_000);
  const phone = info.project.name === 'phone';
  const goal = 'Learn to bake bread';
  const errors = await start(page, chicago('2026-12-07', '09:00')); // Monday, in the last quarter of 2026.
  await firstRun(page, goal);
  await page.getByRole('button', { name: 'Skip for now' }).click();

  // The first plan is for this stretch, from today to the quarter's end.
  await tab(page, phone, 'Plan');
  const plan = pane(page, 'Plan');
  await plan.getByRole('button', { name: 'Plan your first stretch' }).click();
  await expect(page.getByText('Your first stretch: Dec 7 to Dec 31')).toBeVisible();
  await page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: /Finish$/ }).click();
  await (phone ? page.locator('.flowdock').getByRole('button', { name: 'Finish' }) : page.getByRole('button', { name: 'Finish', exact: true })).click();
  await expect(page.getByText('Your plan for Dec 7 to Dec 31 is set.')).toBeVisible();

  await tab(page, phone, 'Goals');
  const project = await addProject(page, phone, goal, 'Bake a sourdough loaf', '2027-05-28');
  await addMilestones(project, [
    { name: 'A starter that rises', due: '2026-12-11' },
    { name: 'First good loaf', due: '2027-02-12' },
    { name: 'Share a loaf', due: '2027-05-01' },
  ]);
  await addTasks(project, 'A starter that rises', [{ title: 'Mix the starter', step: 2, estimate: '30m' }]);
  await addTasks(project, 'First good loaf', [{ title: 'Bake a test loaf', step: 8, estimate: '2h' }]);

  await goals(page, phone);
  await page.getByRole('button', { name: phone ? '+ Practice' : 'Add practice' }).first().click();
  const add = page.getByRole('form', { name: 'Add practice' });
  await add.getByLabel('Name').fill('Read about baking');
  await add.getByRole('slider', { name: 'Target' }).fill('15');
  await add.getByLabel('Preferred time').fill('07:30');
  await add.getByRole('button', { name: 'Add practice' }).click();
  await expect(page.getByText('Practice added. It waits in To schedule on Week until you give it a time.')).toBeVisible();

  // Do the starter's one task now, from Today's Next up, and answer the block.
  await tab(page, phone, 'Today');
  await page.getByRole('region', { name: 'Next up' }).getByRole('button', { name: 'Start Mix the starter' }).click();
  // Saved before the clock moves on, or the block would start at the later time.
  await expect(page.getByRole('region', { name: 'Current block' }).getByRole('heading', { name: 'Mix the starter' })).toBeVisible();
  await jumpTo(page, chicago('2026-12-07', '09:31'));
  await page.getByRole('dialog', { name: 'Block finished' }).getByRole('button', { name: 'Task finished', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Block finished' })).toHaveCount(0);

  // The Saturday after Christmas: the stretch ends Dec 31, so it's time to plan Jan 1 to Mar 31.
  await jumpTo(page, chicago('2026-12-26', '10:00'));
  await tab(page, phone, 'Plan');
  await plan.getByRole('button', { name: /^(Plan now|Plan the next stretch)/ }).first().click();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });

  // Look back.
  await expect(page.getByRole('heading', { name: 'How did Dec 7 to Dec 31 go?' })).toBeVisible();
  await expect(page.getByText('1 of 1 milestones due in this time were met.')).toBeVisible();
  const time = page.getByRole('region', { name: 'Time by goal, and One offs' });
  await expect(time.locator('.between').filter({ hasText: goal })).toContainText('30m');
  await page.getByLabel('Anything to do differently? (optional)').fill('Bake on weekends.');
  await expect(page.getByText('Next stretch: Jan 1 to Mar 31')).toBeVisible();

  // Practices: each a summary, whose Edit opens its fields in place until Done.
  await steps.getByRole('button', { name: /Practices$/ }).click();
  await expect(page.getByRole('heading', { name: 'Your practices' })).toBeVisible();
  await expect(page.getByText('15m a day, every day, around 7:30am')).toBeVisible();
  await page.getByRole('button', { name: 'Edit Read about baking' }).click();
  const editor = page.getByRole('group', { name: /^Edit Read about/ });
  await editor.getByLabel('Name', { exact: true }).fill('Read about bread');
  const target = editor.getByRole('slider', { name: 'Target' });
  await target.fill('20');
  await expect(target).toHaveAttribute('aria-valuetext', '20m');
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('20m a day, every day, around 7:30am')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Read about bread' })).toBeFocused();

  // Projects: the timeline, with one milestone added by name and one dated by typing, each with Undo.
  await steps.getByRole('button', { name: /Projects$/ }).click();
  await expect(page.getByRole('heading', { name: 'What will you reach by Mar 31?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take milestone First good loaf out of this plan' })).toHaveAttribute('aria-pressed', 'true');
  // On the timeline, a date inside the stretch is already in the plan and a later one is not.
  await expect(page.getByRole('button', { name: /^Milestone: First good loaf, Feb 12, in this plan\./ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Milestone: Share a loaf, May 1, not in this plan\./ })).toBeVisible();
  // The toggle acts on what the screen shows, so each change shows before the next: until the add is read back, the
  // screen still says it's out, and a click then would take it out again.
  const share = page.getByRole('button', { name: 'Add milestone Share a loaf to this plan' });
  const shared = page.getByRole('button', { name: 'Take milestone Share a loaf out of this plan' });
  await share.click();
  await expect(shared).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Undo: Added Share a loaf to this plan, by Mar 31.' }).click();
  await expect(share).toHaveAttribute('aria-pressed', 'false');
  await share.click();
  await expect(shared).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Milestone: Share a loaf, by Mar 31, in this plan\./ })).toBeVisible();
  await page.getByRole('button', { name: 'Change the date of First good loaf, Feb 12' }).click();
  const date = page.getByRole('form', { name: 'Date for First good loaf' });
  await date.getByLabel('Date for First good loaf').fill('2027-02-19');
  await date.getByRole('button', { name: 'Set date' }).click();
  await expect(page.getByRole('button', { name: 'Undo: First good loaf, Feb 19.' })).toBeVisible();

  // Time: the open work under the plan, and a weekly aim.
  await steps.getByRole('button', { name: /Time$/ }).click();
  await expect(page.getByRole('heading', { name: 'Does it fit?' })).toBeVisible();
  await expect(page.getByText(/^About 2h of open tasks sit under your planned milestones\./)).toBeVisible();
  const aim = page.getByRole('slider', { name: 'Weekly aim for Bake a sourdough loaf' });
  await aim.fill('8');
  await expect(aim).toHaveAttribute('aria-valuetext', '2h');

  // Finish: the plan and what changed, then set.
  await steps.getByRole('button', { name: /Finish$/ }).click();
  await expect(page.getByRole('heading', { name: 'Ready for Jan 1 to Mar 31' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'The plan' })).toContainText('Bake a sourdough loaf: First good loaf, Feb 19; Share a loaf, by Mar 31');
  const changed = page.getByRole('region', { name: 'What changed' });
  await expect(changed).toContainText('Added Share a loaf to this plan');
  await expect(changed).toContainText('Weekly aim changed: Bake a sourdough loaf');
  await (phone ? page.locator('.flowdock').getByRole('button', { name: 'Finish' }) : page.getByRole('button', { name: 'Finish', exact: true })).click();
  await expect(page.getByText('Your plan for Jan 1 to Mar 31 is set.')).toBeVisible();
  const next = plan.getByRole('region', { name: 'Next plan, Jan 1 to Mar 31' });
  await expect(next).toContainText('First good loaf');
  await expect(next).toContainText('Share a loaf');

  // Goals shows the same plan and the renamed practice.
  await openProject(page, phone, goal, 'Bake a sourdough loaf');
  await expect(page.getByRole('group', { name: 'Milestone: Share a loaf' })).toContainText('by Mar 31');
  await expect(page.getByRole('group', { name: 'Milestone: First good loaf' })).toContainText('due Feb 19, was Feb 12');
  await goals(page, phone);
  await expect(page.getByRole('button', { name: /^Read about bread/ })).toBeVisible();

  // The new stretch begins: the Plan page follows it, and the first week's schedule offers the practice as edited.
  await jumpTo(page, chicago('2027-01-04', '09:00'));
  await tab(page, phone, 'Plan');
  await expect(plan.getByText(/^This stretch: Jan 1 to Mar 31\./)).toBeVisible();
  const current = plan.getByRole('region', { name: 'Current plan, Jan 1 to Mar 31' });
  await expect(current).toContainText('First good loaf');
  await expect(current).toContainText('Share a loaf');
  await tab(page, phone, 'Today');
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: /Schedule/ }).click();
  if (phone) {
    await page.getByRole('button', { name: /^All picked tasks/ }).click();
    await expect(page.getByRole('dialog', { name: 'All picked tasks' })).toContainText('Read about bread');
  } else {
    // Monday's 7:30am has gone by, so today's session starts now, and Tuesday's is at the edited time.
    await page.getByRole('button', { name: /^Read about bread/ }).click();
    await expect(page.getByRole('group', { name: /^Read about bread, Mon Jan 4, 9am to 9:20am, Practice\./ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use suggested time, Tue Jan 5, 7:30am' })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
