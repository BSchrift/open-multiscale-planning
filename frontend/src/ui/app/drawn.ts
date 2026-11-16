// The stop of a screen's nav KPI (docs/performance.md): the screen shown with its data, at the frame that draws it.

import { useContext, useEffect } from 'react';
import { perf } from '../../core/perf';
import { PaneShown } from './nav';

/** Ends the KPI each time the screen is shown with its data. Panes stay mounted, so that's on showing as well as on loading. */
export function useDrawn(name: string, ready: boolean): void {
  const shown = useContext(PaneShown) ?? true;
  useEffect(() => {
    if (shown && ready) perf.stopAfterPaint(name);
  }, [name, shown, ready]);
}
