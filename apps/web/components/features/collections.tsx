'use client';

import { Copy, Database, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { apiRequest } from '../../lib/api';
import { notify } from '../console-events';
import type { Project, SearchIndex } from '../console-model';
import { Empty, State } from '../feature-primitives';
import { Button } from '../ui/button';
import { ConfirmDialog, DialogFrame, PromptDialog } from '../ui/dialog';
import { Input } from '../ui/input';

export function IndexesView({
  project,
  indexes,
  canManage,
  onChanged,
}: {
  project?: Project;
  indexes: SearchIndex[];
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('Demo products');
  const [slug, setSlug] = useState('demo-products');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<SearchIndex | null>(null);
  const [renameTarget, setRenameTarget] = useState<SearchIndex | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const selected = indexes.find((item) => item.id === selectedId) ?? indexes[0];
  const filteredIndexes = indexes.filter((index) =>
    `${index.name} ${index.slug}`.toLowerCase().includes(filter.toLowerCase()),
  );

  async function copyAlias(alias: string) {
    try {
      await navigator.clipboard.writeText(alias);
      notify('Collection alias copied.');
    } catch {
      notify('Could not copy the collection alias.', 'error');
    }
  }

  if (!project)
    return (
      <Empty
        title="Select a project"
        detail="Choose a project before managing collections."
      />
    );

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/projects/${project!.id}/indexes`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          slug,
          withDemoData: true,
          defaultSortingField: 'price',
          fields: [
            {
              name: 'title',
              type: 'string',
              searchable: true,
              facet: false,
              sort: false,
              optional: false,
            },
            {
              name: 'category',
              type: 'string',
              searchable: true,
              facet: true,
              sort: false,
              optional: false,
            },
            {
              name: 'price',
              type: 'float',
              searchable: false,
              facet: true,
              sort: true,
              optional: false,
            },
            {
              name: 'in_stock',
              type: 'bool',
              searchable: false,
              facet: true,
              sort: false,
              optional: false,
            },
          ],
        }),
      });
      await onChanged();
      setCreateOpen(false);
      notify('Collection created.');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not create collection',
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(index: SearchIndex) {
    setDialogBusy(true);
    setError('');
    try {
      await apiRequest(
        `/indexes/${index.id}?confirm=${encodeURIComponent(index.slug)}`,
        { method: 'DELETE' },
      );
      setDeleteTarget(null);
      await onChanged();
      notify('Collection deleted.');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not delete collection',
      );
    } finally {
      setDialogBusy(false);
    }
  }

  async function rename(index: SearchIndex, next: string) {
    if (next === index.name) return setRenameTarget(null);
    setDialogBusy(true);
    setError('');
    try {
      await apiRequest(`/indexes/${index.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next }),
      });
      setRenameTarget(null);
      await onChanged();
      notify('Collection renamed.');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not rename collection',
      );
    } finally {
      setDialogBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {indexes.length
            ? `${indexes.length} ${indexes.length === 1 ? 'collection' : 'collections'}`
            : 'No collections yet'}
        </p>
        {canManage && indexes.length ? (
          <Button onClick={() => setCreateOpen(true)} type="button">
            <Plus className="size-4" /> New collection
          </Button>
        ) : null}
      </div>

      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {!indexes.length ? (
        <section className="rounded-xl border border-dashed border-border p-12 text-center">
          <Database className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-4 font-medium">No collections in this project</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Collections provide a stable search alias backed by versioned
            Typesense collections.
          </p>
          {canManage ? (
            <Button
              className="mt-5"
              onClick={() => setCreateOpen(true)}
              type="button"
            >
              Create first collection
            </Button>
          ) : null}
        </section>
      ) : (
        <div className="grid min-w-0 gap-5 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <section
            aria-label="Collections"
            className="min-w-0 overflow-hidden rounded-xl border border-border bg-card"
          >
            <div className="border-b border-border p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Filter collections"
                  className="pl-9"
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter collections"
                  value={filter}
                />
              </div>
            </div>
            {filteredIndexes.map((index) => (
              <button
                aria-current={index.id === selected?.id ? 'true' : undefined}
                className={`relative block w-full border-b border-border px-4 py-4 text-left last:border-b-0 ${
                  index.id === selected?.id
                    ? 'bg-primary/5 text-accent-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary'
                    : 'hover:bg-muted'
                }`}
                key={index.id}
                onClick={() => setSelectedId(index.id)}
                type="button"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 font-medium">
                    <span className="size-2 shrink-0 rounded-full bg-success" />
                    <span className="truncate">{index.name}</span>
                  </span>
                  <State value={index.state} />
                </span>
                <span className="mt-1 block font-mono text-xs text-muted-foreground">
                  {index.slug}
                </span>
                <span className="mt-2 block text-xs text-muted-foreground">
                  {index.generations[0]?.recordCount ?? 0} records
                </span>
              </button>
            ))}
            {!filteredIndexes.length ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No collections match “{filter}”.
              </p>
            ) : null}
          </section>

          {selected ? (
            <section className="min-w-0 rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">{selected.name}</h2>
                    <State value={selected.state} />
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1">
                    <p className="break-all font-mono text-xs text-muted-foreground">
                      {selected.alias}
                    </p>
                    <Button
                      aria-label="Copy collection alias"
                      className="size-7 shrink-0"
                      onClick={() => void copyAlias(selected.alias)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {canManage ? (
                  <Button
                    aria-label={`Rename ${selected.name}`}
                    onClick={() => {
                      setRenameTarget(selected);
                      setRenameValue(selected.name);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Pencil className="size-4" /> Rename
                  </Button>
                ) : null}
              </div>
              <dl className="grid gap-px bg-border sm:grid-cols-3">
                <CollectionFact
                  label="Active generation"
                  value={String(selected.activeGeneration ?? '—')}
                />
                <CollectionFact
                  label="Indexed records"
                  value={String(selected.generations[0]?.recordCount ?? 0)}
                />
                <CollectionFact
                  label="Search fields"
                  value={String(
                    selected.mapping.fields.filter((field) => field.searchable)
                      .length,
                  )}
                />
              </dl>
              <div className="p-5">
                <h3 className="text-sm font-semibold">Schema</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Current allowlisted mapping used by search and ingestion.
                </p>
                <div className="mt-4 overflow-x-auto rounded-lg border border-border">
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead className="bg-muted text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-medium">Field</th>
                        <th className="px-4 py-3 font-medium">Type</th>
                        <th className="px-4 py-3 font-medium">Search</th>
                        <th className="px-4 py-3 font-medium">Facet</th>
                        <th className="px-4 py-3 font-medium">Sort</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {selected.mapping.fields.map((field) => (
                        <tr key={field.name}>
                          <td className="px-4 py-3 font-mono text-xs">
                            {field.name}
                          </td>
                          <td className="px-4 py-3">{field.type}</td>
                          <td className="px-4 py-3">
                            {field.searchable ? 'Yes' : '—'}
                          </td>
                          <td className="px-4 py-3">
                            {field.facet ? 'Yes' : '—'}
                          </td>
                          <td className="px-4 py-3">
                            {field.sort ? 'Yes' : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {canManage ? (
                <div className="flex flex-wrap items-center justify-between gap-4 border-t border-destructive/30 bg-destructive/[0.03] p-5">
                  <div>
                    <h3 className="text-sm font-semibold text-destructive">
                      Delete this collection
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Permanently remove the alias and every indexed generation.
                    </p>
                  </div>
                  <Button
                    aria-label={`Delete ${selected.name}`}
                    onClick={() => setDeleteTarget(selected)}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    <Trash2 className="size-4" /> Delete collection
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      )}

      <DialogFrame
        description="This uses the existing starter product schema and imports the bundled demo records so the collection is immediately searchable."
        onOpenChange={setCreateOpen}
        open={createOpen}
        title="Create collection"
      >
        <form className="mt-5 space-y-4" onSubmit={create}>
          <label className="block text-sm font-medium">
            Name
            <Input
              autoFocus
              className="mt-2"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label className="block text-sm font-medium">
            Slug
            <Input
              className="mt-2 font-mono"
              onChange={(event) => setSlug(event.target.value)}
              required
              value={slug}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              disabled={busy}
              onClick={() => setCreateOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={busy} type="submit">
              {busy ? 'Creating…' : 'Create collection'}
            </Button>
          </div>
        </form>
      </DialogFrame>

      <PromptDialog
        busy={dialogBusy}
        confirmLabel="Save name"
        description="The stable alias and indexed documents will not change."
        label="Collection name"
        onConfirm={(value) =>
          renameTarget ? rename(renameTarget, value) : undefined
        }
        onOpenChange={(open) => {
          if (!open && !dialogBusy) setRenameTarget(null);
        }}
        open={Boolean(renameTarget)}
        setValue={setRenameValue}
        title="Rename collection"
        value={renameValue}
      />
      <ConfirmDialog
        busy={dialogBusy}
        confirmLabel="Delete collection"
        description={
          deleteTarget
            ? `Delete “${deleteTarget.name}” and all of its versioned collections? This cannot be undone.`
            : ''
        }
        onConfirm={() => (deleteTarget ? remove(deleteTarget) : undefined)}
        onOpenChange={(open) => {
          if (!open && !dialogBusy) setDeleteTarget(null);
        }}
        open={Boolean(deleteTarget)}
        title="Delete collection?"
        variant="destructive"
      />
    </>
  );
}

function CollectionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card p-5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-xl font-semibold">{value}</dd>
    </div>
  );
}
