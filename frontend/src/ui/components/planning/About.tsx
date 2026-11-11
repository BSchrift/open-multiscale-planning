import { formatMinutes } from '../../../core/dates';
import type { Minutes } from '../../../core/types';
import { spokenMinutes } from './usePlanning';

/**
 * 'About 30m', and what follows it, which a screen reader hears as 'About 30 minutes' rather than letter by letter.
 * before and after are plain text around it.
 */
export function About(props: { minutes: Minutes; before?: string; after?: string }) {
  const { before = '', after = '' } = props;
  return (
    <>
      <span aria-hidden="true">{`${before}About ${formatMinutes(props.minutes)}${after}`}</span>
      <span className="sr">{`${before}About ${spokenMinutes(props.minutes)}${after}`}</span>
    </>
  );
}
