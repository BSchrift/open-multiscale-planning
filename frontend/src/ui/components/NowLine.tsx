// The line across a calendar's day at the current time, on today only. It moves with the screen's own clock tick, and
// drops and drags pass through it to what's below.

export function NowLine(props: { top: number | string }) {
  return (
    <div className="nowline" style={{ top: props.top }} role="img" aria-label="Current time">
      <i />
    </div>
  );
}
