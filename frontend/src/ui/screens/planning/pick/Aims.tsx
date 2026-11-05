// Change aims for this week: a slider for each project and One offs. The usual aim stays on the project.

import { EstimateSlider } from '../../../components/EstimateSlider';
import type { PickProps } from './PickStep';

export function Aims(props: PickProps & { withSkip?: boolean }) {
  return (
    <div className="stack8">
      {props.aims.map((a) => {
        const skipLabel = a.skipped ? "Count this week's aim" : "Skip this week's aim";
        return (
          <div key={a.bucket} className="stack8">
            <EstimateSlider label={`Aim for ${a.name} this week`} value={a.value} noneLabel="No aim" onChange={(m) => props.setAim(a.bucket, m)} />
            {props.withSkip && a.canSkip && (
              <div>
                <button className="btn plain" type="button" aria-label={`${skipLabel}, ${a.name}`} onClick={() => props.toggleSkipAim(a.bucket)}>
                  {skipLabel}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {props.aimsChanged && (
        <div>
          <button className="btn sm" type="button" onClick={props.resetAims}>
            Back to my usual aims
          </button>
        </div>
      )}
    </div>
  );
}
