// A calendar's Zoom out and Zoom in, Today's and Week's on desktop, through the levels in zoom.ts. The screen keeps the
// level in its own state, which lasts while the app is open, since a tab's pane stays mounted.

import { Icon } from './ds/Icon';
import { ZOOM } from './zoom';

/** The two buttons, beside the calendar and never over it. From between steps, as a pinch leaves it, each goes to the next step its way. */
export function ZoomButtons(props: { zoom: number; onZoom(zoom: number): void }) {
  const { zoom, onZoom } = props;
  return (
    <div className="zoomgroup" role="group" aria-label="Calendar zoom">
      <button className="zoombtn" type="button" aria-label="Zoom out" title="Zoom out" disabled={zoom <= ZOOM[0]!} onClick={() => onZoom([...ZOOM].reverse().find((z) => z < zoom) ?? zoom)}>
        <Icon name="zoom-out" />
      </button>
      <button className="zoombtn" type="button" aria-label="Zoom in" title="Zoom in" disabled={zoom >= ZOOM[ZOOM.length - 1]!} onClick={() => onZoom(ZOOM.find((z) => z > zoom) ?? zoom)}>
        <Icon name="zoom-in" />
      </button>
    </div>
  );
}
