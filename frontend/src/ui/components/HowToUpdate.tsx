// The steps for installing the new Mac app by hand, for an app too old to replace itself. Settings › Updates and the
// sidebar's notice open it. What's behind it is inert while it's open: VoiceOver doesn't reliably keep to aria-modal.

import { useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../app/store';
import { Sheet } from './Sheet';
import { Button } from './ds/Button';

export function HowToUpdate(props: { download: string; onClose(): void }) {
  const { platform } = useApp();
  // Before the dialog's own focus handling gives focus back on close, which it can't to an inert button.
  useLayoutEffect(() => {
    const behind = Array.from(document.querySelectorAll<HTMLElement>('[data-layout] > .side, [data-layout] > .mainarea'));
    for (const element of behind) element.setAttribute('inert', '');
    return () => {
      for (const element of behind) element.removeAttribute('inert');
    };
  }, []);
  // If what opened it has gone, as when a check finds the update can be taken after all, focus goes to the current page.
  useEffect(
    () => () =>
      queueMicrotask(() => {
        if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('.side [aria-current="page"]')?.focus();
      }),
    [],
  );
  // Drawn at the layout's root, beside the sidebar and the page rather than inside either.
  const root = document.querySelector<HTMLElement>('[data-layout]');
  const sheet = (
    <Sheet label="Install the new Mac app" describedBy="howto-why" onClose={props.onClose}>
      <h2>Install the new Mac app</h2>
      <p id="howto-why" className="quiet">
        This is the last time you install Multiscale by hand. Your plans stay as they are: they're saved on this Mac and synced.
      </p>
      <ol className="howto">
        <li>Download the app, below.</li>
        <li>Quit Multiscale: click its icon in the menu bar, then Quit.</li>
        <li>Open Multiscale.dmg from Downloads and drag Multiscale to Applications. Choose Replace.</li>
        <li>Open Multiscale from Applications, then eject the disk image.</li>
      </ol>
      <div className="row">
        <Button variant="primary" type="button" onClick={() => void platform.openExternal(props.download)}>
          Download the app
        </Button>
        <Button type="button" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </Sheet>
  );
  return root ? createPortal(sheet, root) : sheet;
}
