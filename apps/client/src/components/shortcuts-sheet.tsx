import { formatForDisplay } from '@tanstack/hotkeys';
import { useState } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { CATEGORIES, useCommand, useCommands, type Category } from '@/lib/commands';

/**
 * Every shortcut, generated rather than written.
 *
 * The list comes from the command store joined to what is genuinely registered, so it cannot
 * claim a shortcut that does not exist or miss one that does — which is the point of building
 * this before most of the commands.
 *
 * ⌘/ rather than `?`: it is what Slack binds, and it sidesteps the question of whether a bare
 * `?` should fire while someone is typing a message.
 */
export function ShortcutsSheet() {
  const [open, setOpen] = useState(false);
  const commands = useCommands();

  useCommand({
    id: 'help.shortcuts',
    name: 'Keyboard shortcuts',
    category: 'Application',
    hotkey: 'Mod+/',
    run: () => setOpen((v) => !v),
  });

  const groups = CATEGORIES.map((category) => ({
    category,
    items: commands.filter((c) => c.category === category),
  })).filter((g) => g.items.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Everything the app can do from the keyboard. Unavailable here right now is dimmed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {groups.map(({ category, items }) => (
            <section key={category}>
              <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
                {category as Category}
              </h3>
              <ul className="flex flex-col">
                {items.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-4 py-1.5 text-sm"
                    data-disabled={!c.enabled || undefined}
                  >
                    <span className={c.enabled ? undefined : 'text-muted-foreground'}>
                      {c.name}
                    </span>
                    {c.hotkey ? (
                      <Kbd>{formatForDisplay(c.hotkey)}</Kbd>
                    ) : (
                      // Palette-only, and saying so is more useful than an empty column.
                      <span className="text-muted-foreground text-xs">⌘K</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
