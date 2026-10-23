import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const reportPaths = process.argv.slice(2);
if (!reportPaths.length) {
  throw new Error('Pass at least one Trivy JSON report');
}

const images = [];

for (const reportPath of reportPaths) {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const findings = (report.Results ?? []).flatMap(
    (result) => result.Vulnerabilities ?? [],
  );
  const blocking = findings.filter(
    (finding) =>
      ['HIGH', 'CRITICAL'].includes(finding.Severity) &&
      Boolean(finding.FixedVersion),
  );

  images.push({
    image: report.ArtifactName,
    imageId: report.Metadata?.ImageID ?? null,
    scannedAt: report.CreatedAt,
    report: path.basename(reportPath),
    totalFindings: findings.length,
    fixableHigh: blocking.filter((finding) => finding.Severity === 'HIGH')
      .length,
    fixableCritical: blocking.filter(
      (finding) => finding.Severity === 'CRITICAL',
    ).length,
  });
}

const summary = {
  policy:
    'Fail when Trivy reports a HIGH or CRITICAL vulnerability with a fixed version',
  images,
};
const summaryPath = path.join(
  path.dirname(reportPaths[0]),
  'image-scan-summary.json',
);
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

for (const image of images) {
  console.log(
    `${image.image}: ${image.fixableCritical} fixable CRITICAL, ${image.fixableHigh} fixable HIGH`,
  );
}

if (
  images.some((image) => image.fixableCritical > 0 || image.fixableHigh > 0)
) {
  console.error(`Image vulnerability gate failed; summary: ${summaryPath}`);
  process.exitCode = 1;
}
