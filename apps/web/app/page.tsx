import { redirect } from 'next/navigation';

import { Dashboard } from '../components/dashboard';

export const dynamic = 'force-dynamic';

async function needsSetup(): Promise<boolean> {
  const baseUrl = process.env.INTERNAL_API_URL ?? 'http://localhost:3001';
  try {
    const response = await fetch(`${baseUrl}/api/v1/setup/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { needsSetup: boolean };
    return payload.needsSetup;
  } catch {
    return false;
  }
}

export default async function Home() {
  if (await needsSetup()) redirect('/setup');
  return <Dashboard />;
}
