// Small in-place editor. On desktop it hangs below its anchor: put it inside an element with position: relative,
// such as .editrow. On phone there's no room for that, so it's a sheet.

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../app/store';
import { Sheet } from './Sheet';
import { useDialogFocus } from './useDialogFocus';

function Anchored(props: { label: string; onClose(): void; children: ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(props.onClose);
  const { onClose } = props;
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [ref, onClose]);
  return (
    <div ref={ref} className="panel stack8 qpop popover" role="dialog" aria-label={props.label} tabIndex={-1}>
      {props.children}
    </div>
  );
}

export function Popover(props: { label: string; onClose(): void; children: ReactNode }) {
  const { layout } = useApp();
  if (layout === 'phone') {
    return (
      <Sheet label={props.label} onClose={props.onClose}>
        {props.children}
      </Sheet>
    );
  }
  return <Anchored {...props} />;
}
