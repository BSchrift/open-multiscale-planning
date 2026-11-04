import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../../app/store';
import { Sheet } from '../Sheet';

/** An add form: in place on desktop, a sheet on phone. Either way, closing gives focus back to what opened it. */
export function SheetOnPhone(props: { label: string; onClose(): void; children: ReactNode }) {
  const { layout } = useApp();
  if (layout === 'phone') {
    return (
      <Sheet label={props.label} tall onClose={props.onClose}>
        {props.children}
      </Sheet>
    );
  }
  return <InPlace onClose={props.onClose}>{props.children}</InPlace>;
}

function InPlace(props: { onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Read while rendering, before the form's autoFocus field takes focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    const element = ref.current;
    return () => {
      // Only once the form has gone (StrictMode also runs this on mount), and only if focus went with it.
      const active = document.activeElement;
      if (!element?.isConnected && (!active || active === document.body)) opener?.focus?.();
    };
  }, [opener]);
  return (
    <div ref={ref} className="panel inlineform" onKeyDown={(event) => event.key === 'Escape' && props.onClose()}>
      {props.children}
    </div>
  );
}
