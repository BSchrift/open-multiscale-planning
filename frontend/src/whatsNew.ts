// What's new in the iPhone app, newest first. Each iPhone shows the lines it hasn't seen once, the first time an update
// with them runs (docs/releasing.md, "What's new").
//
// A pull request that changes what someone can do on the iPhone adds its line at the top, with the next id. One plain
// sentence in the app's voice: sentence case, what the person can now do, no jargon, no pull request numbers. Ids are
// never reused or changed. core/whatsNew.test.ts checks the rules.

import type { WhatsNewEntry } from './core/whatsNew';

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  { id: 14, text: 'Swipe left or right on a day in Week to move to the next or previous day.' },
  { id: 8, text: "A practice's sessions now land on your calendar at its set times when those times are free." },
  { id: 7, text: "A practice's session and a planning block now open one popup, wherever you tap them." },
  { id: 6, text: "Add widgets to your Home Screen to see what's now and next, and to capture a task in a tap." },
  { id: 5, text: 'Every task opens one popup where you can mark it done, set dates, schedule it or start it.' },
  { id: 4, text: 'Start now stops the block that was running and asks how it went.' },
  { id: 3, text: "Find where a task belongs by searching for it in the task's popup." },
  { id: 2, text: "A task holds up to ten attachments, and if a photo can't upload, the app says why." },
  { id: 1, text: 'Hold on empty time in the calendar to give it a task you already have, or a new one.' },
];
