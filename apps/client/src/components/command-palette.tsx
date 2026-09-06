import { formatForDisplay } from '@tanstack/hotkeys';
import { useState } from 'react';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { CATEGORIES, useCommand, useCommands } from '@/lib/commands';

/**
 * The palette.
 *
 * Lists the command store rather than a hand-kept array, so a command reaches it by being
 * declared — and a command with no chord is reachable here and nowhere else, which is the
 * reason the store holds unbound commands at all.
 *
 * Disabled commands are hidden rather than dimmed: the help sheet is where you go to learn
 * what exists, and running something that cannot run is the one thing a palette must not do.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const commands = useCommands();

  useCommand({
    id: 'palette.open',
    name: 'Command palette',
    category: 'Application',
    hotkey: 'Mod+K',
    run: () => setOpen((v) => !v),
  });

  const groups = CATEGORIES.map((category) => ({
    category,
    items: commands.filter((c) => c.category === category && c.enabled && c.id !== 'palette.open'),
  })).filter((g) => g.items.length > 0);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search commands…" />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        {groups.map(({ category, items }) => (
          <CommandGroup key={category} heading={category}>
            {items.map((c) => (
              <CommandItem
                key={c.id}
                value={`${c.category} ${c.name}`}
                onSelect={() => {
                  // Close first: a command that navigates would otherwise run against a tree
                  // the dialog still has focus trapped in.
                  setOpen(false);
                  c.run();
                }}
              >
                {c.name}
                {c.hotkey && <CommandShortcut>{formatForDisplay(c.hotkey)}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
