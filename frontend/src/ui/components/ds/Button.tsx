// The app's one button (docs/design.md): primary (the one filled button in a view), secondary (outlined at 3:1),
// quiet (text), destructive (outlined, or filled when it's the confirming choice), icon-only, and link (an underlined
// action inside a line of text). 44px tall, or 36px compact on desktop. It renders the btn classes the stylesheets already know, and keeps a plain <button>'s
// behaviour: no type unless given, so one in a form still submits it.

import type { ComponentPropsWithRef } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

const VARIANT = { primary: 'btn pri', secondary: 'btn', quiet: 'btn plain', destructive: 'btn danger', icon: 'btn btn-icon', link: 'link' } as const;

type Props = ComponentPropsWithRef<'button'> & {
  variant?: keyof typeof VARIANT;
  /** Filled: the confirming choice of a destructive pair. */
  filled?: boolean;
  /** Compact is desktop only; on phone every button is 44pt. */
  size?: 'default' | 'compact';
  icon?: IconName;
  iconEnd?: IconName;
  /** The name read out, in full. Required when the button is only an icon. */
  label?: string;
};

export function Button(props: Props) {
  const { variant = 'secondary', filled, size = 'default', icon, iconEnd, label, className, children, ...rest } = props;
  const base = filled ? VARIANT[variant].replace('btn', 'btn pri') : VARIANT[variant];
  const cls = `${base}${size === 'compact' && variant !== 'link' ? ' sm' : ''}${className ? ` ${className}` : ''}`;
  return (
    <button aria-label={label} {...rest} className={cls}>
      {icon && <Icon name={icon} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={16} />}
    </button>
  );
}
