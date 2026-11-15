import { expect, test } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';

test('seeded records reach the screens without a reload', async ({ page }) => {
  await openSeeded(page, [{ type: 'task', fields: { kind: 'inbox', title: 'Paint the fence' } }]);
  await expect(page.getByRole('heading', { name: 'Welcome' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByText('1', { exact: true })).toBeVisible();
});

test('a tap target is measured once what it sits in has finished moving in, and not held up by an endless animation', async ({ page }) => {
  // The browser reads a moved box's corners to the nearest float, so a 44px box moved a fraction of a pixel across
  // y=512 reads 43.99997px, as one in a sheet sliding up did. This holds it there for a second, while it pulses forever.
  await page.setContent(`<meta name="viewport" content="width=device-width"><style>
    @keyframes hold { from, to { transform: translateY(0.1px); } }
    @keyframes pulse { to { opacity: 0.9; } }
    body { margin: 0; }
    div { position: absolute; top: 480px; animation: hold 1s, pulse 1s infinite; }
    button { all: unset; display: block; width: 44px; height: 44px; }
  </style><div><button>Go</button></div>`);
  await expectTapTarget(page.getByRole('button', { name: 'Go' }));
});
