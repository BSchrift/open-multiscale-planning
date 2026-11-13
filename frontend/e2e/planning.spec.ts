import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EST_STEPS } from '../src/ui/components/EstimateSlider';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm, with this week not yet planned.

const records: Seed[] = [
  { type: 'project', id: 'report', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15', weekly_aim: 240 } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'report', title: 'Gather notes', due: '2026-10-18' } },
  { type: 'milestone', id: 'm2', fields: { project_id: 'report', title: 'Draft chapters', due: '2026-11-09' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Collect the sources', estimate_min: 120 } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'report', milestone_id: 'm2', title: 'Write chapter one', estimate_min: 240 } },
  { type: 'project', id: 'bread', fields: { title: 'Learn to bake bread', state: 'active', start: '2026-10-15', end: '2027-02-28', weekly_aim: 120 } },
  { type: 'milestone', id: 'm3', fields: { project_id: 'bread', title: 'Shape the first loaf', due: '2026-12-01' } },
  { type: 'task', id: 'b1', fields: { kind: 'project', project_id: 'bread', milestone_id: 'm3', title: 'Bake a test loaf', estimate_min: 180 } },
  { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once', from: '2026-11-04' } } },
  { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Rake the leaves' } },
];

const steps = (page: Page) => page.getByRole('navigation', { name: 'Planning steps' });

async function startPlanning(page: Page) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await expect(steps(page)).toBeVisible();
}

test('plans a week: Inbox, pick with Does it fit, then finish at Review', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await startPlanning(page);

  // Inbox
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Process 1 item' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();

  // Pick: a card per project, open with two of them. A task's title opens its popup, and a rename shows at once, with
  // focus back on the title.
  await page.getByRole('button', { name: /^Edit task Write chapter one/ }).click();
  const editor = page.getByRole('dialog', { name: 'Write chapter one' });
  await editor.getByRole('button', { name: 'Rename Write chapter one' }).click();
  await editor.getByRole('textbox', { name: 'Name' }).fill('Write the first chapter');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  const renamed = page.getByRole('button', { name: /^Edit task Write the first chapter/ });
  await expect(renamed).toBeFocused();
  if (phone) expect((await renamed.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Its time button adds it; then it opens This week and the estimate, which wait for Save.
  const fit = phone ? page.locator('.flowtop .fitline') : page.getByRole('region', { name: 'Does it fit?' });
  const add = page.getByRole('button', { name: 'Add 4h to this week: Write the first chapter' });
  if (phone) await expectTapTarget(add.locator('xpath=..'));
  await add.click();
  await expect(fit.locator('.fdelta')).toHaveText('+4h');
  const time = page.getByRole('button', { name: '4h this week: Write the first chapter' });
  // WebKit doesn't focus a button you tap, so only the desktop's keeps focus to check.
  if (!phone) await expect(time).toBeFocused();
  await time.click();
  const pop = page.getByRole('dialog', { name: 'Write the first chapter' });
  const slider = pop.getByRole('slider', { name: 'Estimate' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '5h');
  // Back where it was, so the suggestions below stay as they are, and Save has nothing to write.
  await page.keyboard.press('ArrowLeft');
  if (phone) await expectTapTarget(pop.getByRole('button', { name: 'Save' }));
  await pop.getByRole('button', { name: 'Save' }).click();
  await expect(pop).toHaveCount(0);

  // Its circle finishes it in place, struck through, with a toast that says what it freed, until it's unticked.
  const done = page.getByRole('checkbox', { name: 'Already done: Write the first chapter' });
  if (phone) await expectTapTarget(done.locator('xpath=..'));
  await done.click();
  await expect(page.getByText('Write the first chapter done. 4h freed.')).toBeVisible();
  await expect(done).toBeChecked();
  await expect(fit.locator('.fdelta')).toHaveText('4h freed');
  await page.screenshot({ path: info.outputPath(`pick-done-${info.project.name}.png`) });
  await done.click();
  await expect(done).not.toBeChecked();

  const report = page.getByRole('region', { name: 'Write the report' });
  // Overdue is asked inside its card, and the link at the top jumps there.
  const ask = report.getByRole('group', { name: 'Gather notes was due Oct 18' });
  await expect(ask).toBeVisible();
  if (phone) await expectTapTarget(ask.getByRole('button', { name: 'Keep in plan: Gather notes' }));
  else {
    await page.getByRole('button', { name: '1 overdue' }).click();
    await expect(ask).toBeFocused();
  }
  const collect = report.getByRole('button', { name: 'Add 2h to this week: Collect the sources' });
  if (phone) await expectTapTarget(collect.locator('xpath=..'));
  await collect.click();
  await expect(fit.locator('.fdelta')).toHaveText('+2h');
  await expect(report.getByRole('button', { name: '2h this week: Collect the sources' })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`pick-${info.project.name}.png`) });

  if (phone) {
    // Does it fit shows This week: the week's shape, then its tasks.
    await page.getByRole('button', { name: /^Does it fit\? .* Show This week$/ }).click();
    await expect(page.getByRole('region', { name: 'This week', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'In this week' }).getByText('Paint the fence', { exact: true })).toBeVisible();
    await expectTapTarget(page.getByRole('button', { name: 'Remove Paint the fence from this week' }));
    await page.getByRole('button', { name: 'Projects' }).click();

    // Add suggested lists what it would add, each ticked, before it adds them.
    await page.getByRole('button', { name: /^Add suggested/ }).click();
    const suggested = page.getByRole('dialog', { name: 'Add suggested' });
    await suggested.getByRole('button', { name: /^Add / }).click();
    await expect(suggested).toHaveCount(0);
    await expect(page.getByRole('button', { name: /this week: Bake a test loaf$/ })).toBeVisible();

    await steps(page).getByRole('button', { name: 'Review' }).click();
  } else {
    const week = page.getByRole('region', { name: 'This week', exact: true });
    await expect(week.getByRole('img', { name: 'Weekly aim 4h, 6h planned, reached' })).toBeVisible();
    await page.screenshot({ path: info.outputPath('pick-desktop.png') });

    await week.getByRole('button', { name: /^Add suggested/ }).click();
    const suggested = page.getByRole('dialog', { name: 'Add suggested' });
    await suggested.getByRole('button', { name: /^Add / }).click();
    await expect(suggested).toHaveCount(0);
    await expect(page.getByRole('button', { name: /this week: Bake a test loaf$/ })).toBeVisible();

    await steps(page).getByRole('button', { name: '4. Review' }).click();
  }

  // Does it fit stays on every step.
  await expect(fit).toBeVisible();

  // Review: nothing is placed yet, so the aims aren't reached, and finishing is still allowed.
  await expect(page.getByRole('heading', { name: '2 aims not reached' })).toBeVisible();
  await expect(page.getByText(/of what you picked isn't scheduled/)).toBeVisible();
  await page.screenshot({ path: info.outputPath(`review-${info.project.name}.png`) });
  await page.getByRole('button', { name: 'Finish plan' }).click();
  await expect(steps(page)).toHaveCount(0);
  await expect(page.getByText('Week planned.')).toBeVisible();
  expect(errors).toEqual([]);
});

// Every button in a task row shows all of its label, as do the WCAG text spacing settings, and no time button wraps
// onto a second line. Mark done's label once spilled out of a fixed-width button.
test("task rows' buttons fit their labels, with and without text spacing", async ({ page }, info) => {
  await startPlanning(page);
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  // One row added, so its time button reads "2h of …", and one finished.
  await page.getByRole('button', { name: 'Add 2h to this week: Collect the sources' }).click();
  await page.getByRole('checkbox', { name: 'Already done: Write chapter one' }).click();
  await expect(page.getByRole('checkbox', { name: 'Already done: Write chapter one' })).toBeChecked();
  const measure = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll('.tk')];
      const clipped = rows.flatMap((row) => [...row.querySelectorAll('button')].filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.getAttribute('aria-label')));
      // Lines of text: a smaller glyph on the same line, such as ▾, sits a few pixels lower but not a line lower.
      const lines = (cell: Element) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const mids = [...range.getClientRects()].map((r) => r.top + r.height / 2).sort((a, b) => a - b);
        return mids.filter((m, i) => i === 0 || m - mids[i - 1]! > 10).length;
      };
      const wrapped = [...document.querySelectorAll('.tk .tp, .tk .tq')].filter((cell) => lines(cell) > 1).map((cell) => cell.textContent);
      return { rows: rows.length, clipped, wrapped };
    });
  const plain = await measure();
  expect(plain.rows).toBeGreaterThan(1);
  expect({ clipped: plain.clipped, wrapped: plain.wrapped }).toEqual({ clipped: [], wrapped: [] });
  await page.addStyleTag({
    content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
  });
  const spaced = await measure();
  expect({ clipped: spaced.clipped, wrapped: spaced.wrapped }).toEqual({ clipped: [], wrapped: [] });
  await page.screenshot({ path: info.outputPath(`pick-spacing-${info.project.name}.png`) });
});

// A toast never covers a row: on phone it takes its own strip above the bottom bar, and on desktop it sits at the foot of
// the column the change was made in, clear of the week's shape.
test("a toast covers no row and sits clear of the bottom bar and the week's shape", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await startPlanning(page);
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  await page.getByRole('checkbox', { name: 'Already done: Collect the sources' }).click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Collect the sources done.');
  const box = (await toast.boundingBox())!;
  if (phone) {
    const bar = (await page.locator('.flowbot').boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
    // The list ends above the toast, so no row on screen sits under it.
    const list = (await page.locator('.pkscroll').boundingBox())!;
    expect(list.y + list.height).toBeLessThanOrEqual(box.y);
  } else {
    const main = (await page.locator('.cleft').boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (main.x + main.width / 2))).toBeLessThan(2);
    const side = (await page.locator('.cright').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(side.x);
  }
  await page.screenshot({ path: info.outputPath(`pick-toast-${info.project.name}.png`) });
});

// Adding while you pick: a task from a card's foot, or from + Add, lands in its milestone and in this week, with Undo.
test('adds a task while picking, from the card or from Add, in this week, with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await startPlanning(page);
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  const report = page.getByRole('region', { name: 'Write the report' });
  const addTask = report.getByRole('button', { name: 'Add task to Write the report' });
  if (phone) {
    await expectTapTarget(addTask);
    await expectTapTarget(report.getByRole('button', { name: 'Add milestone to Write the report' }));
    await page.getByRole('button', { name: 'Add a task, one off, milestone or project' }).click();
    const menu = page.getByRole('dialog', { name: 'Add' });
    await expect(menu.getByRole('button', { name: 'Task to Inbox' })).toBeVisible();
    await menu.getByRole('button', { name: 'Task in Write the report' }).click();
  } else {
    await page.getByRole('button', { name: '+ Add', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Add' }).getByRole('button', { name: 'Project' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Add' }).getByRole('button', { name: 'Task in Write the report' }).click();
  }
  const form = page.getByRole('form', { name: 'New task in Write the report' });
  await form.getByRole('combobox', { name: 'Milestone' }).selectOption({ label: 'Draft chapters' });
  await form.getByRole('textbox', { name: 'Title' }).fill('Outline chapter three');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Added Outline chapter three to Draft chapters, 1h in this week.')).toBeVisible();
  await expect(form.getByRole('textbox', { name: 'Title' })).toHaveValue('');
  await page.screenshot({ path: info.outputPath(`pick-add-${info.project.name}.png`) });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await form.getByRole('textbox', { name: 'Title' }).fill('Outline chapter four');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Added Outline chapter four to Draft chapters, 1h in this week.')).toBeVisible();
  await form.getByRole('button', { name: 'Close' }).click();
  await expect(report.getByRole('button', { name: '1h this week: Outline chapter four' })).toBeVisible();
  await expect(report.getByRole('button', { name: /Outline chapter three$/ })).toHaveCount(0);
});

test('week arrows have no limit, with This week to come back, and the step is kept', async ({ page }) => {
  await startPlanning(page);
  const next = page.getByRole('button', { name: 'Next week' });
  for (let i = 0; i < 6; i++) await next.click();
  await expect(page.getByText('Dec 14 to 20')).toBeVisible();
  await page.getByRole('button', { name: 'This week' }).click();
  await expect(page.getByText('Nov 2 to 8')).toBeVisible();
  await expect(page.getByRole('button', { name: 'This week' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(steps(page)).toHaveCount(0);
  await page.getByRole('button', { name: /Start planning|Continue planning/ }).first().click();
  await expect(steps(page).locator('[aria-current="step"]')).toHaveText(/Pick/);
});

/** Before the app loads: counts the transactions the app's database worker (src/platform/web.ts) commits. */
function countCommits() {
  const counted = window as unknown as { commits: number };
  counted.commits = 0;
  window.Worker = class extends window.Worker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const post = this.postMessage.bind(this) as (message: unknown) => void;
      this.postMessage = ((message: { op?: string; sql?: string }) => {
        if (message?.op === 'exec' && message.sql === 'COMMIT') counted.commits++;
        post(message);
      }) as Worker['postMessage'];
    }
  };
}
const commits = (page: Page) => page.evaluate(() => (window as unknown as { commits: number }).commits);

// The owner's report: dragging an estimate was laggy. Every step saved, and the thumb jumped back until it read back.
test('dragging an estimate in Pick follows the mouse and saves once, where it was let go, with Undo', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', "Playwright's touchscreen only taps, and touch pointer events don't move a native range");
  await page.addInitScript(countCommits);
  await startPlanning(page);
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  await page.getByRole('button', { name: 'Add 2h to this week: Collect the sources' }).click();
  await page.getByRole('button', { name: '2h this week: Collect the sources' }).click();
  const slider = page.getByRole('dialog', { name: 'Collect the sources' }).getByRole('slider', { name: 'Estimate' });
  const box = (await slider.boundingBox())!;
  // The thumb's centre at each step, inset by half the thumb.
  const at = (step: number) => [box.x + 8 + ((box.width - 16) * step) / (EST_STEPS.length - 1), box.y + box.height / 2] as const;
  const from = EST_STEPS.indexOf(120);
  const to = EST_STEPS.indexOf(360);
  const before = await commits(page);
  await page.mouse.move(...at(from));
  await page.mouse.down();
  let last = from;
  for (let step = from + 1; step <= to; step++) {
    await page.mouse.move(...at(step), { steps: 3 });
    const now = Number(await slider.inputValue());
    expect(now, `the thumb at step ${step}`).toBeGreaterThanOrEqual(last);
    last = now;
  }
  await page.mouse.up();
  await expect(slider).toHaveAttribute('aria-valuetext', '6h');
  // Letting go sets the popover's draft; Save writes it, once.
  expect(await commits(page)).toBe(before);
  await page.getByRole('dialog', { name: 'Collect the sources' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Collect the sources, 6h this week, 6h estimate.')).toBeVisible();
  expect(await commits(page)).toBe(before + 1);
  await page.screenshot({ path: info.outputPath('pick-estimate-drag.png') });

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: '2h this week: Collect the sources' })).toBeVisible();
});
