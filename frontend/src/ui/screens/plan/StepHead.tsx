// A step's heading. It takes focus as the step opens, and starts, for screen readers, with where the step is.

import type { ReactNode, Ref } from 'react';

export interface Head {
  ref: Ref<HTMLHeadingElement>;
  /** 'Step 3 of 5, Projects.' */
  where: string;
}

export function StepHead(props: { head: Head; children: ReactNode }) {
  return (
    <h2 ref={props.head.ref} tabIndex={-1}>
      {/* The space stays outside, where every screen reader keeps it. */}
      <span className="sr">{props.head.where}</span> {props.children}
    </h2>
  );
}
