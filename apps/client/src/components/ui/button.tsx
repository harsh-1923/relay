import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

const variants = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  outline: 'border border-border hover:bg-muted',
  ghost: 'hover:bg-muted',
} as const;

export function Button({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'button'> & { variant?: keyof typeof variants }) {
  return (
    <button
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium',
        'transition-opacity disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:ring-2 focus-visible:ring-foreground/20 focus-visible:outline-none',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
