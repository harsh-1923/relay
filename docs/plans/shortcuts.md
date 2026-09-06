# Shortcuts — commands, bindings, and the registry between them

> Working plan. `ARCHITECTURE.md` says nothing about keyboard input, so this document carries
> the decisions as well as the breakdown, each with its reasoning so it can be re-argued if
> circumstances change, not re-litigated by default. _Candidates for ARCHITECTURE.md_ at the
> bottom lists what belongs upstream when that file is next edited in its own turn.

**Done when:** adding a shortcut is one declaration next to the thing it acts on; every
shortcut appears in a help sheet and a command palette without being listed twice; two
features cannot silently claim the same chord; and a shortcut that should not fire — in a
dialog, in a text field, in a webview panel — does not.

**Scope:** the command layer, the chord binding layer, conflict handling, and the two surfaces
that read the registry (help sheet, palette). **Sequences are deferred** — the survey below
records why, and the command layer is built so adding them later costs one field. Also out:
the palette's visual design, user-remappable keys, Electron menu accelerators.

## Where things stand

There is no shortcut system. There are two hand-rolled listeners, and they collide.

| Binding | Where                                          | State                                                                                                                                      |
| ------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Mod+B` | `apps/client/src/main.tsx:252`                 | Toggles the resizable sidebar panel. Works                                                                                                 |
| `Mod+B` | `apps/client/src/components/ui/sidebar.tsx:95` | Vendored shadcn. Toggles a `SidebarProvider` whose `open` we pin, so it does nothing — but it still runs, and still calls `preventDefault` |

Two handlers, one chord, no way to notice. That is the bug this plan exists to make
structurally impossible, and it arrived in under a week of UI work.

| #   | Step                                               | State       |
| --- | -------------------------------------------------- | ----------- |
| 1   | `@tanstack/react-hotkeys`, provider, `Mod+B` moved | ✅          |
| 2   | The command store and `useCommand`                 | ✅          |
| 3   | `when` contexts                                    | ✅          |
| 4   | Help sheet (`Mod+/`) off the registry              | ✅          |
| 5   | Chord commands — tabs, navigation                  | ✅          |
| 6   | Command palette (`Mod+K`)                          | ✅          |
| 7   | Webview panel escape hatch                         | ⬜ Phase 10 |

Built as `apps/client/src/lib/commands.ts` (the store and `useCommand`),
`lib/app-commands.ts` (the shell's set), `components/shortcuts-sheet.tsx` and
`components/command-palette.tsx`. Two deviations from this plan, both recorded below: the
`available` field (D5) and `Mod+/` rather than `?` (Questions).

## What the library already gives us

Verified against the installed types (`@tanstack/react-hotkeys@0.10.0`, core
`@tanstack/hotkeys@0.8.0`, MIT), not the docs — the docs are thin on exactly the parts a
registry needs.

```ts
useHotkey(hotkey, callback, options);

interface HotkeyOptions {
  conflictBehavior?: 'warn' | 'error' | 'replace' | 'allow'; // defaults to 'warn'
  enabled?: boolean; // soft-disable: registration stays visible, callback stops
  eventType?: 'keydown' | 'keyup';
  ignoreInputs?: boolean; // smart default: true for bare keys, false for Ctrl/Meta and Escape
  platform?: 'mac' | 'windows' | 'linux';
  preventDefault?: boolean; // default true
  requireReset?: boolean;
  stopPropagation?: boolean; // default true
  target?: HTMLElement | Document | Window | null;
  meta?: HotkeyMeta; // extensible by declaration merging
}
```

Three of these change the shape of this plan:

- **`conflictBehavior` already exists**, and already defaults to warning. We do not have to
  build conflict detection, only decide the policy (D4).
- **`meta` is extensible by declaration merging.** That is the hook a registry hangs on: we
  add our own fields to `HotkeyMeta` and every registration carries them, with no parallel
  data structure to keep in sync.
- **`ignoreInputs` is already smart** — bare keys and Shift/Alt combos ignore text inputs,
  Ctrl/Meta combos and Escape do not. This is the single most common source of hand-rolled
  hotkey bugs and it is handled — including in a contenteditable composer, which D6 checks
  in the source rather than taking on trust.

### Sequences, and why they are not in this plan

Sequences were going to be first-class. A survey of the alternatives changed that, and the
reason is worth recording because it is not "we ran out of time".

| Library                          | Weekly | Sequences        | Chord shadows a sequence prefix                             | Text fields                                                     | Registry / enumeration                                               | Conflict detection                  |
| -------------------------------- | ------ | ---------------- | ----------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| `react-hotkeys-hook` 5.3.3       | 4.4M   | yes, `g>i`       | **no** — each hook adds its own listener and its own buffer | `enableOnContentEditable`                                       | `useHotkeysContext().hotkeys`, with `description` and `metadata`     | **none at all**                     |
| `tinykeys` 4.0.0                 | 311k   | yes, `g i`       | **yes — solved by design**                                  | default ignore covers `[contenteditable],input,select,textarea` | none; it is a matcher, not a registry                                | only the sequence-shadowing warning |
| `@tanstack/react-hotkeys` 0.10.0 | 642k   | yes, `['G','I']` | **no** — chords and sequences are two independent managers  | `isContentEditable`, and inputs by type                         | best of the four: registration views, `meta`, live sequence progress | yes, within a manager               |
| `kbar` 1.0.0                     | 315k   | yes              | worked around, not solved                                   | via tinykeys                                                    | actions registry, but wedded to its own palette UI                   | none                                |

`mousetrap` is excluded: last published February 2025 and effectively parked.

**The finding that matters.** Only `tinykeys` solves the shadowing problem, and it solves it
because it is one handler over one map — it can see that `G` completes while `G I` is still
pending, so it suppresses the chord and warns:

```js
} else if (rest.length > 0) {
  pending.set(input, rest); conflicts.push(input);        // still mid-sequence
} else {
  if (conflicts.length) console.warn(`tinykeys: Conflict found, "${input}" did not fire, waiting for:`, conflicts);
  else { handler(event); break; }
}
```

Any library that registers per-hook — `react-hotkeys-hook` and TanStack both — _structurally
cannot_ do this, because independent listeners cannot know about each other. This is not a
maturity gap that a release will close; it follows from the registration model.

**It is a real bug, not a hypothetical.** `kbar` hit it independently (tinykeys issue #37) and
carries a workaround for it: a `WeakSet` of already-handled events plus registering shortcuts
sorted longest-first, so `['t','s']` wins over `['s']`.

**So: chords now, sequences later.** Nothing here is unsolvable — the check is a few lines
against the two registration views — but it is design surface the product does not need yet,
and D1 makes it cheap to add: a command is addressable by id, so gaining a sequence later is a
field on its declaration, not a change to its implementation. If sequences do become
important, the honest move is to swap the _binding layer_ underneath `useCommand` for
tinykeys' matcher and keep every call site — which is exactly what the command layer is for.

The hazard is recorded at the bottom so that whoever picks this up does not rediscover it.

## Decisions

### D1 — Commands are the unit. Keys are one way to trigger one

This is the whole design, and everything else follows from it.

A command is a named, invocable action: `tabs.close`, `sidebar.toggle`,
`workspace.switchNext`. A binding maps a chord to a command id. They are separate because a
command has more than one caller:

```
Mod+W ─┐
menu   ├─→  tabs.close  ─→  the one implementation
palette┘
```

This is VS Code's model — a command registry plus a keybinding table with `when` clauses —
and Linear's, Superhuman's, and Notion's. Their common shape is not a coincidence: the moment
you want a command palette, a help sheet, or remappable keys, you need commands to exist as
addressable things rather than as closures inside a `keydown` handler.

**What it buys, concretely.** The palette lists commands. The help sheet is generated rather
than written. A button and a shortcut cannot drift apart, because both call `run()`. A command
can gain a sequence later without its implementation moving — which is what makes deferring
them cheap. Nothing has to be declared twice.

_Rejected: binding handlers directly to keys._ It is what we do now, and it is why `Mod+B`
exists twice. It also means a command palette would have to re-implement every action a second
time, and the two would drift.

### D2 — Two tables: commands are ours, bindings are the library's

> Revised. This decision originally read "the registry is the library's, not ours", with
> chord-less commands parked on a placeholder chord. Sequences showed that to be wrong; the
> reasoning is below, and the original is preserved in git.

The library's managers are binding tables: `HotkeyManager` is keyed by chord,
`SequenceManager` by sequence. They hold registrations, ids, conflict policy and enumeration,
and we should not build a second one — that is two sources of truth about what is bound, which
is the failure we already have.

But a command with **no** binding cannot live in a table keyed by binding. The first draft
worked around this by registering an unpressable `F24`, which sequences exposed as broken: with
several unbound commands, every one of them registers `F24`, and they conflict with _each
other_ — under D4's dev policy, loudly and wrongly.

So there are two tables, which is what D1 described all along:

| Table    | Holds                                                                              | Owner                                       |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| Commands | id, name, category, `when`, `run` — every command, bound or not                    | ours, a small `@tanstack/store` keyed by id |
| Bindings | chord → callback, sequence → callback, with `meta` back-referencing the command id | the library's two managers                  |

They are not two copies of one thing, so they cannot disagree the way a duplicated registry
can: the command table is the palette's source (it is complete), and the binding tables supply
what only they know (what is bound, what is live, how far a sequence has matched). `meta`
joins them by id.

```ts
declare module '@tanstack/hotkeys' {
  interface HotkeyMeta {
    /** Joins a binding back to its command. */
    id: string;
  }
}
```

Declaration merging means every registration carries it, typed, and the join is checked.

### D3 — One hook: `useCommand`

The DX target is that adding a shortcut is one declaration next to the thing it acts on, and
that nothing else has to be touched — no central list to append to, and no palette entry to
remember.

```ts
useCommand({
  id: 'tabs.close',
  name: 'Close tab',
  category: 'Tabs',
  hotkey: 'Mod+W',
  when: 'hasActiveTab',
  run: () => tabs.close(activeId),
});
```

Colocation is the point. A central keymap file is the alternative, and it is what VS Code
ships — but VS Code needs it because bindings are user-editable data. Ours are code, and a
central file would put every command a scroll away from the thing it acts on, which is how
they rot. When user-remapping arrives (deferred, below), the keymap becomes an override layer
that reads the same tables rather than replacing them.

`hotkey` is typed `Hotkey` today. When sequences land it widens to
`Hotkey | HotkeySequence` and `Array.isArray` discriminates — one field, no call site changes.

`hotkey` is optional. A command with no binding is still a command — it is in the store, so it
is in the palette, and it can be bound later without touching its implementation. That is how
most of VS Code's commands exist.

### D4 — Conflicts are an error in development, a warning in production

`conflictBehavior: 'error'` when `import.meta.env.DEV`, `'warn'` otherwise.

A duplicate binding is a bug, and it is the specific bug we already have. Failing loudly in
development is how it gets caught in the pull request instead of in someone's muscle memory.
Failing loudly in production is not — a shortcut collision is never worth a white screen in
front of a user, and a `console.warn` is enough for the person who will fix it.

`'replace'` is deliberately not used. Last-registration-wins depends on mount order, which
depends on render order, which nobody should have to reason about to know what `Mod+K` does.

### D5 — `when` is a named predicate, not an expression language

VS Code's `when` clauses are a small string DSL (`editorTextFocus && !inDebugMode`) because
they are authored in user-editable JSON, where code cannot be. Ours are authored in
TypeScript, where a function is simply better: typed, debuggable, and no parser to own.

```ts
const contexts = {
  hasActiveTab: () => strip?.activeId != null,
  inWorkspace: () => matchPath(patterns.workspace, pathname) != null,
  noDialogOpen: () => !someDialogIsOpen(),
} satisfies Record<string, () => boolean>;
```

`when` names one of these, and `useCommand` passes the result to the library's `enabled`.
Naming them rather than inlining arbitrary closures keeps the set of conditions small and
greppable — the same discipline the DSL enforces, without the DSL.

**Added in implementation: `available`.** Some conditions are not ambient — `workspace.new`
needs `session.canInvite`, which the declaring component already holds and which nothing else
asks about. Reading the session inside the context helper would mean calling `useSession()`
once per command, and that hook builds several queries and mutations. So `when` stays the
small named set of shared conditions, and `available` takes a boolean the caller already has.
Both fold into the same `enabled`.

**Soft-disable matters here.** `enabled: false` keeps the registration in the manager and only
suppresses firing, which is exactly right for the help sheet:
an unavailable command should be listed and greyed, not vanish. A shortcut that disappears
looks broken.

### D6 — Text fields and dialogs are the library's job, and mostly already done

`ignoreInputs` defaults per-chord as described above. We override it only with a reason at the
call site. Dialogs come free with `enabled`, via a `noDialogOpen` context.

**Contenteditable is covered** — checked in the 0.8.0 source rather than assumed.
`isInputElement` tests `element.isContentEditable` alongside input, textarea and select, and
deliberately lets `Mod+S` and `Escape` through when focus is on a button-type input. That
matters here: rooms will use a rich-text composer, not an `<input>`, and this is the check that
stops every keystroke in a message from triggering shortcuts.

### D7 — The webview panel is where this breaks, and no library can fix it

A `<webview>` is a separate renderer process. Keystrokes inside it never reach our document, so
**no hotkey registered here fires while a panel has focus** — and panels are the product
(Phase 10).

Nothing in `@tanstack/hotkeys` can change this; it is a process boundary, not a bubbling
problem. The escape hatch is Electron-side, and there are two:

- `webContents.on('before-input-event')` on the panel's `webContents`, forwarding a small
  allowlist of chords to the renderer over the existing bridge.
- Native menu accelerators, which fire regardless of focus because the OS menu owns them.

Both are Phase 10 work and both need the command ids from D1 to forward _to_. Naming it here so
it is designed for rather than discovered: **the command table is what makes a panel escape
hatch a routing problem rather than a rewrite.**

## The implementation

### `apps/client/src/lib/commands.ts`

```ts
// Types and formatters from core; hooks from the React package. See above.
import type { Hotkey } from '@tanstack/hotkeys';
import { useHotkey } from '@tanstack/react-hotkeys';

declare module '@tanstack/hotkeys' {
  interface HotkeyMeta {
    id: string;
  }
}

export type Category = 'Navigation' | 'Tabs' | 'Workspace' | 'Application';

/**
 * A command is the unit; a binding is one way to reach it. `hotkey` is absent for
 * palette-only commands, and widens to accept a sequence when sequences land.
 */
export interface Command {
  id: string;
  name: string;
  category: Category;
  hotkey?: Hotkey;
  when?: ContextName;
  run: () => void;
}

/** Nothing presses this. It parks the hook for a command with no binding. */
const IDLE = 'F24' as Hotkey;
const conflictBehavior = import.meta.env.DEV ? 'error' : 'warn';

/**
 * Declares a command, binds it if it has a chord, and leaves it in the palette either way.
 *
 * Colocated with the thing it acts on: there is no central list to append to, and no second
 * place to declare it for the palette.
 *
 * `useHotkey` is called unconditionally because hooks cannot be conditional. An unbound
 * command parks it on `IDLE` with `conflictBehavior: 'allow'`, so several unbound commands do
 * not collide with each other, and with no `meta`, so nothing reading the registry mistakes a
 * park for a binding.
 */
export function useCommand(command: Command): void {
  const enabled = useContextValue(command.when);
  useCommandEntry(command); // into the command store, bound or not

  const bound = command.hotkey != null;
  useHotkey(command.hotkey ?? IDLE, command.run, {
    enabled: enabled && bound,
    conflictBehavior: bound ? conflictBehavior : 'allow',
    meta: bound ? { id: command.id } : undefined,
  });
}
```

### Using it

```tsx
function TabStrip({ tabs }: { tabs: TabsApi }) {
  useCommand({
    id: 'tabs.close',
    name: 'Close tab',
    category: 'Tabs',
    hotkey: 'Mod+W',
    when: 'hasActiveTab',
    run: () => tabs.strip?.activeId && tabs.close(tabs.strip.activeId),
  });
  // …
}
```

### The help sheet, for free

Both tables, one list. The command store supplies the rows — so an unbound command still
appears — and the registration views supply the keys.

```tsx
function ShortcutsSheet() {
  const commands = useCommands();
  const { hotkeys } = useHotkeyRegistrations();

  const keysById = new Map(
    hotkeys.flatMap((h) =>
      h.options.meta ? [[h.options.meta.id, formatForDisplay(h.hotkey)]] : [],
    ),
  );

  const groups = Object.groupBy(commands, (c) => c.category);
  // keysById.get(c.id) renders ⌘W, or nothing at all for a palette-only command.
}
```

Nothing is declared twice: the sheet lists commands that exist and keys that are genuinely
registered, so it cannot claim a shortcut that does not exist or miss one that does.

## Steps

**1. Land the library and settle the collision.** `@tanstack/react-hotkeys` pinned at `0.10.0`
and `@tanstack/hotkeys` at `0.8.0`, both direct, `HotkeysProvider` at the shell, the `Mod+B` in
`main.tsx` moved to `useHotkey`, and the vendored sidebar's handler deleted — with a note in
`CLAUDE.md`, since `shadcn add --overwrite` restores it. Verify only one handler fires.

**2. `commands.ts`** — the command store, `useCommand`, `HotkeyMeta` merging, the DEV/production
conflict policy.

**3. `contexts.ts`** — the named predicates, starting with `hasActiveTab`, `inWorkspace`,
`noDialogOpen`.

**4. The help sheet on `?`**, off the command store joined to `useHotkeyRegistrations`. Do this
before adding many commands: it makes every later one self-documenting, and it is the cheapest
possible test that both tables hold what we think.

**5. Chord commands.** `tabs.close` `Mod+W`, `tabs.next` `Ctrl+Tab`, `tabs.select1..9`
`Mod+1..9`, `sidebar.toggle` `Mod+B`, `workspace.switch` `Mod+Shift+[`/`]`, `settings.open`
`Mod+,`.

**6. The palette on `Mod+K`**, over the vendored `command.tsx` (cmdk), listing the command store
and invoking `run()`.

**7. Panel escape hatch** — Phase 10, per D7.

## What it cost

The client bundle went from 595.28 kB to 665.93 kB (204.75 kB gzipped). Roughly half is
`@tanstack/hotkeys` and half is `cmdk`, which was already vendored but unreferenced until the
palette used it. Worth knowing before the next thing is added to the shell; the palette is the
obvious candidate for a dynamic import if this starts to matter.

## Deliberately not built

| Item                                         | Why, and what it would take                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User-remappable keys                         | Nobody has asked. The two tables are the precondition; it becomes an override layer keyed by command id, plus storage in `sync/src/local/` and `useHotkeyRecorder` / `useHotkeySequenceRecorder`, which already exist                                                                                                                                                                                                    |
| Electron menu accelerators                   | Real gap for panel focus (D7), but it is Phase 10's problem and wants the command ids first                                                                                                                                                                                                                                                                                                                              |
| Per-room or per-panel scopes                 | `target` scopes to an element when we need it. Today everything is app-level                                                                                                                                                                                                                                                                                                                                             |
| Sequences (`g` then `r`)                     | Design surface the product does not need yet, and no library both registers per-hook and resolves prefix shadowing — see the survey. Adding them means widening `hotkey` to accept an array, a dev-only check across the two registration views, and a pending-prefix indicator off `matchedStepCount`. If they become central, swap the binding layer under `useCommand` for tinykeys' matcher and keep every call site |
| Chord-then-chord sequences (`Mod+K` `Mod+S`) | Supported by the library — steps take modifiers — but VS Code is the only product that leans on them, and they are hard to discover. Bare-letter sequences would come first                                                                                                                                                                                                                                              |

## Questions to settle

- ~~**`?` for the help sheet.**~~ Settled: **`Mod+/`**, which is what Slack binds. Bare `?` is
  `Shift+/`, and the library's types exclude punctuation from `Shift+` combinations
  (`Shift+${NonPunctuationKey}`) because `Shift+,` is `<` on a US layout and something else
  elsewhere. `Mod+/` is typed, conventional, and sidesteps the question of whether a bare `?`
  should fire mid-message.
- **`Mod+W`.** On desktop this is "close window" by convention. Close the tab, or the window
  when only one tab remains, the way browsers do?
- **`Escape`.** Owned globally, or per-component? It is the one key everything wants.
- **Where `useCommand` lives.** `apps/client/src/lib/` now; if the browser and desktop surfaces
  ever diverge on bindings it may want to be capability-driven like `platform.ts`.

## Candidates for ARCHITECTURE.md

To promote when that file is next edited in its own turn — not as a side effect of this work:

- **D1 as the client's input contract**: commands are addressable actions; chords, menus and
  the palette are all callers.
- **D7 into the Hazards Register**: a `<webview>` is a separate renderer, so no host hotkey
  fires while a panel has focus. This constrains Phase 10 and is not fixable in the renderer.
- **Into the Hazards Register, when sequences land**: a library that registers bindings
  per-hook cannot detect a single-key chord shadowing a sequence that begins with that key —
  the listeners cannot see each other, so both respond and the chord wins. True of TanStack and
  of `react-hotkeys-hook`; only a single-matcher library such as tinykeys resolves it. The
  check is ours to own for as long as we register per-hook.
