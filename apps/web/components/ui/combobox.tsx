'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import { cn } from '../../lib/utils';
import { Button } from './button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export type ComboboxOption = {
  value: string;
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
  disabled?: boolean;
};

export function Combobox({
  ariaLabel,
  className,
  contentClassName,
  disabled,
  emptyMessage = 'No options found.',
  id,
  onValueChange,
  options,
  placeholder = 'Select an option',
  searchPlaceholder = 'Search…',
  value,
}: {
  ariaLabel: string;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  emptyMessage?: string;
  id?: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const groups = useMemo(() => {
    const grouped = new Map<string, ComboboxOption[]>();
    for (const option of options) {
      const key = option.group ?? '';
      grouped.set(key, [...(grouped.get(key) ?? []), option]);
    }
    return [...grouped.entries()];
  }, [options]);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-label={ariaLabel}
          className={cn(
            'h-10 w-full justify-between bg-card px-3 font-normal',
            !selected && 'text-muted-foreground',
            className,
          )}
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
          variant="outline"
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn(
          'w-[var(--radix-popover-trigger-width)] p-0',
          contentClassName,
        )}
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            {groups.map(([group, items]) => (
              <CommandGroup
                heading={group || undefined}
                key={group || 'options'}
              >
                {items.map((option) => (
                  <CommandItem
                    disabled={option.disabled}
                    key={option.value}
                    keywords={option.keywords}
                    onSelect={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                    value={`${option.label} ${option.value}`}
                  >
                    <Check
                      className={cn(
                        'mr-2 size-4',
                        value === option.value ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{option.label}</span>
                      {option.description ? (
                        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
