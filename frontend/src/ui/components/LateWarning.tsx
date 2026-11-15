// A project task dated after its deadline: an icon and words, never colour alone. It only warns; nothing is blocked.

import { formatDate } from '../../core/dates';
import type { LocalDate, Milestone } from '../../core/types';
import './late.css';
import { Icon } from './ds/Icon';

/** "Due after Roof watertight (Dec 13)", or "Due after the project ends (Feb 28)". */
export const lateText = (late: { milestone: Milestone | null; due: LocalDate }) =>
  `Due after ${late.milestone ? late.milestone.title : 'the project ends'} (${formatDate(late.due)})`;

/** The same words, as they go on at the end of a row's name: ", due after …". */
export const lateSaid = (text: string | null) => (text ? `, ${text.charAt(0).toLowerCase()}${text.slice(1)}` : '');

export function LateWarning(props: { text: string }) {
  return (
    <span className="latewarn">
      <Icon name="warning" />
      {props.text}
    </span>
  );
}
