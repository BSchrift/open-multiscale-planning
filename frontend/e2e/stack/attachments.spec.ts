import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { go, pane, seed, syncNow } from '../seed';
import { closeDevices, device, NETWORK, oneOff, signIn } from './devices';

// A link and a photo added to a task on one device reach another, which opens the photo from private storage. On a
// deployment, the photo goes through its bucket and its distribution, by the links the API signs.

test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

/** A small PNG made by the page, as a camera or photo library would hand one over. */
const png = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 48;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#3a7';
        ctx.fillRect(0, 0, 64, 48);
        canvas.toBlob((blob) => void blob!.arrayBuffer().then((bytes) => resolve(Array.from(new Uint8Array(bytes)))), 'image/png');
      }),
  );

async function openTask(page: Page, title: string) {
  await go(page, 'One offs');
  await pane(page, 'One offs').getByRole('button', { name: title, exact: true }).click();
  const popup = page.locator(`.sheet.taskpop[aria-label="${title}"]`);
  await expect(popup).toBeVisible();
  return popup;
}

test('a link and a photo added on one device reach another, which opens the photo', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const run = randomUUID().slice(0, 8);
  const title = `Fix the gate ${run}`;
  const id = `e2e-${run}-gate`;
  const a = await device(browser, `e2e-${run}`);
  const b = await device(browser, `e2e-${run}`);
  await seed(a.page, [oneOff(id, title)]);
  await signIn(a.page);
  await signIn(b.page);

  let popup = await openTask(a.page, title);
  const section = popup.getByRole('region', { name: 'Attachments' });
  await section.getByRole('button', { name: '+ Add a link or photo' }).click();
  await expect(section.getByText(/ of \d+ (MB|GB) used/)).toBeVisible(NETWORK);
  await section.getByRole('button', { name: 'Paste a link' }).click();
  await section.getByRole('textbox', { name: 'Address' }).fill('https://example.com/hinges');
  await section.getByRole('textbox', { name: 'Name (optional)' }).fill('Hinges');
  await section.getByRole('button', { name: 'Add link' }).click();
  await expect(section.getByRole('link', { name: 'Hinges' })).toBeVisible();
  await section.getByRole('button', { name: '+ Add a link or photo' }).click();
  await section.getByLabel('Choose a photo', { exact: true }).and(a.page.locator('input')).setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: Buffer.from(await png(a.page)) });
  await expect(section.getByRole('button', { name: 'Open gate.jpg' })).toBeVisible();
  await expect(section.getByText('Waiting to upload')).toBeVisible();
  await a.page.keyboard.press('Escape');

  // The record syncs, then the photo uploads, then that it's uploaded syncs.
  await syncNow(a.page);
  await syncNow(a.page);
  popup = await openTask(a.page, title);
  await expect(popup.getByText(/^Photo · \d+ KB$/)).toBeVisible(NETWORK);
  await a.page.keyboard.press('Escape');

  await syncNow(b.page);
  popup = await openTask(b.page, title);
  await expect(popup.getByRole('link', { name: 'Hinges' })).toHaveAttribute('href', 'https://example.com/hinges');
  await expect(popup.getByText(/^Photo · \d+ KB$/)).toBeVisible();
  await popup.getByRole('button', { name: 'Open gate.jpg' }).click();
  const viewer = b.page.getByRole('dialog', { name: 'gate.jpg' });
  const image = viewer.getByRole('img', { name: 'gate.jpg' });
  await expect(image).toBeVisible(NETWORK);
  expect(await image.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([64, 48]);
  await viewer.getByRole('button', { name: 'Close' }).click();
  // Kept on this device now, it's the row's thumbnail.
  await expect(popup.locator('.attachicon img')).toBeVisible();
  await b.page.screenshot({ path: info.outputPath('attachments-desktop.png') });
  await b.page.keyboard.press('Escape');
  // The same popup on a phone's screen, a sheet from the bottom, with the photo kept on the device from before.
  await b.page.setViewportSize({ width: 390, height: 844 });
  await b.page.reload();
  await b.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
  await b.page.getByRole('button', { name: /^One offs/ }).click();
  await b.page.getByRole('button', { name: title, exact: true }).click();
  await expect(popup.locator('.taskpopgrab')).toBeVisible();
  await expect(popup.locator('.attachicon img')).toBeVisible();
  await popup.locator('.taskpopbody').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  // Risen all the way: a page behind another device's runs its animations only once it's in front.
  await b.page.bringToFront();
  await popup.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await b.page.screenshot({ path: info.outputPath('attachments-phone.png') });
  await b.page.keyboard.press('Escape');

  // A deployment's test user keeps nothing live.
  await seed(a.page, [{ type: 'task', id, fields: { deleted_at: new Date().toISOString() } }]);
  await syncNow(a.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
});
