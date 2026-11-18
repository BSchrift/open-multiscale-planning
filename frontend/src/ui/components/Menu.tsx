// A menu of what can be done to one thing, as a right-click opens. On desktop it hangs at the pointer in the popover
// look, and a submenu opens beside its item; on phone it sits by what was held, and a submenu takes its place with
// Back at the top. Focus starts on the first item: the arrow keys move it, Home and End jump, Enter or Space chooses,
// Right and Left open and close a submenu, and Esc, Tab or a press outside closes it, for whoever opened it to put
// focus back. The Mac app draws the same items as macOS's own menu instead (nativeMenu).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { NativeMenuItem } from '../../platform/types';
import { useApp } from '../app/store';
import { Icon } from './ds/Icon';
import type { IconName } from './ds/Icon';
import './menu.css';

export interface MenuChoice {
  id: string;
  label: string;
  icon?: IconName;
  tone?: 'ok' | 'danger';
  submenu?: readonly MenuEntry[];
}
export type MenuEntry = MenuChoice | 'separator';

/** The same items for macOS to draw, labels and ids only. */
export function nativeMenu(entries: readonly MenuEntry[]): NativeMenuItem[] {
  return entries.map((e) => (e === 'separator' ? { type: 'separator' } : e.submenu ? { id: e.id, label: e.label, submenu: nativeMenu(e.submenu) } : { id: e.id, label: e.label }));
}

/** Room kept between the menu and the window's edge. */
const EDGE = 8;
const BACK = 'menu:back';

export function Menu(props: { label: string; entries: readonly MenuEntry[]; at: { x: number; y: number }; onChoose(id: string): void; onClose(): void }) {
  const { label, entries, at, onChoose, onClose } = props;
  const { layout } = useApp();
  const phone = layout === 'phone';
  const main = useRef<HTMLDivElement>(null);
  const side = useRef<HTMLDivElement>(null);
  /** The item whose submenu is open, and whether focus goes into it. */
  const [open, setOpen] = useState<{ id: string; focus: boolean } | null>(null);
  const parent = open ? entries.find((e): e is MenuChoice => e !== 'separator' && e.id === open.id) : undefined;
  const [root] = useState(() => document.querySelector<HTMLElement>('[data-layout]') ?? document.body);

  const items = (panel: HTMLElement | null) => [...(panel?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]') ?? [])];
  /** Focuses the panel's first item, or the one with this id. */
  const focusIn = (panel: HTMLElement | null, id?: string) => {
    const all = items(panel);
    (id ? all.find((i) => i.dataset.id === id) : all[0])?.focus({ preventScroll: true });
  };

  // Kept inside the window: moved left or above where it would run off, and a submenu to the other side of its item.
  useLayoutEffect(() => {
    const panel = main.current;
    if (!panel) return;
    const box = panel.getBoundingClientRect();
    const [w, h] = [window.innerWidth, window.innerHeight];
    panel.style.left = `${Math.max(EDGE, Math.min(at.x, w - box.width - EDGE))}px`;
    panel.style.top = `${Math.max(EDGE, at.y + box.height > h - EDGE ? Math.min(at.y, h - EDGE) - box.height : at.y)}px`;
  }, [at, open, phone]);
  useLayoutEffect(() => {
    const sub = side.current;
    const item = open && main.current?.querySelector<HTMLElement>(`[data-id="${open.id}"]`);
    if (!sub || !item || !main.current) return;
    const [m, i, s] = [main.current.getBoundingClientRect(), item.getBoundingClientRect(), sub.getBoundingClientRect()];
    sub.style.left = `${m.right + s.width > window.innerWidth - EDGE ? m.left - s.width : m.right}px`;
    sub.style.top = `${Math.max(EDGE, Math.min(i.top, window.innerHeight - s.height - EDGE))}px`;
  }, [open]);

  /** The item to take focus back to once its submenu closes. */
  const from = useRef<string | null>(null);
  useEffect(() => focusIn(main.current), []);
  useEffect(() => {
    if (open?.focus) focusIn(phone ? main.current : side.current, phone ? BACK : undefined);
    if (open || !from.current) return;
    focusIn(main.current, from.current);
    from.current = null;
  }, [open, phone]);
  // Anchored where it opened, it goes when the page under it moves.
  useEffect(() => {
    const away = (e: Event) => {
      if (!(e.target instanceof Node && (main.current?.contains(e.target) || side.current?.contains(e.target)))) onClose();
    };
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', away, true);
    return () => {
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', away, true);
    };
  }, [onClose]);

  const closeSub = () => {
    from.current = open?.id ?? null;
    setOpen(null);
  };
  const choose = (e: MenuChoice) => {
    if (e.id === BACK) return closeSub();
    if (e.submenu) return setOpen({ id: e.id, focus: true });
    onChoose(e.id);
  };
  const onKey = (inSub: boolean) => (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = event.currentTarget;
    const all = items(panel);
    const index = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus({ preventScroll: true });
    const current = (document.activeElement as HTMLElement | null)?.dataset.id;
    const entry = (inSub || (phone && parent) ? parent?.submenu ?? [] : entries).find((e): e is MenuChoice => e !== 'separator' && e.id === current);
    const keys: Record<string, () => void> = {
      ArrowDown: () => go(index + 1),
      ArrowUp: () => go(index < 0 ? -1 : index - 1),
      Home: () => go(0),
      End: () => go(-1),
      ArrowRight: () => entry?.submenu && setOpen({ id: entry.id, focus: true }),
      ArrowLeft: () => (inSub || (phone && parent)) && closeSub(),
      Escape: () => (open ? closeSub() : onClose()),
      Tab: onClose,
    };
    const act = keys[event.key];
    if (!act) return;
    event.preventDefault();
    event.stopPropagation();
    act();
  };

  const draw = (list: readonly MenuEntry[]) =>
    list.map((e, i) =>
      e === 'separator' ? (
        <div key={`sep${i}`} role="separator" className="sep" />
      ) : (
        <button
          key={e.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-id={e.id}
          className={`mi${e.tone ? ` m${e.tone}` : ''}${e.id === BACK ? ' mback' : ''}`}
          {...(e.submenu ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open?.id === e.id } : {})}
          onClick={() => choose(e)}
          // The item under the pointer takes focus, so the keys go on from there, and its submenu, if any, opens beside it.
          onPointerEnter={
            phone
              ? undefined
              : (event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  if (list === entries) setOpen(e.submenu ? { id: e.id, focus: false } : null);
                }
          }
        >
          {!phone && e.icon && <Icon name={e.icon} size={16} />}
          <span>{e.label}</span>
          {e.submenu ? <Icon name="chevron-right" size={16} className="mkey" /> : phone && e.icon && <Icon name={e.icon} size={20} />}
        </button>
      ),
    );

  const cls = phone ? 'imenu' : 'cmenu';
  // On phone a submenu takes the menu's place, with Back to return.
  const shown = phone && parent ? [{ id: BACK, label: 'Back' }, ...(parent.submenu ?? [])] : entries;
  return createPortal(
    <>
      <div
        className="menucatch"
        aria-hidden="true"
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div ref={main} className={cls} role="menu" aria-label={phone && parent ? parent.label : label} style={{ left: at.x, top: at.y }} onKeyDown={onKey(false)}>
        {draw(shown)}
      </div>
      {!phone && parent?.submenu && (
        <div ref={side} className={cls} role="menu" aria-label={parent.label} onKeyDown={onKey(true)}>
          {draw(parent.submenu)}
        </div>
      )}
    </>,
    root,
  );
}
