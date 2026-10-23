'use client';

import {
  Bookmark,
  Copy,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { apiRequest } from '../../lib/api';
import { notify } from '../console-events';
import type {
  ListResponse,
  SearchIndex,
  SearchPreset,
  SearchResult,
  SearchSettings,
} from '../console-model';
import { Empty } from '../feature-primitives';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { ConfirmDialog, DialogFrame } from '../ui/dialog';
import { Input } from '../ui/input';

export function SearchStudio({
  indexes,
  canManage,
}: {
  indexes: SearchIndex[];
  canManage: boolean;
}) {
  const ready = indexes.filter((item) => item.state === 'READY');
  const [indexId, setIndexId] = useState('');
  const [query, setQuery] = useState('');
  const [queryBy, setQueryBy] = useState<string[]>([]);
  const [facetBy, setFacetBy] = useState<string[]>([]);
  const [filterField, setFilterField] = useState('');
  const [filterOperator, setFilterOperator] = useState<
    'eq' | 'gt' | 'gte' | 'lt' | 'lte'
  >('eq');
  const [filterValue, setFilterValue] = useState('');
  const [filters, setFilters] = useState<
    NonNullable<SearchSettings['filterBy']>
  >([]);
  const [sortField, setSortField] = useState('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [presets, setPresets] = useState<SearchPreset[]>([]);
  const [presetName, setPresetName] = useState('');
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [presetSaving, setPresetSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [deletePresetTarget, setDeletePresetTarget] =
    useState<SearchPreset | null>(null);
  const [deletePresetBusy, setDeletePresetBusy] = useState(false);
  const [selectedHitIndex, setSelectedHitIndex] = useState(0);
  const selected = ready.find((item) => item.id === indexId) ?? ready[0];
  const searchable =
    selected?.mapping.fields.filter((field) => field.searchable) ?? [];
  const facetable =
    selected?.mapping.fields.filter((field) => field.facet) ?? [];
  const sortable = selected?.mapping.fields.filter((field) => field.sort) ?? [];

  const loadPresets = useCallback(async (id: string) => {
    if (!id) return setPresets([]);
    setPresetsLoading(true);
    try {
      const response = await apiRequest<ListResponse<SearchPreset>>(
        `/indexes/${id}/presets`,
      );
      setPresets(response.data);
    } finally {
      setPresetsLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!selected) return;
    setIndexId(selected.id);
    setQueryBy(selected.searchDefaults.queryBy);
    setFacetBy([]);
    setFilters([]);
    setSortField('');
    setPage(1);
    setResult(null);
    void loadPresets(selected.id).catch((caught: unknown) =>
      setError(
        caught instanceof Error ? caught.message : 'Could not load presets',
      ),
    );
  }, [selected?.id, loadPresets]);

  function settings(): SearchSettings {
    return {
      q: query,
      queryBy,
      ...(filters.length ? { filterBy: filters } : {}),
      ...(facetBy.length ? { facetBy } : {}),
      ...(sortField
        ? { sortBy: [{ field: sortField, direction: sortDirection }] }
        : {}),
      page,
      perPage,
    };
  }
  async function runSearch(nextPage = page) {
    if (!selected) return;
    if (!queryBy.length) {
      setAdvancedOpen(true);
      setError('Select at least one searchable field.');
      return;
    }
    setError('');
    setPage(nextPage);
    setSearching(true);
    try {
      const response = await apiRequest<SearchResult>(
        `/indexes/${selected.id}/playground/search`,
        {
          method: 'POST',
          body: JSON.stringify({ ...settings(), page: nextPage }),
        },
      );
      setResult(response);
      setSelectedHitIndex(0);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  }
  function run(event: FormEvent) {
    event.preventDefault();
    void runSearch(1);
  }
  function addFilter() {
    const field = selected?.mapping.fields.find(
      (item) => item.name === filterField,
    );
    if (!field || !filterValue.trim()) return;
    let value: string | number | boolean = filterValue.trim();
    if (['int32', 'int64', 'float'].includes(field.type)) {
      value = Number(value);
      if (!Number.isFinite(value))
        return setError('Enter a numeric filter value.');
    } else if (field.type === 'bool') {
      if (!['true', 'false'].includes(String(value).toLowerCase()))
        return setError('Boolean filters must be true or false.');
      value = String(value).toLowerCase() === 'true';
    }
    setFilters((items) => [
      ...items,
      { field: field.name, operator: filterOperator, value },
    ]);
    setFilterValue('');
    setError('');
  }
  async function savePreset() {
    if (!selected || !presetName.trim()) return;
    setError('');
    setPresetSaving(true);
    try {
      await apiRequest(`/indexes/${selected.id}/presets`, {
        method: 'POST',
        body: JSON.stringify({ name: presetName.trim(), settings: settings() }),
      });
      setPresetName('');
      await loadPresets(selected.id);
      notify('Search preset saved.');
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not save preset',
      );
    } finally {
      setPresetSaving(false);
    }
  }
  function applyPreset(preset: SearchPreset) {
    const value = preset.settings;
    setQuery(value.q);
    setQueryBy(value.queryBy);
    setFilters(value.filterBy ?? []);
    setFacetBy(value.facetBy ?? []);
    setSortField(value.sortBy?.[0]?.field ?? '');
    setSortDirection(value.sortBy?.[0]?.direction ?? 'asc');
    setPage(value.page);
    setPerPage(value.perPage);
    setResult(null);
    notify(`Loaded “${preset.name}”.`, 'info');
  }
  async function deletePreset(preset: SearchPreset) {
    if (!selected) return;
    setDeletePresetBusy(true);
    setError('');
    try {
      await apiRequest(`/presets/${preset.id}`, { method: 'DELETE' });
      setDeletePresetTarget(null);
      await loadPresets(selected.id);
      notify('Search preset deleted.');
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not delete preset',
      );
    } finally {
      setDeletePresetBusy(false);
    }
  }
  async function copyExample() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(
        `await fetch('/api/v1/indexes/${selected.id}/playground/search', {\n  method: 'POST',\n  headers: { 'content-type': 'application/json' },\n  body: JSON.stringify(${JSON.stringify(settings(), null, 2)})\n});`,
      );
      notify('Example request copied.');
    } catch {
      notify('Could not copy the example request.', 'error');
    }
  }
  async function copyRecord(record: Record<string, unknown>) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(record, null, 2));
      notify('Record JSON copied.');
    } catch {
      notify('Could not copy the record JSON.', 'error');
    }
  }
  if (!ready.length)
    return (
      <Empty
        title="No ready index"
        detail="Create a ready collection before opening Search Studio."
      />
    );
  return (
    <>
      <form
        aria-busy={searching}
        className="overflow-hidden rounded-xl border border-border bg-card"
        onSubmit={run}
      >
        <div className="grid gap-4 p-5 lg:grid-cols-[14rem_minmax(0,1fr)_auto]">
          <label className="text-sm font-medium">
            Collection
            <Combobox
              ariaLabel="Search index"
              className="mt-2"
              emptyMessage="No ready collections found."
              onValueChange={setIndexId}
              options={ready.map((item) => ({
                value: item.id,
                label: item.name,
                group: 'Collections',
                keywords: [item.slug],
              }))}
              searchPlaceholder="Search collections…"
              value={selected?.id ?? ''}
            />
          </label>
          <label className="text-sm font-medium">
            Query
            <Input
              className="mt-2"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search, or leave blank for all records"
              value={query}
            />
          </label>
          <Button className="self-end" disabled={searching} type="submit">
            <Search className="size-4" />
            {searching ? 'Searching…' : 'Search'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-5 py-3">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-controls="search-options"
              aria-expanded={advancedOpen}
              size="sm"
              type="button"
              variant="outline"
            >
              <SlidersHorizontal className="size-4" />
              {advancedOpen ? 'Hide options' : 'Search options'}
            </Button>
            <Button
              onClick={() => setPresetsOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Bookmark className="size-4" /> Presets
              {presets.length ? ` (${presets.length})` : ''}
            </Button>
          </div>
          <Button
            onClick={() => void copyExample()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Copy className="size-4" /> Copy request
          </Button>
        </div>

        {advancedOpen ? (
          <div
            className="space-y-6 border-t border-border p-5"
            id="search-options"
          >
            <div className="grid gap-6 lg:grid-cols-2">
              <fieldset>
                <legend className="text-sm font-medium">Search fields</legend>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose the allowlisted fields queried for text matches.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  {searchable.map((field) => (
                    <label
                      className="flex items-center gap-2 text-sm text-muted-foreground"
                      key={field.name}
                    >
                      <input
                        checked={queryBy.includes(field.name)}
                        onChange={(event) =>
                          setQueryBy((items) =>
                            event.target.checked
                              ? [...items, field.name]
                              : items.filter((item) => item !== field.name),
                          )
                        }
                        type="checkbox"
                      />
                      {field.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="text-sm font-medium">Facets</legend>
                <p className="mt-1 text-xs text-muted-foreground">
                  Request facet counts for selected fields.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  {facetable.map((field) => (
                    <label
                      className="flex items-center gap-2 text-sm text-muted-foreground"
                      key={field.name}
                    >
                      <input
                        checked={facetBy.includes(field.name)}
                        onChange={(event) =>
                          setFacetBy((items) =>
                            event.target.checked
                              ? [...items, field.name]
                              : items.filter((item) => item !== field.name),
                          )
                        }
                        type="checkbox"
                      />
                      {field.name}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <div>
              <h3 className="text-sm font-medium">Filters</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Combobox
                  ariaLabel="Filter field"
                  onValueChange={setFilterField}
                  options={[
                    { value: '', label: 'Filter field' },
                    ...facetable.map((field) => ({
                      value: field.name,
                      label: field.name,
                      group: 'Facetable fields',
                    })),
                  ]}
                  placeholder="Filter field"
                  searchPlaceholder="Search fields…"
                  value={filterField}
                />
                <Combobox
                  ariaLabel="Filter operator"
                  onValueChange={(value) =>
                    setFilterOperator(value as typeof filterOperator)
                  }
                  options={[
                    { value: 'eq', label: 'equals', group: 'Operators' },
                    { value: 'gt', label: 'greater than', group: 'Operators' },
                    { value: 'gte', label: 'at least', group: 'Operators' },
                    { value: 'lt', label: 'less than', group: 'Operators' },
                    { value: 'lte', label: 'at most', group: 'Operators' },
                  ]}
                  searchPlaceholder="Search operators…"
                  value={filterOperator}
                />
                <Input
                  aria-label="Filter value"
                  onChange={(event) => setFilterValue(event.target.value)}
                  placeholder="Filter value"
                  value={filterValue}
                />
                <Button onClick={addFilter} type="button" variant="outline">
                  Add filter
                </Button>
              </div>
              {filters.length ? (
                <div
                  aria-label="Active filters"
                  className="mt-3 flex flex-wrap gap-2"
                >
                  {filters.map((filter, index) => (
                    <button
                      className="rounded-full bg-muted px-3 py-1 text-xs"
                      key={`${filter.field}-${index}`}
                      onClick={() =>
                        setFilters((items) =>
                          items.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                      type="button"
                    >
                      {filter.field} {filter.operator} {String(filter.value)} ×
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-sm font-medium">
                Sort field
                <Combobox
                  ariaLabel="Sort field"
                  className="mt-2"
                  onValueChange={setSortField}
                  options={[
                    { value: '', label: 'Relevance' },
                    ...sortable.map((field) => ({
                      value: field.name,
                      label: field.name,
                      group: 'Sortable fields',
                    })),
                  ]}
                  searchPlaceholder="Search fields…"
                  value={sortField}
                />
              </label>
              <label className="text-sm font-medium">
                Direction
                <Combobox
                  ariaLabel="Sort direction"
                  className="mt-2"
                  disabled={!sortField}
                  onValueChange={(value) =>
                    setSortDirection(value as 'asc' | 'desc')
                  }
                  options={[
                    { value: 'asc', label: 'Ascending' },
                    { value: 'desc', label: 'Descending' },
                  ]}
                  value={sortDirection}
                />
              </label>
              <label className="text-sm font-medium">
                Page
                <Input
                  className="mt-2"
                  min={1}
                  onChange={(event) => setPage(Number(event.target.value))}
                  type="number"
                  value={page}
                />
              </label>
              <label className="text-sm font-medium">
                Results per page
                <Combobox
                  ariaLabel="Results per page"
                  className="mt-2"
                  onValueChange={(value) => setPerPage(Number(value))}
                  options={[10, 20, 50, 100].map((value) => ({
                    value: String(value),
                    label: String(value),
                    group: 'Page size',
                  }))}
                  value={String(perPage)}
                />
              </label>
            </div>
          </div>
        ) : null}
      </form>

      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <section className="grid min-w-0 overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[minmax(0,1.45fr)_minmax(17rem,0.8fr)]">
          <div className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
              <div>
                <h2 className="font-semibold">Results</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {result.found} results · {result.requestMs} ms
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={searching || page <= 1}
                  onClick={() => void runSearch(page - 1)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Previous
                </Button>
                <Button
                  disabled={searching || page * perPage >= result.found}
                  onClick={() => void runSearch(page + 1)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Next
                </Button>
              </div>
            </div>
            {result.hits.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-left text-sm">
                  <thead className="bg-muted/60 text-xs text-muted-foreground">
                    <tr>
                      {(selected?.mapping.fields.slice(0, 4) ?? []).map(
                        (field) => (
                          <th
                            className="px-4 py-3 font-medium"
                            key={field.name}
                          >
                            {field.name.replaceAll('_', ' ')}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {result.hits.map((hit, index) => {
                      const document = hit.document ?? {};
                      return (
                        <tr
                          className={
                            index === selectedHitIndex
                              ? 'cursor-pointer bg-primary/5'
                              : 'cursor-pointer hover:bg-muted/50'
                          }
                          key={index}
                          onClick={() => setSelectedHitIndex(index)}
                        >
                          {(selected?.mapping.fields.slice(0, 4) ?? []).map(
                            (field) => (
                              <td
                                className="max-w-48 truncate px-4 py-3"
                                key={field.name}
                              >
                                {String(document[field.name] ?? '—')}
                              </td>
                            ),
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-10 text-center text-sm text-muted-foreground">
                No records matched this search.
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex min-h-[4.75rem] items-center justify-between gap-3 border-b border-border px-5 py-3">
              <div className="min-w-0">
                <h2 className="font-semibold">Record JSON</h2>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  {String(
                    result.hits[selectedHitIndex]?.document?.id ??
                      `result-${selectedHitIndex + 1}`,
                  )}
                </p>
              </div>
              {result.hits[selectedHitIndex]?.document ? (
                <Button
                  onClick={() =>
                    void copyRecord(result.hits[selectedHitIndex]!.document!)
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Copy className="size-4" /> Copy JSON
                </Button>
              ) : null}
            </div>
            <pre className="m-5 max-h-[34rem] overflow-auto rounded-lg bg-slate-950 p-5 text-xs leading-5 text-slate-100">
              {JSON.stringify(
                result.hits[selectedHitIndex]?.document ?? {},
                null,
                2,
              )}
            </pre>
          </div>
        </section>
      ) : (
        <section className="rounded-xl border border-dashed border-border p-12 text-center">
          <Search className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-4 font-medium">Run a search to inspect results</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Start with a query above. Advanced filters and sorting stay out of
            the way until you need them.
          </p>
        </section>
      )}

      <DialogFrame
        description="Load, create, or remove validated settings for this collection."
        onOpenChange={setPresetsOpen}
        open={presetsOpen}
        size="lg"
        title="Search presets"
      >
        <div className="mt-5">
          {presetsLoading ? (
            <p
              className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground"
              role="status"
            >
              Loading presets…
            </p>
          ) : presets.length ? (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {presets.map((preset) => (
                <div
                  className="flex items-center justify-between gap-3 px-4 py-3"
                  key={preset.id}
                >
                  <button
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                    onClick={() => {
                      applyPreset(preset);
                      setPresetsOpen(false);
                    }}
                    type="button"
                  >
                    {preset.name}
                  </button>
                  {canManage ? (
                    <Button
                      aria-label={`Delete ${preset.name}`}
                      onClick={() => {
                        setPresetsOpen(false);
                        setDeletePresetTarget(preset);
                      }}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No saved presets for this collection.
            </p>
          )}
          {canManage ? (
            <div className="mt-5 border-t border-border pt-5">
              <label className="text-sm font-medium">
                Save current search
                <Input
                  className="mt-2"
                  maxLength={100}
                  onChange={(event) => setPresetName(event.target.value)}
                  placeholder="Preset name"
                  value={presetName}
                />
              </label>
              <div className="mt-4 flex justify-end">
                <Button
                  disabled={!presetName.trim() || presetSaving}
                  onClick={() => void savePreset()}
                  type="button"
                >
                  {presetSaving ? 'Saving…' : 'Save preset'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </DialogFrame>

      <ConfirmDialog
        busy={deletePresetBusy}
        confirmLabel="Delete preset"
        description={
          deletePresetTarget
            ? `Delete “${deletePresetTarget.name}”? Saved settings will be removed, but the collection and search data will not change.`
            : ''
        }
        onConfirm={() =>
          deletePresetTarget ? deletePreset(deletePresetTarget) : undefined
        }
        onOpenChange={(open) => {
          if (!open && !deletePresetBusy) setDeletePresetTarget(null);
        }}
        open={Boolean(deletePresetTarget)}
        title="Delete search preset?"
        variant="destructive"
      />
    </>
  );
}
