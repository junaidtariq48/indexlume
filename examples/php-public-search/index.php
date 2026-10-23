<?php

declare(strict_types=1);

$baseUrl = rtrim((string) getenv('OSC_BASE_URL'), '/');
$projectPublicId = (string) getenv('OSC_PROJECT_PUBLIC_ID');
$searchKey = (string) getenv('OSC_SEARCH_KEY');
$indexSlug = $argv[1] ?? 'products';
$query = $argv[2] ?? 'keyboard';

if ($baseUrl === '' || $projectPublicId === '' || $searchKey === '') {
    fwrite(STDERR, "Set OSC_BASE_URL, OSC_PROJECT_PUBLIC_ID and OSC_SEARCH_KEY.\n");
    exit(1);
}

$url = sprintf(
    '%s/api/v1/search/v1/%s/%s',
    $baseUrl,
    rawurlencode($projectPublicId),
    rawurlencode($indexSlug),
);
$handle = curl_init($url);
curl_setopt_array($handle, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Authorization: Bearer ' . $searchKey,
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS => json_encode(['q' => $query, 'page' => 1, 'perPage' => 10], JSON_THROW_ON_ERROR),
    CURLOPT_TIMEOUT => 10,
]);
$body = curl_exec($handle);
$status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
if ($body === false || $status < 200 || $status >= 300) {
    fwrite(STDERR, sprintf("Search failed (%d): %s\n", $status, $body ?: curl_error($handle)));
    curl_close($handle);
    exit(1);
}
curl_close($handle);

echo json_encode(json_decode($body, true, 512, JSON_THROW_ON_ERROR), JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), "\n";
