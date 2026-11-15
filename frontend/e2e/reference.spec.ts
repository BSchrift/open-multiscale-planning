import { expect, test } from '@playwright/test';

// The design system's reference page, in both themes at both sizes. Its screenshots are the visual regression test:
// a change to how any component or block state looks changes them, so it shows in review. CI compares them on Linux;
// scripts/reference-shots.sh redraws them there, and local runs on other systems skip the comparison.
for (const theme of ['light', 'dark'] as const) {
  test(`draws every component and block state, ${theme}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const layout = info.project.name === 'phone' ? 'phone' : 'desktop';
    await page.goto(`/reference.html?theme=${theme}&layout=${layout}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Design system' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // Every kind in every state it can be in, and a 15-minute block in each state.
    await expect(page.locator('.refblocks .blk')).toHaveCount(5 * 9 + 2 + 9);
    await expect(page.locator('.refblocks .ansbadge')).toHaveCount(5 * 4 + 4);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(wide, 'the page scrolls sideways').toBe(false);
    await expect(page).toHaveScreenshot(`reference-${theme}.png`, { fullPage: true, maxDiffPixelRatio: 0.01, animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}
