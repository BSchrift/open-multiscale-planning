// The Plan area: the Plan page, and planning ahead as a flow (full screen on phone).

import type { ScreenProps } from '../../app/registry';
import { useQuery } from '../../app/store';
import { loadPlan } from './data';
import { PlanFlow } from './Flow';
import { PlanPage } from './PlanPage';
import './plan.css';

export default function PlanScreen(props: ScreenProps) {
  const { data } = useQuery((sql, clock) => loadPlan(sql, clock), []);
  if (!data) return null;
  return props.presentation === 'flow' ? (
    <PlanFlow data={data} layout={props.layout} close={props.close} />
  ) : (
    <PlanPage data={data} layout={props.layout} params={props.params} />
  );
}
