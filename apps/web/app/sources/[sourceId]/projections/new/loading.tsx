export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl p-6 lg:p-10">
      <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      <div className="mt-8 h-96 animate-pulse rounded-xl border border-border bg-card" />
    </main>
  );
}
