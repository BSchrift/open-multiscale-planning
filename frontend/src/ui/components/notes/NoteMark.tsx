import { NotesIcon } from '../icons';
import './notes.css';

/** The small mark a task with details carries in its rows. */
export function NoteMark() {
  return (
    <span className="notemark" role="img" aria-label="Has details">
      <NotesIcon />
    </span>
  );
}
