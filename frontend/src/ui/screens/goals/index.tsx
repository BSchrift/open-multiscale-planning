// Goals: the goal hierarchy, or one project's page with params { project: id }, which other areas can link to.

import { useMemo } from 'react';
import type { PlanContext } from '../../../core/plan';
import { useNav } from '../../app/nav';
import type { ScreenProps } from '../../app/registry';
import { useApp, useQuery, useToday } from '../../app/store';
import { loadGoals } from './data';
import { GoalsPage } from './GoalsPage';
import { ProjectPage } from './ProjectView';
import './goals.css';

export default function Screen(props: ScreenProps) {
  const { clock } = useApp();
  const nav = useNav();
  const day = useToday();
  const { data } = useQuery((sql, c) => loadGoals(sql, c), [day]);
  const ctx = useMemo<PlanContext | null>(() => (data ? { settings: data.settings, clock, away: data.away } : null), [data, clock]);
  if (!data || !ctx) return null;

  const id = props.params.project;
  if (id) {
    const plan = data.plans.find((p) => p.project.id === id);
    const goal = data.objectives.find((g) => g.id === plan?.project.objective_id)?.title;
    return <ProjectPage plan={plan} goal={goal} goals={data.objectives} ctx={ctx} onClosed={nav.back} />;
  }
  return <GoalsPage data={data} ctx={ctx} />;
}
