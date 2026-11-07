import { expect, test } from '@playwright/test';
import { addMilestones, addProject, addTasks, chicago, firstRun, jumpTo, openProject, pane, slide, start, tab, TZ } from './journey';

// From an empty first run to a planned week, then the day itself: check-in, end-of-block answers, and rescheduling.

test.use({ timezoneId: TZ, actionTimeout: 15_000 });

test('first run, a project, a planned week, and its Monday', async ({ page }, info) => {
  test.setTimeout(180_000);
  const phone = info.project.name === 'phone';
  const errors = await start(page, chicago('2026-11-02', '07:30')); // Monday morning.

  await firstRun(page, 'Write a novel');
  // A new install with nothing planned opens on the prompt to plan the week.
  await expect(page.getByRole('heading', { name: 'Plan your week' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();

  await tab(page, phone, 'Goals');
  await addProject(page, phone, 'Write a novel', 'Finish the first draft', '2026-12-18');
  await addMilestones(page, [
    { name: 'Outline done', due: '2026-11-06' },
    { name: 'Half the chapters', due: '2026-11-27' },
  ]);
  await addTasks(page, 'Outline done', [
    { title: 'Sketch the chapter list', step: 4, estimate: '1h' },
    { title: 'Write the opening scene', step: 6, estimate: '1h 30m' },
  ]);
  await addTasks(page, 'Half the chapters', [{ title: 'Draft chapter one', step: 8, estimate: '2h' }]);

  // Something to sort before planning.
  await page.getByRole('button', { name: phone ? 'Capture a task' : /^Capture/ }).first().click();
  await page.getByRole('dialog', { name: 'Capture' }).getByRole('textbox', { name: 'Capture to Inbox' }).fill('Find a title for the novel');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);

  // Weekly planning: Inbox, Pick tasks, Schedule, Review.
  await tab(page, phone, 'Today');
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await expect(steps.locator('[aria-current="step"]')).toHaveText(/Inbox/);
  await page.getByRole('button', { name: 'Process 1 item' }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });
  await expect(card.getByRole('heading', { name: 'Find a title for the novel' })).toBeVisible();
  await card.getByRole('button', { name: 'Finish the first draft' }).click();
  await expect(card.getByRole('heading', { name: 'Inbox clear' })).toBeVisible();
  await card.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();

  const picks = ['Sketch the chapter list', 'Write the opening scene', 'Draft chapter one'];
  if (phone) {
    const sheet = page.getByRole('region', { name: 'Tasks in Finish the first draft' });
    for (const t of picks) await sheet.getByRole('button', { name: `Add ${t}` }).click();
    await expect(page.locator('.donut .dlabel')).toHaveText('+4h 30m');
  } else {
    await page.getByRole('button', { name: /^Finish the first draft,/ }).click();
    for (const t of picks) await page.getByRole('button', { name: `Add ${t} to the plan` }).click();
    const planned = page.getByRole('complementary', { name: 'Time this week' });
    for (const t of picks) await expect(planned.getByText(t, { exact: true })).toBeVisible();
  }

  await steps.getByRole('button', { name: /Schedule/ }).click();
  if (phone) {
    await page.getByRole('button', { name: 'Place here' }).click();
    await expect(page.getByRole('button', { name: 'All picked tasks, 1 of 3 placed' })).toBeVisible();
    await page.getByRole('button', { name: 'All picked tasks, 1 of 3 placed' }).click();
    await page.getByRole('dialog', { name: 'All picked tasks' }).getByRole('button', { name: 'Place the rest at suggested times' }).click();
    await expect(page.getByRole('button', { name: 'All picked tasks, 3 of 3 placed' })).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'All picked tasks, 1 of 3 placed' })).toBeVisible();
    await page.getByRole('button', { name: 'All picked tasks, 1 of 3 placed' }).click();
    await page.getByRole('dialog', { name: 'All picked tasks' }).getByRole('button', { name: 'Place the rest at suggested times' }).click();
    await expect(page.getByRole('button', { name: 'All picked tasks, 3 of 3 placed' })).toBeVisible();
  } else {
    await expect(page.getByText('0 of 3 placed')).toBeVisible();
    await page.getByRole('button', { name: 'Place here' }).click();
    await expect(page.getByText('1 of 3 placed')).toBeVisible();
    await page.getByRole('button', { name: 'Place the rest at suggested times' }).click();
    await expect(page.getByText('3 of 3 placed')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('1 of 3 placed')).toBeVisible();
    await page.getByRole('button', { name: 'Place the rest at suggested times' }).click();
    await expect(page.getByText('3 of 3 placed')).toBeVisible();
  }

  await steps.getByRole('button', { name: /Review/ }).click();
  await page.getByRole('button', { name: 'Finish plan' }).click();
  await expect(steps).toHaveCount(0);
  await expect(page.getByText('Week planned.')).toBeVisible();

  // The day: two blocks this evening, weekdays starting at 5pm.
  const timeline = page.getByRole('region', { name: "Today's timeline" });
  // Still to come, so on phone they're sliders that VoiceOver can move, as on Week.
  await expect(timeline.getByRole(phone ? 'slider' : 'button', { name: 'Sketch the chapter list, 5pm to 6pm, Project.' })).toBeVisible();
  await expect(timeline.getByRole(phone ? 'slider' : 'button', { name: 'Write the opening scene, 6pm to 7:30pm, Project.' })).toBeVisible();
  const now = page.getByRole('region', { name: 'Current block' });

  // A few minutes in, the start check-in asks; Yes starts the countdown.
  await jumpTo(page, chicago('2026-11-02', '17:06'));
  const check = page.getByRole('dialog', { name: 'Have you started?' });
  await expect(check.getByText('Have you started Sketch the chapter list?')).toBeVisible();
  await check.getByRole('button', { name: 'Yes, started' }).click();
  await expect(check).toHaveCount(0);
  await expect(now.getByText('In progress, time left')).toBeVisible();
  await expect(now.getByRole('timer')).toHaveText(/^5\d:\d\d$/);

  // At its end it asks how it went: Task finished.
  await jumpTo(page, chicago('2026-11-02', '18:01'));
  let ended = page.getByRole('dialog', { name: 'Block finished' });
  await expect(ended.getByText('Sketch the chapter list')).toBeVisible();
  await ended.getByRole('button', { name: 'Task finished', exact: true }).click();
  await expect(ended).toHaveCount(0);
  // The next block's check-in can wait ten minutes, and then asks again.
  await jumpTo(page, chicago('2026-11-02', '18:06'));
  await expect(check.getByText('Have you started Write the opening scene?')).toBeVisible();
  await check.getByRole('button', { name: 'Ask again in 10 minutes' }).click();
  await expect(check).toHaveCount(0);
  await jumpTo(page, chicago('2026-11-02', '18:17'));
  await check.getByRole('button', { name: 'Yes, started' }).click();
  await expect(now.getByRole('heading', { name: 'Write the opening scene' })).toBeVisible();

  // The second block ends: Partly, with the time left on the estimate slider.
  await jumpTo(page, chicago('2026-11-02', '19:31'));
  ended = page.getByRole('dialog', { name: 'Block finished' });
  await expect(ended.getByText('Write the opening scene')).toBeVisible();
  await ended.getByRole('button', { name: 'Partly' }).click();
  const left = page.getByRole('dialog', { name: 'How much is left?' }).getByRole('slider', { name: 'Time left' });
  await slide(left, 3, '45m');
  await page.getByRole('dialog', { name: 'How much is left?' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Added to Needs a new time. No need to decide now.')).toBeVisible();

  // Needs a new time: give it one.
  await page.getByRole('button', { name: phone ? '1 task needs a new time Review' : 'Review' }).click();
  const queue = phone ? page.getByRole('dialog', { name: 'Needs a new time' }) : page.getByRole('region', { name: 'Needs a new time' });
  await expect(queue.getByText('Partly done today, 45m left')).toBeVisible();
  if (phone) {
    await queue.getByRole('button', { name: 'Place on calendar' }).click();
    await expect(pane(page, 'Week')).toBeVisible();
    await page.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(3).click();
    await expect(page.getByRole('heading', { name: 'Thu Nov 5' })).toBeVisible();
    await page.getByRole('button', { name: 'Place here' }).click();
    const toast = page.getByText(/^Placed Write the opening scene, Thu Nov 5, /);
    const time = (await toast.textContent())!.replace('Placed Write the opening scene, Thu Nov 5, ', '');
    await page.getByRole('button', { name: 'Done editing' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`^Write the opening scene, ${time} to `) })).toBeVisible();
  } else {
    const offer = queue.getByRole('button', { name: /^Place Write the opening scene, / });
    const label = (await offer.getAttribute('aria-label'))!.replace('Place Write the opening scene, ', '');
    await offer.click();
    await expect(page.getByText(`Placed Write the opening scene, ${label}`)).toBeVisible();
    await expect(queue.getByText('Nothing needs a new time.')).toBeVisible();
    await tab(page, phone, 'Week');
    await expect(page.getByRole('button', { name: new RegExp(`^Write the opening scene, ${label} to `) })).toBeVisible();
  }

  // The answers show up elsewhere: the project's progress, and this week's analytics.
  await openProject(page, phone, 'Write a novel', 'Finish the first draft');
  await page.getByRole('group', { name: 'Milestone: Outline done' }).getByRole('button', { name: 'Show 1 completed' }).click();
  await expect(page.getByRole('checkbox', { name: 'Sketch the chapter list done' })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Milestone: Outline done' })).toContainText('1 of 2 done, due Nov 6');
  await tab(page, phone, 'Analytics');
  await expect(pane(page, 'Analytics').getByRole('img', { name: 'Project tasks: 1 done, 1 partly, 0 not done' })).toBeVisible();

  expect(errors).toEqual([]);
});
