import './notes.css';
import { Icon } from '../ds/Icon';

/** The small mark a task with details carries in its rows. */
export function NoteMark() {
  return (
    <span className="notemark" role="img" aria-label="Has details">
      <Icon name="notes" />
    </span>
  );
}
