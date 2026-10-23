import { ProjectionWizard } from '../../../../../components/features/projection-wizard';

export default async function NewProjectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ sourceId: string }>;
  searchParams: Promise<{ project?: string }>;
}) {
  const [{ sourceId }, query] = await Promise.all([params, searchParams]);
  return (
    <ProjectionWizard projectId={query.project ?? ''} sourceId={sourceId} />
  );
}
