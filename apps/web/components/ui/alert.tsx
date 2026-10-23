import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

const alertVariants = cva('rounded-md border p-3 text-sm', {
  variants: {
    variant: {
      default: 'border-border bg-card text-card-foreground',
      info: 'border-primary/30 bg-primary/8 text-foreground',
      warning: 'border-warning/35 bg-warning/10 text-foreground',
      destructive: 'border-destructive/35 bg-destructive/10 text-destructive',
      success: 'border-success/30 bg-success/10 text-foreground',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Alert({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return (
    <div
      className={cn(alertVariants({ className, variant }))}
      role={variant === 'destructive' ? 'alert' : undefined}
      {...props}
    />
  );
}
