// Shared steps for the long journeys: each starts from an empty first run and moves the clock through days and weeks.

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { pane } from '../seed';

export { pane };

export const TZ = 'America/Chicago';

/** A wall-clock time in Chicago, which is six hours behind UTC from November to early March. */
export const chicago = (day: string, time: string) => new Date(`${day}T${time}:00-06:00`);

/** Moves the app's clock forward to a moment, as if the device slept until then. */
export async function jumpTo(page: Page, when: Date) {
  const now = await page.evaluate(() => Date.now());
  expect(when.getTime(), `jump to ${when.toISOString()} goes forward`).toBeGreaterThan(now);
  await page.clock.fastForward(when.getTime() - now);
}

/** Starts the clock and collects uncaught page errors, which every journey expects to stay empty. */
export async function start(page: Page, when: Date) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: when });
  await page.goto('/');
  return errors;
}

/** First-run setup: skip sign-in, keep the default unavailable hours, start with a goal. */
export async function firstRun(page: Page, goal: string) {
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('group', { name: 'Unavailable, 10pm to 7am' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('textbox', { name: 'A goal or a thought' }).fill(goal);
  await page.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}


/** Opens a main area: a tab on desktop, a tab or a More row on phone. */
export async function tab(page: Page, phone: boolean, name: string) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone && !['Today', 'Week', 'Inbox', 'Goals'].includes(name)) {
    // More keeps the page it was left on, so the row may be one step back.
    await nav.getByRole('button', { name: 'More' }).click();
    const back = page.getByRole('button', { name: 'Back to More' });
    if (!(await pane(page, name).isVisible()) && (await back.isVisible())) await back.click();
    if (!(await pane(page, name).isVisible())) await pane(page, 'More').getByRole('button', { name: new RegExp(`^${name}`) }).click();
  } else {
    await nav.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  }
  await expect(pane(page, name).getByRole('heading').first()).toBeVisible();
}

/** Sets an estimate or aim slider to a step: 15-minute steps to 2h, so 4 is 1h and 6 is 1h 30m. */
export async function slide(slider: Locator, step: number, text: string) {
  await slider.fill(String(step));
  await expect(slider).toHaveAttribute('aria-valuetext', text);
}

/** Where a project's body is: its own page on phone, its expanded row on desktop, where several can be open. */
export function projectScope(page: Page, phone: boolean, name: string): Locator {
  return phone ? pane(page, 'Goals') : page.locator('.prow').filter({ has: page.getByRole('button', { name: new RegExp(`^${name}`) }) });
}

/** Adds a project under a goal, with the required end date, and opens it. */
export async function addProject(page: Page, phone: boolean, goal: string, name: string, ends: string) {
  const g = page.getByRole('button', { name: new RegExp(`^${goal}`) }).first();
  if ((await g.getAttribute('aria-expanded')) !== 'true') await g.click();
  await page.getByRole('button', { name: phone ? '+ Project' : 'Add project' }).click();
  const form = page.getByRole('form', { name: 'Add project' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Ends').fill(ends);
  await form.getByRole('button', { name: 'Add project' }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
  const scope = projectScope(page, phone, name);
  await expect(scope.getByRole('button', { name: 'Project settings' })).toBeVisible();
  return scope;
}

/** The Goals page itself, whichever project page the phone's Goals tab was left on. */
export async function goals(page: Page, phone: boolean) {
  await tab(page, phone, 'Goals');
  const back = page.getByRole('button', { name: 'Back to Goals' });
  if (phone && (await back.isVisible())) await back.click();
  await expect(pane(page, 'Goals').getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();
}

/** Opens a project on the Goals page: in place on desktop, its own page on phone. */
export async function openProject(page: Page, phone: boolean, goal: string, project: string) {
  await goals(page, phone);
  const g = page.getByRole('button', { name: new RegExp(`^${goal}`) }).first();
  if ((await g.getAttribute('aria-expanded')) !== 'true') await g.click();
  const p = page.getByRole('button', { name: new RegExp(`^${project}`) }).first();
  if ((await p.getAttribute('aria-expanded')) !== 'true') await p.click();
  const scope = projectScope(page, phone, project);
  await expect(scope.getByRole('button', { name: 'Project settings' })).toBeVisible();
  return scope;
}

/** The page a scope is on: a sheet draws from the layout's root, outside the page that opened it. */
export const pageOf = (scope: Page | Locator): Page => ('page' in scope ? scope.page() : scope);

/** Adds milestones to the open project, from its + Milestone popover. */
export async function addMilestones(page: Page | Locator, milestones: readonly { name: string; due: string }[]) {
  await page.getByRole('button', { name: /^(\+ Milestone|Add milestone)$/ }).click();
  const editor = pageOf(page).getByRole('dialog', { name: 'Add milestone' });
  for (const m of milestones) {
    await editor.getByLabel('Name').fill(m.name);
    await editor.getByLabel('Due date').fill(m.due);
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText(`Added ${m.name}.`);
  }
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect(editor).toHaveCount(0);
  // The next open milestone starts open, ready for its tasks.
  await expect(page.getByRole('button', { name: `${milestones[0]!.name} tasks` })).toHaveAttribute('aria-expanded', 'true');
}

/** Adds estimated tasks under a milestone of the open project. */
export async function addTasks(page: Page | Locator, milestone: string, tasks: readonly { title: string; step: number; estimate: string }[]) {
  const fold = page.getByRole('button', { name: `${milestone} tasks` });
  if ((await fold.getAttribute('aria-expanded')) === 'false') await fold.click();
  await page.getByRole('button', { name: `Add task to ${milestone}` }).click();
  const editor = pageOf(page).getByRole('dialog', { name: 'Add task' });
  for (const t of tasks) {
    await editor.getByLabel('Title').fill(t.title);
    await slide(editor.getByRole('slider', { name: 'Time estimate' }), t.step, t.estimate);
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(editor.getByRole('status')).toHaveText(`Added ${t.title}.`);
  }
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect(editor).toHaveCount(0);
  for (const t of tasks) await expect(page.getByRole('button', { name: `Edit task ${t.title}, ${t.estimate}` })).toBeVisible();
}

/** Adds the item on Process's card to a project or One offs: typed and Enter on desktop, picked in the sheet on phone. */
export async function processTo(page: Page, phone: boolean, place: string) {
  if (phone) await page.getByRole('dialog', { name: 'Process Inbox' }).getByRole('button', { name: /^Add to a project or One offs/ }).click();
  const picker = page.getByRole('combobox', { name: 'Add to a project or One offs' });
  await picker.fill(place);
  if (phone) await page.getByRole('dialog', { name: 'Add to' }).getByRole('option', { name: new RegExp(`^${place}`) }).first().click();
  else await picker.press('Enter');
}
