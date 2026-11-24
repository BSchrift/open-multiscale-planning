// A calendar's zoom levels, Today's and Week's on desktop: four sizes for its hours, each a multiple of that calendar's
// usual hour, so Today's 30px and Week's 26px (40 while editing) grow alike. CalendarZoom.tsx has the buttons that step
// them; these are apart from it because the week grid, which uses them, loads with the app's first screen.

/** The steps, from the usual hour, the furthest out, to 3.2 times it: Today's 30, 48, 72 and 96px. */
export const ZOOM = [1, 1.6, 2.4, 3.2];

/** A level kept within the first and last steps, as a pinch leaves it. */
export const clampZoom = (zoom: number) => Math.max(ZOOM[0]!, Math.min(ZOOM[ZOOM.length - 1]!, zoom));

/** An hour's height at a level, to a whole pixel, so the hour lines stay sharp. */
export const hourHeight = (usual: number, zoom: number) => Math.round(usual * zoom);

/** Hours between labels: every other hour until an hour is drawn 48px tall. */
export const hourLabelStep = (hour: number) => (hour < 48 ? 2 : 1);
