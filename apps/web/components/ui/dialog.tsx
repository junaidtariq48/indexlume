'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { Button } from './button';
import { Input } from './input';

interface DialogFrameProps {
  children: ReactNode;
  description: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  title: string;
}

export function DialogFrame({
  children,
  description,
  onOpenChange,
  open,
  size = 'md',
  title,
}: DialogFrameProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    }
  }, [open]);

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className={cn(
        'm-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-2xl',
        size === 'sm' && 'max-w-sm',
        size === 'md' && 'max-w-md',
        size === 'lg' && 'max-w-2xl',
        size === 'xl' && 'max-w-5xl',
      )}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => {
        onOpenChange(false);
        window.requestAnimationFrame(() => returnFocusRef.current?.focus());
      }}
      ref={ref}
      role="dialog"
    >
      <div className="relative p-6">
        <div className="flex items-start gap-4 pr-8">
          <h2 className="text-base font-semibold" id={titleId}>
            {title}
          </h2>
        </div>
        <button
          aria-label={`Close ${title}`}
          className="absolute right-4 top-4 inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          onClick={() => onOpenChange(false)}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
        <p
          className="mt-2 text-sm leading-6 text-muted-foreground"
          id={descriptionId}
        >
          {description}
        </p>
        {children}
      </div>
    </dialog>
  );
}

interface ConfirmDialogProps {
  busy?: boolean;
  confirmLabel: string;
  description: string;
  onConfirm: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  variant?: 'default' | 'destructive';
}

export function ConfirmDialog({
  busy = false,
  confirmLabel,
  description,
  onConfirm,
  onOpenChange,
  open,
  title,
  variant = 'default',
}: ConfirmDialogProps) {
  return (
    <DialogFrame
      description={description}
      onOpenChange={onOpenChange}
      open={open}
      title={title}
    >
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          autoFocus
          disabled={busy}
          onClick={() => onOpenChange(false)}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          disabled={busy}
          onClick={() => void onConfirm()}
          type="button"
          variant={variant}
        >
          {busy ? 'Please wait…' : confirmLabel}
        </Button>
      </div>
    </DialogFrame>
  );
}

interface PromptDialogProps {
  busy?: boolean;
  confirmLabel: string;
  description: string;
  label: string;
  onConfirm: (value: string) => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  setValue: (value: string) => void;
  title: string;
  value: string;
}

export function PromptDialog({
  busy = false,
  confirmLabel,
  description,
  label,
  onConfirm,
  onOpenChange,
  open,
  setValue,
  title,
  value,
}: PromptDialogProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (value.trim()) void onConfirm(value.trim());
  }

  return (
    <DialogFrame
      description={description}
      onOpenChange={onOpenChange}
      open={open}
      title={title}
    >
      <form className="mt-5" onSubmit={submit}>
        <label className="text-sm font-medium">
          {label}
          <Input
            autoFocus
            className="mt-2"
            disabled={busy}
            maxLength={100}
            onChange={(event) => setValue(event.target.value)}
            required
            value={value}
          />
        </label>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            disabled={busy}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={busy} type="submit">
            {busy ? 'Please wait…' : confirmLabel}
          </Button>
        </div>
      </form>
    </DialogFrame>
  );
}
