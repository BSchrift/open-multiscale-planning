import { expect, test } from '@playwright/test';
import { addMilestones, addProject, addTasks, chicago, firstRun, goals, jumpTo, openProject, pane, processTo, start, tab, TZ } from './journey';

// A first stretch planned from the first day, with some work done, then planning the next one in late December: Goals
// shows what each got and adds one, Practices edit in place, Projects puts milestones in the plan and adds a project
// under a new goal, the Inbox is sorted, and Finish checks the fit, sets an aim, takes a change back and sets the plan
// that weekly planning, the Plan page and the first week of January then follow.

test.use({ timezoneId: TZ, actionTimeout: 15_000 });

test('plans the next stretch from what the last one held', async ({ page }, info) => {
  test.setTimeout(180_000);
  const phone = info.project.name === 'phone';
  const goal = 'Learn to bake bread';
  const errors = await start(page, chicago('2026-12-07', '09:00')); // Monday, in the last quarter of 2026.
  await firstRun(page, goal);
  await page.getByRole('button', { name: /^Skip (for now|planning this week)$/ }).click();

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
  await add.getByRole('slider', { name: 'Each session' }).fill('15');
  await add.getByLabel('Usual time').fill('07:30');
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
  const next = (name: string) => (phone ? page.locator('.flowbot').getByRole('button', { name }) : page.getByRole('button', { name, exact: true })).click();

  // Goals: how the stretch went, and each goal on a card with what it got. A new goal is one change, with Undo.
  await expect(page.getByRole('heading', { name: 'Step 1 of 5, Goals. Are these still your goals?' })).toBeFocused();
  await expect(page.getByText('1 of 1 milestones due in this time were met.')).toBeVisible();
  const bread = page.getByRole('region', { name: goal });
  await expect(bread).toContainText('30m this stretch');
  await expect(bread.getByRole('button', { name: 'Open project Bake a sourdough loaf' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Does it fit?' })).toContainText(/About \dh planned, about \dh at your recent pace\./);
  await page.getByRole('button', { name: '+ New goal' }).click();
  await page.getByRole('textbox', { name: 'New goal' }).fill('Keep fit');
  await page.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.getByRole('region', { name: 'Keep fit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo: Added goal Keep fit.' })).toBeVisible();
  await next('Goals look right');

  // Practices: each a summary, whose Edit opens its fields in place until Save or Cancel.
  await expect(page.getByRole('heading', { name: 'Step 2 of 5, Practices. Your practices' })).toBeFocused();
  await expect(steps.getByRole('button', { name: /Goals, done$/ })).toBeVisible();
  await expect(page.getByText('15m every day, around 7:30am', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Read about baking' }).click();
  const editor = page.getByRole('group', { name: /^Edit Read about/ });
  await editor.getByLabel('Name', { exact: true }).fill('Read about bread');
  const target = editor.getByRole('slider', { name: 'Each session' });
  await target.fill('20');
  await expect(target).toHaveAttribute('aria-valuetext', '20 minutes');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('20m every day, around 7:30am', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Read about bread' })).toBeFocused();
  await next('Practices look right');

  // Projects: the timeline, with one milestone added by name and one dated by typing, each with Undo.
  await expect(page.getByRole('heading', { name: 'Step 3 of 5, Projects. What will you reach by Mar 31?' })).toBeFocused();
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

  // A new project ends with the stretch being planned, and gets a new goal in the same write.
  await page.getByRole('button', { name: '+ Add project' }).click();
  const rye = page.getByRole('form', { name: 'Add project' });
  await expect(rye.getByLabel('Ends')).toHaveValue('2027-03-31');
  await rye.getByLabel('Name').fill('Bake rye');
  await rye.getByRole('button', { name: 'Add project' }).click();
  await page.getByRole('button', { name: 'Goal for Bake rye: No goal. Change' }).click();
  const picker = page.getByRole('dialog', { name: 'Goal for Bake rye' });
  await picker.getByRole('button', { name: '+ New goal' }).click();
  await picker.getByRole('textbox', { name: 'New goal name' }).fill('Bake for friends');
  await picker.getByRole('button', { name: 'Add and link' }).click();
  await expect(page.getByRole('button', { name: 'Goal for Bake rye: Bake for friends. Change' })).toBeVisible();

  // Something to sort, captured from Add without leaving planning.
  await page.getByRole('button', phone ? { name: 'Add a goal, practice, project or Inbox task' } : { name: '+ Add', exact: true }).click();
  const adds = page.getByRole('dialog', { name: 'Add' });
  await expect(adds.getByRole('button').first()).toHaveText('Project');
  await adds.getByRole('button', { name: 'Task to Inbox' }).click();
  const capture = page.getByRole('dialog', { name: 'Capture' });
  await capture.getByRole('textbox', { name: 'Capture to Inbox' }).fill('Buy a banneton');
  await capture.getByRole('textbox', { name: 'Capture to Inbox' }).press('Enter');
  await expect(capture).toHaveCount(0);
  await expect(steps.getByRole('button', { name: /Inbox, 1 item$/ })).toBeVisible();
  // Bake rye's Done is in the plan too, at the stretch's end.
  await next('Continue with 3 milestones');

  // Inbox: Process gives the item a home, then a line says what was sorted, with focus on it.
  await expect(page.getByRole('heading', { name: 'Step 4 of 5, Inbox. Give each item a home' })).toBeFocused();
  await (phone ? next('Process 1 item') : page.getByRole('button', { name: 'Process 1 item' }).click());
  const cards = page.getByRole('dialog', { name: 'Process Inbox' });
  await processTo(page, phone, 'Bake a sourdough loaf');
  // The only item, so Process closes itself.
  await expect(cards).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('to Bake a sourdough loaf.');
  await expect(page.getByText('1 sorted. Your Inbox is clear.')).toBeFocused();
  await next('Continue to Finish');

  // Finish: whether it fits, a weekly aim, what changed with an Undo on each line, then on to the week.
  await expect(page.getByRole('heading', { name: 'Step 5 of 5, Finish. Ready for Jan 1 to Mar 31' })).toBeFocused();
  await expect(page.getByText(/2h planned, about \dh at your recent pace\.$/)).toBeVisible();
  await page.getByRole('button', { name: 'Set weekly aims' }).click();
  const aim = page.getByRole('slider', { name: 'Weekly aim for Bake a sourdough loaf' });
  await aim.fill('8');
  await expect(aim).toHaveAttribute('aria-valuetext', '2h');
  await expect(page.getByRole('region', { name: 'The plan' })).toContainText('Bake a sourdough loaf: First good loaf, Feb 19; Share a loaf, by Mar 31');
  const changed = page.getByRole('region', { name: 'What changed' });
  await expect(changed).toContainText('Added goal Keep fit.');
  await expect(changed).toContainText('Added Share a loaf to this plan');
  await expect(changed).toContainText('Weekly aim changed: Bake a sourdough loaf');
  await changed.getByRole('button', { name: 'Undo: Added project Bake rye, Dec 26 to Mar 31.' }).click();
  await expect(changed).not.toContainText('Added project Bake rye');
  await next('Finish and plan the week');
  await expect(page.getByText('Your plan for Jan 1 to Mar 31 is set.')).toBeVisible();
  // Nothing new has reached the Inbox since its step, so weekly planning starts on Pick tasks.
  await expect(steps.getByRole('button', { name: phone ? 'Pick' : '2. Pick tasks' })).toHaveAttribute('aria-current', 'step');
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await tab(page, phone, 'Plan');
  const nextPlan = plan.getByRole('region', { name: 'Next plan, Jan 1 to Mar 31' });
  await expect(nextPlan).toContainText('First good loaf');
  await expect(nextPlan).toContainText('Share a loaf');

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
  // Start planning puts planning on the clock from now; its Undo keeps this week's times free for the work below.
  await page.getByRole('button', { name: 'Undo' }).click();
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
