import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectTapTarget, go, openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm
const NOTES = 'Use the **Q3 numbers** first.\n- Check the totals with finance\n- Send it to Sam by *Friday*';

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Write the quarterly report', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Drafts', due: '2026-11-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft the summary', estimate_min: 120, notes: NOTES } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Check the totals', estimate_min: 60 } },
  { type: 'week_pick', id: 'pick:2026-11-02:t2', fields: { week_start: '2026-11-02', task_id: 't2', minutes: 60 } },
  { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Fix the gate' } },
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: '2026-11-02T22:00:00Z', end: '2026-11-02T23:00:00Z', tz: 'America/Chicago' } },
];

const popupOf = (page: Page, title: string) => page.locator(`.sheet.taskpop[aria-label="${title}"]`);

async function openProject(page: Page, phone: boolean) {
  await go(page, 'Goals');
  await page.getByRole('button', { name: /^Write the quarterly report/ }).click();
  await page.getByRole('button', { name: /^Report/ }).click();
  if (phone) await expect(page.getByRole('heading', { level: 1, name: 'Report' })).toBeVisible();
}

/** Checks the popup's shape: a sheet along the bottom on phone, a 480px dialog in the middle on desktop. */
async function expectShape(page: Page, popup: Locator, phone: boolean) {
  const box = (await popup.boundingBox())!;
  const view = page.viewportSize()!;
  if (phone) {
    expect(box.width).toBe(view.width);
    expect(Math.round(box.y + box.height)).toBe(view.height);
  } else {
    expect(box.width).toBe(480);
    expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(2);
  }
  expect(box.height).toBeLessThanOrEqual(view.height * 0.7 + 1);
}

test('a task opens in its popup from its project, to read and change everything about it, with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await openProject(page, phone);
  const row = page.getByRole('button', { name: 'Edit task Draft the summary, 2h, has details' });
  await row.click();

  const popup = popupOf(page, 'Draft the summary');
  await expect(popup).toBeVisible();
  // Focus starts on the name, read as the heading, so the phone's keyboard stays down.
  await expect(popup.getByRole('heading', { name: 'Draft the summary' })).toBeFocused();
  await page.waitForTimeout(300);
  await expectShape(page, popup, phone);
  await expect(popup.getByRole('slider', { name: 'Time estimate' })).toHaveAttribute('aria-valuetext', '2h');
  await expect(popup.getByLabel('Belongs to')).toHaveValue('m:m1');
  await expect(popup.locator('.notes strong')).toHaveText('Q3 numbers');
  await page.screenshot({ path: info.outputPath(`popup-${info.project.name}.png`) });
  if (phone) {
    for (const name of ['Rename Draft the summary', 'Edit description', 'Delete task', 'Cancel', 'Save']) await expectTapTarget(popup.getByRole('button', { name }));
  }

  // Esc closes it, and focus goes back to the task.
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(row).toBeFocused();

  // A new name and a longer description save together, and Undo puts both back.
  await row.click();
  await popup.getByRole('button', { name: 'Rename Draft the summary' }).click();
  await popup.getByRole('textbox', { name: 'Name' }).fill('Draft the executive summary');
  await popup.getByRole('button', { name: 'Edit description' }).click();
  const description = popup.getByRole('textbox', { name: 'Description' });
  await description.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await description.pressSequentially('\n- Attach the charts');
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved Draft the executive summary.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Edit task Draft the executive summary/ })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Edit task Draft the summary, 2h, has details' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the body scrolls once the popup reaches 70% of the window, with its name and buttons kept in view', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const long = Array.from({ length: 60 }, (_, i) => `- Step ${i + 1}`).join('\n');
  await page.clock.install({ time: NOW });
  await openSeeded(page, [...records.filter((r) => r.id !== 't1'), { ...records.find((r) => r.id === 't1')!, fields: { ...records.find((r) => r.id === 't1')!.fields, notes: long } }]);
  await openProject(page, phone);
  await page.getByRole('button', { name: /^Edit task Draft the summary/ }).click();
  const popup = popupOf(page, 'Draft the summary');
  await page.waitForTimeout(300);
  await expectShape(page, popup, phone);
  const body = popup.locator('.taskpopbody');
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(popup.getByRole('heading', { name: 'Draft the summary' })).toBeInViewport();
  await expect(popup.getByRole('button', { name: 'Save' })).toBeInViewport();
  await expect(popup.getByText('Step 60')).toBeInViewport();
});

// The owner's request: an Inbox item opens to be changed, its description included, and Process stays a tap away.
test('an Inbox item opens in its popup to be renamed and described, and still goes to Process', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  if (phone) await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ }).click();
  else await go(page, 'Inbox');
  const inbox = pane(page, 'Inbox');
  const name = inbox.getByRole('button', { name: 'Fix the gate', exact: true });
  if (phone) await expectTapTarget(name);
  await name.click();
  const popup = popupOf(page, 'Fix the gate');
  await expect(popup.getByLabel('Belongs to')).toHaveValue('inbox');
  await popup.getByRole('button', { name: 'Rename Fix the gate' }).click();
  await popup.getByRole('textbox', { name: 'Name' }).fill('Fix the side gate');
  await popup.getByRole('textbox', { name: 'Description' }).fill('Hinges are in the **shed**');
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved Fix the side gate.')).toBeVisible();
  const renamed = inbox.getByRole('button', { name: /^Fix the side gate/ });
  await expect(renamed.getByRole('img', { name: 'Has details' })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`inbox-${info.project.name}.png`) });

  // Opened again, it shows the description formatted.
  await renamed.click();
  await expect(popupOf(page, 'Fix the side gate').locator('.notes strong')).toHaveText('shed');
  await page.keyboard.press('Escape');

  // Process is still reached from the row: Assign on desktop, › on phone.
  const process = inbox.getByRole('button', { name: phone ? 'Process Fix the side gate' : 'Assign Fix the side gate' });
  if (phone) await expectTapTarget(process);
  await process.click();
  await expect(page.getByText('Fix the side gate', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'One offs' })).toBeVisible();
});

test('the Now card, a To schedule card and a block on Today open the popup', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const popup = popupOf(page, 'Draft the summary');

  const now = page.getByRole('region', { name: 'Current block' });
  await now.getByRole('button', { name: 'Draft the summary' }).click();
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);

  await page.getByRole('button', { name: /^Check the totals, Project, .*to schedule$/ }).click();
  const actions = phone ? page.getByRole('dialog', { name: 'Check the totals' }) : page.getByRole('group', { name: 'Check the totals' });
  await actions.getByRole('button', { name: 'Check the totals', exact: true }).click();
  await expect(popupOf(page, 'Check the totals')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popupOf(page, 'Check the totals')).toHaveCount(0);
  await actions.getByRole('button', { name: 'Close' }).click();

  // A block on the timeline opens it itself, on the calendar and in the list. On phone a block still to come is a slider.
  await page.getByRole(phone ? 'slider' : 'button', { name: /^Draft the summary, 4pm to 5pm/ }).click();
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await page.getByRole('button', { name: 'List' }).click();
  await page.getByRole('button', { name: phone ? /^Draft the summary, 4pm to 5pm/ : /^4pm to 5pm/ }).click();
  await expect(popup).toBeVisible();
});

test("Capture's Add details opens with Time first, takes a description, and keeps Save in reach", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  if (phone) await page.getByRole('button', { name: 'Capture a task' }).click();
  else await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Capture/ }).click();
  const capture = page.getByRole('dialog', { name: 'Capture' });
  const field = capture.getByRole('textbox', { name: /^Capture to/ });
  await field.fill('Draft the summary');
  await capture.getByRole('button', { name: 'Add details' }).click();
  if (!phone) {
    // One Tab from the name reaches Time.
    await field.focus();
    await page.keyboard.press('Tab');
    await expect(capture.getByRole('slider', { name: 'Time' })).toBeFocused();
  }
  const top = async (l: Locator) => (await l.boundingBox())!.y;
  const order = [capture.getByRole('slider', { name: 'Time' }), capture.getByLabel('Send to')];
  await capture.getByLabel('Send to').selectOption({ label: 'Report' });
  order.push(capture.getByRole('combobox', { name: 'Milestone' }), capture.getByRole('textbox', { name: 'Description' }));
  await capture.getByRole('combobox', { name: 'Milestone' }).selectOption({ label: 'Drafts' });
  const tops = [];
  for (const l of order) tops.push(await top(l));
  if (phone) expect(tops).toEqual([...tops].sort((a, b) => a - b));
  else expect(tops[0]! < tops[1]! && tops[1] === tops[2] && tops[2]! < tops[3]!).toBe(true);
  const description = capture.getByRole('textbox', { name: 'Description' });
  await description.fill('Use the **Q3 numbers** first.');
  if (phone) {
    // Save stays at the foot of the sheet, in reach with the details open.
    await expect(capture.getByRole('button', { name: 'Save' })).toBeInViewport();
  }
  await page.screenshot({ path: info.outputPath(`capture-${info.project.name}.png`) });
  if (phone) await capture.getByRole('button', { name: 'Save' }).click();
  else await description.press('ControlOrMeta+Enter');
  await expect(page.getByText('Saved to Report, Drafts')).toBeVisible();
  await openProject(page, phone);
  await page.getByRole('button', { name: /^Edit task Draft the summary, No estimate, has details/ }).click();
  await expect(popupOf(page, 'Draft the summary').locator('.notes strong')).toHaveText('Q3 numbers');
});
