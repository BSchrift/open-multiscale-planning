import { describe, expect, it } from 'vitest';
import { describeBlock, KIND_WORD } from './describe';

describe('describeBlock', () => {
  const objective = { id: 'bread', title: 'Learn to bake bread', state: 'active' as const };

  it("reads a project task's block as Goal > Project", () => {
    const project = { id: 'p', title: 'Rye bread', state: 'active' as const, start: '2026-11-01', end: '2026-12-01' };
    expect(describeBlock({ practice_id: null, task_kind: 'project' }, { project, objective })).toEqual({ kind: 'project', word: 'Goal', path: 'Learn to bake bread > Rye bread' });
  });

  it("reads a backlog task's block as Goal > Backlog, with the Backlog kind word, whatever title an older app stored", () => {
    const project = { id: 'backlog:bread', title: 'Old name, Backlog', state: 'active' as const, start: '2026-11-01', end: '2026-12-01' };
    expect(describeBlock({ practice_id: null, task_kind: 'project' }, { project, objective })).toEqual({ kind: 'project', word: 'Backlog', path: 'Learn to bake bread > Backlog' });
    expect(KIND_WORD.project).toBe('Project');
  });
});
