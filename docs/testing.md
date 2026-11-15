# Testing

What the end-to-end tests cover on each platform, and where each suite runs. [AGENTS.md](../AGENTS.md) has the test
layers and the commands; this page is the map of features to tests. **Update it in the same change as the tests:** a new
feature gets a row, and a test that covers a cell gets named in it.

## The suites

| Suite | Where | Platforms | Runs |
| --- | --- | --- | --- |
| Screens | `frontend/e2e/*.spec.ts` | Web desktop (Chromium, 1360 by 1000) and web phone (WebKit, iPhone 13) | `scripts/e2e.sh browser`, CI's e2e-browser, every PR and push to main |
| Journeys | `frontend/e2e/journeys/` | Web desktop, web phone and the Mac app | The browser's in e2e-browser; the Mac app's in e2e-electron (project `journeys`), every PR and push to main |
| Two devices on the local stack | `frontend/e2e/stack/` | Web desktop | `scripts/e2e.sh stack`, CI's e2e-stack, every PR and push to main |
| The Mac app's own | `frontend/electron/e2e/` | Mac app (Electron, real main process, preload and SQLite) | `scripts/e2e.sh electron`, CI's e2e-electron (project `mac`), every PR and push to main |
| The last release beside this one | `frontend/e2e/compat/` | Web desktop | `scripts/e2e.sh compat`, CI's e2e-compat, every PR and push to main |
| iPhone | `frontend/ios/App/UITests/` | iPhone Simulator | `make test-ios`, CI's ios, every PR and push to main |
| Against a deployment | `frontend/e2e/deployed/`, `frontend/e2e/stack/` | Web | `make test-deployed`, the release pipeline |
| History scale | `frontend/e2e/history/` | Web, Mac app, iPhone | `make test-history`, on demand and before releases |
| Performance KPIs | `frontend/e2e/perf/` | Web desktop, web phone and the Mac app | `make test-perf`, on demand, report-only against [config/perf.ts](../config/perf.ts); the browser's beside the base on each PR, in one comment (`perf.yml`) |

**One suite, several platforms.** A spec that imports `test` and `expect` from `frontend/e2e/platform.ts` runs on the
Mac app too when `frontend/electron/playwright.config.ts` runs it: `page` is then the window of a freshly launched app
on a data folder of its own, with the test's time zone and colour scheme. The journeys do this. A spec that seeds
records needs the dev build's seed hook, which the Mac app's production bundle doesn't have, so the seeded screen specs
run in the browser only; the journeys start from an empty first run, so they run on both. A journey added to
`frontend/e2e/journeys/` runs on the Mac app with no further change; open the app at `home` from `platform.ts` rather
than `/`.

## Feature matrix

Each cell is **covered**, **partly** (what's missing in brackets) or **missing**, with the spec and the start of the
test's title. "n/a" is a feature the platform doesn't have. Pick tasks is being rebuilt, so its tests come with the
rebuild. Offline and network interruption have their own suites and aren't listed here.

### Capture, Inbox and Process

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Capture from the button | covered (inbox: "captures to the Inbox from the button and the keyboard") | covered (same) | covered (journeys/capture-and-process; desktop: "closing the window keeps the edits not yet saved…") | covered (testCaptureFromThePlusButtonThenProcessToAProjectAndAOneOff) |
| Capture from the keyboard, in the app | covered (inbox: "captures to the Inbox…"; journeys/capture-and-process) | n/a | covered (journeys/capture-and-process) | n/a |
| Capture from anywhere: global shortcut, Control Center, share sheet | n/a | n/a | covered (desktop: "the shortcut opens a one-field window that saves to the Inbox…", "a save that fails keeps the text and says so") | covered (testControlCenterWidgetOpensCapture, testShareExtensionQueuesForTheApp, testShareImportIsOffWithoutTheExtensions, testCaptureSitsAboveTheKeyboard…) |
| Capture's Add details: time, and a place that skips the Inbox | covered (details: "Capture's Add details opens with Time first…"; process: "Add details sends a task with its time straight to One offs…") | covered (same) | missing (seeded specs run in the browser only) | missing |
| Capture: Esc and Cancel drop the text; a click outside keeps it | covered (process: "Esc and Cancel drop what was typed…") | partly (Esc only; a tap on the backdrop untested) | missing | missing |
| Inbox: count, rows, rename, popup | covered (inbox: "shows the Inbox's count in a circle", "an Inbox row opens its popup…"; details: "an Inbox item opens in its popup…") | covered (same) | partly (journeys/capture-and-process: rows and popup) | missing |
| Inbox: select mode for many at once | covered (inbox: "select mode adds, deletes and makes one offs of many items at once") | covered (same) | missing | missing |
| Process: to a project, from the picker or Add to its last place | covered (inbox: "processes the Inbox one card at a time…") | covered (same) | covered (journeys/capture-and-process, journeys/first-week) | covered (testCaptureFromThePlusButtonThenProcessToAProjectAndAOneOff) |
| Process: One offs | covered (inbox: "processes the Inbox one card at a time…"; process) | covered (same) | covered (journeys/capture-and-process) | covered (same test) |
| Process: a new project, practice or goal from the picker or a card | covered (inbox: "a new project from the picker…", "makes a project under a new goal, a practice and a goal from cards…") | covered (same) | covered (journeys/capture-and-process: a practice from its card) | missing |
| Process: Add to this week, off again on each card, and where the work lands | covered (process: "Add to this week is off again on each new card…"; weekly-planning: Inbox step) | covered (same) | covered (journeys/first-week, journeys/next-stretch) | missing |
| Process: the Time slider, per card | covered (process: "the Time slider saves the estimate as it moves…") | covered (same) | missing | missing |
| Process: Skip | covered (process: "Skip keeps an item for later…") | covered (same) | missing | missing |
| Process: Delete, asked first | covered (inbox: "processes the Inbox one card at a time…"; process: "Skip keeps an item for later, Delete's Cancel keeps it too…") | covered (same) | covered (journeys/capture-and-process: the bin) | missing |
| Process: Undo and go back, several steps | covered (process: "Undo steps back over each card in turn…") | covered (same) | missing | missing |
| Process: Esc exits and reopening continues | covered (process: "Skip keeps an item for later… leaving part way, Process starts again on what's left") | covered (same, by Exit) | missing | missing |
| Process: keys, with Option or alone | covered (inbox: "keyboard shortcuts on the desktop card…"; process: "desktop: W, E and G do what their buttons do…") | n/a | missing | n/a |
| Process: edit the item on its card (title, description, link, date) | covered (inbox: "edits the item on the card…", "a date set on the card goes with the item to a project…") | covered (same) | missing | missing |

### Settings and first run

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| First-run setup: sign-in skipped, unavailable hours, a first goal or thought | covered (settings: "first run: skips sign-in…"; setup: "first run counts its steps and Back returns to each…", "first run picks up at the step it was on after a reload"; shell) | covered (same) | covered (desktop: "launches to first-run setup…"; every journey's first run) | covered (testFirstRunSetupThenItRemembersAfterARestart) |
| First run's Calendar step | missing (needs a sign-in) | missing | missing | missing |
| The sections, in order; Source code link | covered (settings-sections: "the browser's Settings has each section in order…") | covered (same) | missing | missing |
| Account | partly (signed out, in settings: "edits settings in place"; signed in is "Sign-in and sync" below) | partly (same) | covered (sync: sign-in and restart) | covered (testSignInFromSettingsThenWorkMadeHereReachesTheServer) |
| Available hours and the weekly one offs aim | covered (settings: "edits settings in place"; settings-sections: "the weekly one offs aim moves up from No aim…") | covered (same) | missing | missing |
| Planning cadence | covered (settings: "edits settings in place"; plan; stretch) | covered (same) | missing | missing |
| Google Calendar | see "Google Calendar" below | | | |
| Away dates: add, remove with Undo, a bad range refused | covered (settings: "edits settings in place"; settings-sections: "Away dates: an end before the start is refused…") | covered (same) | missing | missing |
| Away dates' effect: reminders muted, pace and reliability exclude them | missing (component tests only: settings.test.tsx, today.test.tsx) | missing (same) | missing | missing |
| Reminders: each toggle and the check-in delay | covered (settings: "edits settings in place"; settings-sections: "Reminders: Notify at block start, Ask at block end and the planning reminder…") | covered (same) | missing | missing |
| Appearance | covered (settings: "appearance follows the system live until chosen…") | covered (same) | covered (desktop: "Appearance in Settings sets the native theme and the window background…") | missing |
| Keyboard: single-key shortcuts in Process | covered (settings-sections: "desktop: Keyboard turns single-key shortcuts on…"; inbox: "keyboard shortcuts on the desktop card…") | n/a | missing | n/a |
| Capture shortcut | n/a (apps only) | n/a | covered (desktop: "a new capture shortcut from Settings replaces the old one…") | n/a |
| Updates | n/a (apps only) | n/a | partly (unit tests only; the section shows only in builds with a release feed) | partly (unit tests only) |
| Data retention | covered (settings: "Data retention says what's kept and for how long…") | covered (same) | missing | missing |

### Stretch planning (Plan)

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Start: how often to plan, on first planning | covered (stretch: "with no cadence, Start planning asks how often first…") | covered (same) | missing | missing |
| Goals step | covered (plan: "a goal's projects are blocks that open a preview…", "Goals asks for some when there are none…", "Add makes a goal from any step…"; journeys/next-stretch) | covered (same) | covered (journeys/next-stretch) | missing |
| Practices step | covered (journeys/next-stretch) | covered (same) | covered (journeys/next-stretch) | missing |
| Projects step: milestones in the plan by name and dragging, typed dates, Done | covered (plan: "plans the next stretch: a milestone in by name and by dragging…", "types a date for a milestone…"; journeys/next-stretch) | covered (same) | covered (journeys/next-stretch) | missing |
| Inbox step | covered (plan: "Goals asks for some… with Process over an inert flow", "an empty Inbox says so…") | covered (same) | covered (journeys/next-stretch) | missing |
| Finish: fit, aims, steps not looked at, Undo | covered (plan: "plans the next stretch…"; stretch: "the step arrows move between steps, and Finish names the steps not looked at…", "planned without a cadence… its toast's Undo takes the plan back", "Finish and plan the week…") | covered (same) | covered (journeys/next-stretch) | missing |
| Cadence changed in place, now or when this plan ends, or turned off | covered (plan: "…changes cadence in place…"; stretch: "a new cadence can end this plan now…", "turning the schedule off…") | covered (same) | missing | missing |
| Save and exit, then resume | covered (plan: "…resumes planning where it was, with Undo still there"; stretch: "a first plan begun on another device continues at its step, and from Finish, Save and exit leaves it for later"; stack/stretch: across devices) | covered (plan, stretch) | covered (journeys/planning-task) | missing |
| Edit goals (the UI has Open project in Goals, which saves planning) | covered (plan: "a goal's projects are blocks… the project itself after saving planning") | covered (same) | missing | missing |
| Never planned: this stretch from today | covered (plan: "never planned, plans this stretch from today…") | covered (same) | covered (journeys/next-stretch) | missing |

### Weekly planning

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| The prompt to plan, Skip for now, the banner | covered (today: "an unplanned week opens on the prompt to plan…"; journeys/planning-task) | covered (same) | covered (journeys/planning-task) | missing |
| Planning as a task, saved three days before the week | covered (journeys/planning-task; stack/planning: across devices) | covered (journeys/planning-task) | covered (journeys/planning-task) | missing |
| Inbox step | covered (planning: "plans a week: Inbox, pick with Does it fit…"; weekly-planning: "the Inbox step processes into the plan for the week being planned…") | covered (same) | covered (journeys/first-week) | missing |
| Pick tasks | owned by the Pick rebuild (planning: "plans a week…", "adds a task while picking…", "dragging an estimate in Pick…" cover today's) | owned by the Pick rebuild | covered (journeys/first-week, today's Pick) | missing |
| Schedule: drag, place, place the rest, Undo | covered (schedule: "desktop: drag the task to a time…", "…Place here takes it off to place again", "…Place the rest puts each session at its own day's time…"; planning-place) | covered (schedule: "phone: compare days, move the task to another day…", "phone: the draft floats beside a placed block…"; planning-place) | covered (journeys/first-week, journeys/answered-weeks) | missing |
| Schedule: a moved practice session asks about future weeks | covered (schedule: "desktop: moving a practice session asks…"; weekly-planning: "desktop: Yes on Schedule's practice question…") | missing (the phone's question sheet; touch dragging) | missing | missing |
| Schedule: skip a practice this week, and include it again | covered (weekly-planning: "Skip a practice this week takes its sessions out…") | covered (same) | missing | missing |
| Review: aims not reached, finish, Undo | covered (planning: "plans a week…"; weekly-planning: "Review names each aim not reached…") | covered (same) | covered (journeys/first-week) | missing |
| Step navigation: tabs and arrows | covered (planning: "week arrows have no limit…"; weekly-planning: "the step arrows and tabs move between the steps…") | covered (same) | missing | missing |

### Today

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Now card: Start, the countdown, Mark done now, Undo | covered (today: "the Now card: Start counts down, Mark done now frees the time…") | covered (same) | partly (journeys/first-week: the day's blocks, no Start) | missing |
| Mark done now with nothing after; Start early in the freed time | covered (today-prompts: "Mark done now with nothing after says the time spent…", "free time before the next block offers Start early…") | covered (same) | missing | missing |
| Do next block instead; Still going | covered (today-prompts: "Do next block instead trades the work…", "Still going adds half an hour…") | covered (same) | missing | missing |
| The time-spent ring: pause and resume, P on desktop | covered (today: "the time-spent ring pauses and resumes…", "on desktop, P pauses and resumes…", "the ring changes without animating under reduced motion…", "a pause running to the end asks the end question…") | covered (same, P aside) | missing | missing |
| Start check-in: has it started? | covered (today-prompts: "a block not started a few minutes in asks whether it has…"; journeys/first-week) | covered (same) | covered (journeys/first-week) | covered (testTodayAsksHowAFinishedBlockWentThenWhetherTheCurrentOneHasStarted) |
| How it went: Done, Partly, Not done, Answer later | covered (today: "a finished block asks how it went; Partly sets the time left…"; today-prompts: "a finished block put off with Answer later… Not done…"; journeys/answered-weeks) | covered (same) | covered (journeys/first-week, journeys/answered-weeks) | covered (same test) |
| A practice session's log: how much was done | covered (today-prompts: "a practice session that ended asks how much was done…") | covered (same) | missing | missing |
| Skip, choose a new time later: to To schedule | covered (today-prompts: "Skip, choose a new time later takes the block off the calendar…") | covered (same) | missing | missing |
| Missed blocks, answered together | covered (missed: "on desktop, a small dialog in the middle…", "turns off the slide with reduced motion") | covered (missed: "on phone, a sheet from the bottom…") | missing | missing |
| Needs a new time: best time in one tap, delete, Still want this? | covered (today-waiting: "Needs a new time places a row at its best time in one tap…"; journeys/first-week) | covered (same) | covered (journeys/first-week) | missing |
| After a week away: Welcome back, Pick one thing for today | covered (today-waiting: "after a week away Today opens on Welcome back…") | covered (same) | missing | missing |
| Timeline calendar: drag a block, arrow keys, Undo | covered (today: "a block still to come drags to a new time, held first on phone; arrow keys move it on…") | covered (same, held first) | missing | missing |
| Timeline: resize from the bottom edge, Shift and arrows | covered (today-timeline: "a block still to come changes its length from its bottom edge…", "on desktop, Shift and the arrow keys change a block's length…", "the block under way keeps its start and changes only its end…") | covered (same, by the grip) | missing | missing |
| Timeline: a click or tap opens the block's task | covered (today: "a click or tap on a block opens its task…"; details: "the Now card, a To schedule card and a block on Today open the popup") | covered (same) | missing | missing |
| List view, kept after a reload | covered (today-timeline: "the timeline switches to a list of the day in order…") | covered (same) | missing | missing |
| Zoom | covered (today-timeline: "zoom draws the calendar taller a step at a time and back…") | partly (the buttons; a pinch needs the Simulator) | missing | missing |
| The planning block's Now card: Keep going, Free this time | partly (journeys/planning-task: Keep going on the planning row; stack/planning: the Now card's; Free this time untested) | partly (same) | partly (journeys/planning-task) | missing |
| To schedule above the day, dragged onto it | covered (today: "to schedule sits just above the day, and a card dragged onto it is placed there…", "a practice on set days waits in To schedule on its own days only…") | covered (same, held first) | missing | covered (testAToScheduleCardHeldThenDraggedOntoTheDayIsPlacedOnToday) |
| A clash with the calendar shifts the rest of today | covered (today: "a clash with the calendar shifts the rest of today") | covered (same) | missing | missing |
| One offs on Today: tick, Change date, Find a time | covered (today-waiting: "a one off dated today offers Change date… and Find a time…"; journeys/capture-and-process: tick) | covered (same) | covered (journeys/capture-and-process: tick) | missing |
| Short blocks keep 44pt targets on phone | n/a | covered (today: "on phone, a short block on the calendar still has a 44pt tap target", "on phone, a block's resize grip stays under the block right below it…") | n/a | missing |

### Week

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| The grid: drag a block to another day and time, remove with Undo | covered (week: "desktop: drag a block to another day and time, then remove it with Undo") | partly (the phone day moves a block from its sheet; a held drag of a placed block is untested) | covered (sync: "dragging and resizing a block on the Week grid moves it on the other device…") | n/a |
| The grid: a block's length from its edge, Shift and arrows | covered (week-blocks: "desktop: while editing, a block's bottom edge snaps its length…") | n/a | covered (sync: same test) | n/a |
| The block's details beside the week | covered (week-blocks: "desktop: a block clicked on the grid shows its details beside the week…") | n/a | missing | n/a |
| Phone: the day strip, a block's sheet, Move to another day, Length, Remove | n/a | covered (week: "phone: the day strip, a block sheet, and Move to another day", "phone: a day with no slot stays readable"; week-blocks: "phone: a block's sheet changes its length on a slider…") | n/a | partly (testFirstSyncOfTheFiveYearHistoryThenTodayAndWeek: it draws) |
| To schedule above the week: a suggestion places it, Undo, drag both ways | covered (week: "to schedule: picked work waits above the week…", "a set-day practice waits above its own days…") | covered (same; week: "phone: a card held, then dragged down onto the day…") | missing | missing |
| Add a task at its suggested time; Edit this week's plan | covered (week: "desktop: add a task at its suggested time") | covered (week: "phone: Edit this week's plan and add a task from the drawer") | missing | missing |
| Week arrows and This week | covered (week: "week arrows reach any week and This week comes back") | covered (same) | partly (journeys/answered-weeks) | missing |
| Past weeks: read only, linked to their analytics | covered (week-blocks: "a past week can be read but not changed…") | covered (same) | missing | missing |
| Day headings open Done on that day | covered (done: "Week's day headings open Done on that day…") | covered (same) | missing | missing |

### Goals, projects, milestones and practices

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Goals: add, rename, delete after a warning with Undo | covered (goals: "renames a goal from the pen in its title, and deletes it after a warning, with Undo"; journeys/first-week) | covered (same) | covered (journeys: first-run goals, journeys/next-stretch adds one) | missing |
| Still a goal?: not now, archive and restore, add work | covered (still-a-goal: "Yes, not now quiets the question…", "No, archive it moves the goal to Archived…", "adding work answers the question…") | covered (same) | partly (journeys/project-lifecycle: Archived restores a project) | missing |
| Projects: add, settings dialog, finish and drop after asking, restore | covered (goals: "adds a goal and a project, finishes it after asking…", "Project settings open in a dialog…"; journeys/project-lifecycle) | covered (same) | covered (journeys/project-lifecycle) | missing |
| A project's tasks: add and edit; the overdue question for the project | covered (goals: "answers the overdue question and adds and edits tasks on a project") | covered (same) | covered (journeys/first-week, journeys/project-lifecycle) | missing |
| Milestones: add, rename and re-date with a status preview | covered (milestones: "a milestone's popover renames and re-dates it…"; journeys/first-week) | covered (same) | covered (journeys/first-week adds them) | missing |
| Milestones: Mark met, Not met, Drop, with Undo | covered (milestones: "Mark met and Not met are in the popover…", "Drop milestone keeps done tasks…") | covered (same) | missing | missing |
| An overdue milestone's question: Move date, Drop, Mark done | covered (milestones: "the overdue question's Drop milestone and Mark done each answer it with Undo…"; journeys/project-lifecycle) | covered (same) | covered (journeys/project-lifecycle: Move date with Undo) | missing |
| A task moved to another milestone, by popup or by holding it | covered (milestones: "a task's popup moves it to another milestone with Undo…") | covered (same, held on phone) | missing | missing |
| Practices: add and edit, link to a goal | covered (goals: "edits a practice with no goal and links it to one"; journeys/capture-and-process) | covered (same) | covered (journeys/capture-and-process, journeys/next-stretch) | missing |
| Practice schedules: set days with their own times, times a week | covered (goals: "builds Mon, Tue and Fri with Friday at 9:30…"; practices: "Times a week with a longer session…"; stack/sync: two devices) | covered (same) | missing | covered (testAPracticeOnMondayTuesdayAndFridaySavesWithUndo) |
| Practices: Pause, Resume, End practice | covered (practices: "Pause marks a practice Paused until Resume, and End practice…") | covered (same) | missing | missing |

### One offs

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Add each kind; dates in place: none, a date, a range | covered (oneoffs: "adds one offs of each kind, and dates one in place"; oneoffs-repeats: "adds one offs over a date range…", "changes a one off's date in place to a range and clears it…", "the add form says what it is missing…") | covered (same) | covered (journeys/capture-and-process) | missing |
| Repeats by kind: weekly days, monthly, after last done, within a window, seasonal, calendar rules, daily, yearly | partly (oneoffs: "repeats weekly on chosen days…", "adds one offs of each kind…" for seasonal and calendar rules; oneoffs-repeats: "…monthly, a set time after last done and within a window, and a tick moves each by its own rule"; daily and yearly untested) | partly (same) | partly (journeys/capture-and-process: the Repeating group) | missing |
| Tick until the day changes, untick | covered (oneoffs: "lists, ticks until the day changes, and shows what was finished") | covered (same) | covered (journeys/capture-and-process) | missing |
| Finished tasks: month groups, more, search, untick | covered (finished-tasks: "lists the newest ten finishes in month groups…", "unticking a finish reopens a one off…") | covered (same) | covered (journeys/capture-and-process) | missing |

### The task popup

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Opens from anywhere a task is named, edits everything, Undo | covered (details: "a task opens in its popup from its project…", "the Now card, a To schedule card and a block on Today open the popup", "the body scrolls once the popup reaches 70%…") | covered (same) | covered (journeys/first-week; desktop: "closing the window keeps the edits not yet saved…") | partly (testATaskOpensWithTheKeyboardDown…) |
| Cancel, Esc, the close button and a tap outside with unsaved changes | covered (popup: "Cancel drops the popup's changes, and Esc, the close button or a tap outside keep them until Save") | covered (same) | partly (desktop: closing the window keeps them; quitting drops them, reported) | missing |
| Delete task, with its block, Undo | covered (popup: "Delete task takes the task and its block off Today…") | covered (same) | missing | missing |
| Notes: the formatting bar, links open outside, the limit | covered (notes: "writes a description with the bar…", "stops a description at the limit…") | covered (same) | missing | covered (testATaskOpensWithTheKeyboardDownThenItsDescriptionTakesBoldFromTheBar…) |
| Attachments: links | covered (attachments: "a task's links: added, opened outside the app, and removed with Undo") | covered (same) | missing | missing |
| Attachments: photos, synced and opened on another device | covered (stack/attachments: "a link and a photo added on one device reach another…") | missing (the stack layer runs desktop only) | missing | missing |

### Done and Analytics

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Done: from Today's line, mark a block finished, Undo | covered (done: "from Today's line to Done…") | covered (same) | partly (journeys/answered-weeks opens Done) | missing |
| Done: totals by kind, names open their popup, an empty day, midnight | covered (done-day: "the totals split time worked by kind…", "a day with nothing finished says so…") | covered (same) | missing | missing |
| Analytics: a week, moving between weeks, acting on a pattern | covered (analytics: "reads a week, moves between weeks, and acts on a pattern"; journeys/answered-weeks) | covered (same) | covered (journeys/answered-weeks) | missing |
| Analytics: Raise estimates, Undo | covered (analytics-estimates: "Raise estimates lengthens a project's open tasks…") | covered (same) | missing | missing |

### Sign-in and sync

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Sign in through the browser or system browser, and back | covered (stack/sync: "two devices sign in, sync…") | partly (desktop layout only; sign-in itself is the same page) | covered (sync: "what one device enters reaches the other…"; desktop: "a sign-in return reaches the page…") | covered (testSignInLinkReturnsThroughTheURLScheme…, testSignInFromSettingsThenWorkMadeHereReachesTheServer) |
| Two devices sync edits and deletes | covered (stack/sync: "two devices sign in, sync, merge edits…") | missing (the stack layer runs desktop only) | covered (sync: "what one device enters reaches the other…", "dragging and resizing a block on the Week grid moves it on the other device…") | partly (testSignInFromSettingsThenWorkMadeHereReachesTheServer: one way) |
| Expired sign-in, and signing in as another account | covered (stack/sync: "an expired sign-in shows in Settings…", "signing in as another account asks first…") | missing (desktop only) | partly (sync: "…a restart keeps data and sign-in") | missing |
| Sign-in tokens kept safely | n/a | n/a | covered (desktop: "tokens are stored encrypted and survive a restart") | covered (testTokensRoundTripThroughTheKeychain) |
| Attachments' photos sync and open on another device | covered (stack/attachments: "a link and a photo added on one device reach another…") | missing (desktop only) | missing (the file picker is the browser's; not run on the Mac app) | missing |

### Google Calendar

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Connect, Refresh, a blocking calendar's events in hours and Week, Ignore, Disconnect | covered (stack/calendar: "connecting Google Calendar reads its calendars, whose events take time from planning until ignored…"; settings-sections: "Google Calendar, signed out: Connect asks for a sign-in…") | partly (settings: "edits settings in place" sets modes on seeded calendars) | missing (the same page; Connect opens the system browser) | missing |
| Calendar modes and busy time with seeded calendars | covered (settings: "edits settings in place") | covered (settings: "edits settings in place") | missing | missing |
| A clash with the calendar shifts the rest of today | covered (today: "a clash with the calendar shifts the rest of today") | covered (same) | missing | missing |
| Blocks mirrored to Google, edits there overwritten, errors | n/a: server side, in backend/integration/calendar_test.go and backend/cmd/local/calendar_test.go | | | |

### Reminders and notifications

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| A block's reminder fires and its action reaches the app | n/a (the browser build has no notifications) | n/a | covered (desktop: "a reminder fires from the main process, and its action reaches the page") | covered (testABlocksNotificationActionAnswersItInToday, testNotificationPermissionThenCancelThenActionReachesTheApp) |
| A reminder's Not done writes what the in-app prompt writes | n/a | n/a | covered (sync: "a reminder for a block near now is scheduled, and its Not done…") | partly (testABlocksNotificationActionAnswersItInToday) |
| A reminder clicked, not a button, opens the app | n/a | n/a | covered (desktop: "a reminder clicked, not one of its buttons…") | missing |
| Which reminders are on (Settings) | covered (settings: "edits settings in place"; settings-sections: "Reminders: Notify at block start, Ask at block end and the planning reminder…") | covered (same) | missing | missing |

### The Mac app's own

| Feature | Mac app |
| --- | --- |
| Launch, first-run setup, the page kept from Node | covered (desktop: "launches to first-run setup with the page isolated from Node") |
| Data survives a restart | covered (desktop: "data survives a restart") |
| Global capture shortcut and its window | covered (desktop: "the shortcut opens a one-field window that saves to the Inbox…", "a save that fails keeps the text and says so") |
| Changing the capture shortcut in Settings | covered (desktop: "a new capture shortcut from Settings replaces the old one…") |
| Tray: closing keeps the app running; its menu's Open, Capture and Quit | covered (desktop: "closing the window keeps the app running in the tray…", "a new capture shortcut from Settings…") |
| App menu (Electron's default; Edit roles for fields) | covered (desktop: "the app menu has Edit's undo, cut, copy, paste and select all…") |
| Window state (size and position kept) | n/a: not kept, every launch opens at 1360 by 900 |
| Closing the window with unsaved edits in a task | covered (desktop: "closing the window keeps the edits not yet saved…") |
| Quitting with unsaved edits in a task | missing: they're dropped without asking (reported) |
| Deep links, sign-in return through the system browser | covered (desktop: "a sign-in return reaches the page, a foreign link does not…"; sync: sign-in) |
| Appearance sets the native theme | covered (desktop: "Appearance in Settings sets the native theme…") |
| A page reload mid-transaction | covered (desktop: "a page reloading mid-transaction leaves no open transaction behind") |
| Over-the-air updates and the Updates prompt | partly: unit tests (electron/updates.test.ts, src/core/updates.test.ts); the prompt only shows in builds with a release feed |
| Attachments' file picker | missing: photos need sign-in and the stack; the Mac's picker is Chromium's, as the browser's |

### Undo everywhere

Every change can be undone, usually from the toast that reports it. Where each area's Undo is tested:

| Area | Web desktop and phone | Mac app | iPhone |
| --- | --- | --- | --- |
| Process | process: "Undo steps back over each card in turn…"; inbox: "edits the item on the card… Undo puts it back as it arrived" | missing | missing |
| Today | today: Now card, ring, drag; today-prompts: Do next block instead, Mark done now, Skip; today-timeline: resize; today-waiting: Change date, Needs a new time | journeys/first-week | missing |
| Week | week: remove, To schedule; week-blocks: Remove on phone | missing | missing |
| Weekly and stretch planning | schedule: place the rest; planning: a task added while picking; plan: "Add makes a goal…"; stretch and weekly-planning: Finish | journeys/planning-task, journeys/project-lifecycle | missing |
| Goals, milestones, practices | goals: delete a goal; milestones: every change; practices: End practice; still-a-goal: not now, Restore | journeys/project-lifecycle | covered (testAPracticeOnMondayTuesdayAndFridaySavesWithUndo) |
| One offs | oneoffs-repeats: dates in place, Change repeat's delete | missing | missing |
| The task popup | details: Save; popup: Delete task; attachments: link removed | missing | missing |
| Done and Analytics | done: marked finished; analytics: a pattern; analytics-estimates: Raise estimates | missing | missing |
| Settings | settings-sections: away dates removed | missing | missing |

Not every change has one yet: Start early and Still going on the Now card change a block's times with no Undo.

### Data and the shell

| Feature | Web desktop | Web phone | Mac app | iPhone |
| --- | --- | --- | --- | --- |
| Starts at setup on an empty database, then shows the shell | covered (shell: "starts at setup on an empty database…") | covered (same) | covered (desktop: "launches to first-run setup…") | covered (testFirstRunSetupThenItRemembersAfterARestart) |
| Edits saved at once and kept across a reload or restart | covered (storage: "an edit survives a reload straight after it", "edits save straight away with a few thousand records") | covered (same) | covered (desktop: "data survives a restart", "a page reloading mid-transaction…") | covered (testDatabaseThroughThePlugin, testFirstRunSetupThenItRemembersAfterARestart) |
| Where the data lives: OPFS, IndexedDB, SQLite | covered (storage: "opens the IndexedDB file a bundle from before OPFS kept…", "without OPFS, keeps the database in IndexedDB as before") | covered (same) | covered (the Electron runtime tests, `npm run test:electron-runtime`) | covered (testQueryPlansOnThePluginsSQLite) |
| One tab at a time | covered (web: "one tab at a time…") | covered (same) | n/a | n/a |
| The last release's bundle beside this one, on the same data | covered (compat) | missing | missing | missing |
| Every screen of a lived-in week renders, and the links between areas | covered (tour: "every screen of a lived-in week renders cleanly", "the planning flows of a lived-in week render cleanly", "the links between areas reach their page and come back") | covered (same) | missing | missing |
| A five-year history: first sync, Today and Week within budget | covered (history/web, on demand) | missing | covered (history/mac, on demand) | covered (testFirstSyncOfTheFiveYearHistoryThenTodayAndWeek, on demand) |

## Not covered yet, and why

- **The iPhone column** is what's on main. PR #178 adds an iPhone test for each main path (Goals, Inbox and Process, planning, reminders, Today, Week, Done, Analytics, Settings); update the column when it lands.
- **Seeded screens on the Mac app.** The Mac app runs the journeys, not the seeded screen specs, since its production bundle has no seed hook. Its rows say "missing" where no journey or Mac spec reaches the feature. A journey that adds a feature to the Mac column is the cheapest way to fill one.
- **Phone in the stack layer.** Two-device sync, photos and Google Calendar run at desktop size only; the phone's screens for them are the same components.
- **Quitting the Mac app with unsaved edits in a task** drops them without asking. Whether to ask, save or keep a draft is a product decision.
- **Over-the-air updates and the Updates prompt** only appear in builds with a release feed, which the local layer doesn't have. `electron/updates.test.ts` and `src/core/updates.test.ts` cover the logic.
- **Away dates' effect** (reminders muted, pace and reliability leaving them out) has component tests (`settings.test.tsx`, `today.test.tsx`) but no end-to-end test.
- **First run's Calendar step** needs a sign-in, so it's for the stack layer.
- **The phone's "future weeks" question** after moving a practice session in Schedule needs a touch drag of a session.
- **Daily and yearly one offs** aren't added by any test; they take the same form path as monthly.
- **The planning block's Free this time**, on Today's Now card, has no test at any layer.
- **Offline and network interruption** have their own suites (browser, stack, Mac app, iPhone).

## Where each suite runs in CI, and what it costs

Everything in the local layer runs on every PR and every push to main, one job per part of `scripts/e2e.sh`. The Mac app's journeys run inside e2e-electron: that job went from about 2 min 10 s to about 3 min 25 s on Linux (Playwright's own time from 1.3 to 2.3 min, for 23 tests instead of 13). It still ends long before e2e-browser (about 9 to 13 min) and ios (about 40 min), so it adds no time to a PR's checks. If e2e-browser grows past ios, split it by project (desktop and phone) into two jobs rather than moving tests off PRs.
