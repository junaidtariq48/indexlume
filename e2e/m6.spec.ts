import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('m1-owner@example.test');
  await page.getByLabel('Password').fill('m1-owner-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Overview' }),
  ).toBeVisible();
}

async function selectProject(page: Page, label: string) {
  if ((page.viewportSize()?.width ?? 1280) < 1024) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const navigation = page.getByRole('dialog', { name: 'Navigation' });
    await navigation
      .getByRole('button', { name: /Switch workspace or project/ })
      .click();
  } else {
    await page
      .locator('aside')
      .getByRole('button', { name: /Switch workspace or project/ })
      .click();
  }
  const picker = page.getByRole('dialog', {
    name: 'Select workspace and project',
  });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: new RegExp(label) }).click();
  await expect(picker).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await selectProject(page, 'M5 Isolated');
});

test('major analytics, Search Studio, and audit journeys', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-320', 'Desktop journey');

  await page.getByRole('button', { name: 'Analytics' }).click();
  await expect(page).toHaveURL(/view=analytics/);
  await expect(
    page.getByRole('heading', { name: 'Search analytics' }),
  ).toBeVisible();
  await expect(
    page.getByText('Raw query terms and top-query analytics'),
  ).toBeVisible();
  await expect(
    page.getByText('Requests', { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Live request traffic' }),
  ).toBeVisible();
  await expect(page.getByText('Last 30 minutes')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh now' })).toBeVisible();
  await expect(page.getByRole('radio', { name: '5s' })).toBeChecked();
  await page.getByText('2s', { exact: true }).click();
  await expect(page.getByRole('radio', { name: '2s' })).toBeChecked();
  await page.getByText('30d', { exact: true }).click();
  await expect(page.getByRole('radio', { name: '30d' })).toBeChecked();
  await expect(page.getByText('Last 30 days')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Latency estimates' }),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/view=analytics/);
  await expect(
    page.getByRole('heading', { name: 'Search analytics' }),
  ).toBeVisible();

  await page.keyboard.press('Control+K');
  const navigationSearch = page.getByRole('dialog', { name: 'Navigate' });
  await expect(navigationSearch).toBeVisible();
  await navigationSearch.getByRole('button', { name: /Search Studio/ }).click();
  await expect(page).toHaveURL(/view=search/);
  await page.goBack();
  await expect(page).toHaveURL(/view=analytics/);
  await expect(
    page.getByRole('heading', { name: 'Search analytics' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Search Studio' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Search Studio' }),
  ).toBeVisible();
  await page.getByLabel('Query').fill('keyboard');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText(/^\d+ results · \d+ ms$/)).toBeVisible();

  const presetName = `Browser preset ${Date.now()}`;
  await page.getByRole('button', { name: /Presets/ }).click();
  await page.getByPlaceholder('Preset name').fill(presetName);
  await page.getByRole('button', { name: 'Save preset' }).click();
  await expect(page.getByRole('status')).toContainText('Search preset saved');
  await expect(
    page.getByRole('button', { name: presetName, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: `Delete ${presetName}` }).click();
  const deleteDialog = page.getByRole('dialog', {
    name: 'Delete search preset?',
  });
  await expect(deleteDialog).toContainText(presetName);
  await deleteDialog.getByRole('button', { name: 'Delete preset' }).click();
  await expect(deleteDialog).toBeHidden();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Project' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Members' }).click();
  await expect(
    page.getByRole('heading', { name: 'Workspace members' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add member' }).click();
  const memberDialog = page.getByRole('dialog', {
    name: 'Add workspace member',
  });
  await memberDialog.getByRole('combobox', { name: 'Member role' }).click();
  await expect(page.getByRole('option', { name: /Admin/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Editor/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Viewer/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await memberDialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(
    page.getByRole('heading', { name: 'Audit trail' }),
  ).toBeVisible();
  await expect(page.getByText('search preset · created').first()).toBeVisible();
});

test('indexing jobs use a list and selected detail', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-320', 'Desktop journey');

  await page.getByRole('button', { name: 'Indexing Jobs' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Indexing Jobs' }),
  ).toBeVisible();
  const history = page.getByRole('heading', { name: 'Job history' });
  const empty = page.getByRole('heading', { name: /^No .* jobs$/ });
  await expect(history.or(empty)).toBeVisible();
  if (await history.isVisible()) {
    await expect(
      page.getByRole('heading', { name: 'Job details' }),
    ).toBeVisible();
    await expect(page.getByText('Recorded errors')).toBeVisible();
  } else {
    await expect(empty).toBeVisible();
  }
});

test('scope picker replaces duplicated overview project controls', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-320', 'Desktop journey');

  await page.getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByText('Project overview')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Setup path' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('heading', { name: 'Projects' })).toHaveCount(0);

  const trigger = page
    .locator('aside')
    .getByRole('button', { name: /Switch workspace or project/ });
  await trigger.click();
  const picker = page.getByRole('dialog', {
    name: 'Select workspace and project',
  });
  await expect(picker).toContainText('M1 Workspace');
  await expect(picker).toContainText('M5 Isolated');
  await picker.getByRole('button', { name: 'Create project' }).click();
  const create = page.getByRole('dialog', { name: 'Create project' });
  await expect(create).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(create).toBeHidden();
});

test('keyboard tabs, validation, dialog focus, and theme persistence', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-320', 'Desktop journey');

  await page.getByRole('button', { name: 'Search Studio' }).click();
  await page.getByRole('button', { name: 'Search options' }).click();
  const searchFields = page.getByRole('group', { name: 'Search fields' });
  const checkedFields = searchFields.locator('input:checked');
  while ((await checkedFields.count()) > 0) {
    await checkedFields.first().uncheck();
  }
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(
    page.getByText('Select at least one searchable field.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const projectTab = page.getByRole('tab', { name: 'Project' });
  await projectTab.focus();
  await projectTab.press('ArrowRight');
  const connectionTab = page.getByRole('tab', { name: 'Connections' });
  await expect(connectionTab).toHaveAttribute('aria-selected', 'true');
  await expect(connectionTab).toBeFocused();

  await page.getByRole('tab', { name: 'API keys' }).click();
  const createKey = page.getByRole('button', { name: 'Create key' });
  await createKey.click();
  await expect(
    page.getByRole('dialog', { name: 'Create search API key' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Create search API key' }),
  ).toBeHidden();
  await expect(createKey).toBeFocused();

  const themeToggle = page.getByRole('button', { name: /Theme:/ }).first();
  await themeToggle.click();
  const preference = await page.evaluate(() =>
    localStorage.getItem('osc-theme'),
  );
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('osc-theme')))
    .toBe(preference);
});

test('data source setup protects unsaved changes', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-320', 'Desktop journey');

  await page.getByRole('button', { name: 'Data Sources' }).click();
  await page.getByRole('button', { name: 'Add data source' }).click();
  await page.getByRole('button', { name: 'Upload a file' }).click();
  await page.getByLabel('Source name').fill('Unsaved source');
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: 'Discard source setup?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Upload file source' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await discard.getByRole('button', { name: 'Discard changes' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Upload file source' }),
  ).toBeHidden();
});

test('every shared popup exposes an accessible close control', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-320', 'Desktop journey');
  await page.getByRole('button', { name: 'Data Sources' }).click();
  await page.getByRole('button', { name: 'Add data source' }).click();
  const addSource = page.getByRole('dialog', { name: 'Add data source' });
  await expect(addSource).toBeVisible();
  await addSource
    .getByRole('button', { name: 'Close Add data source' })
    .click();
  await expect(addSource).toBeHidden();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'API keys' }).click();
  await page.getByRole('button', { name: 'Create key' }).click();
  const createKey = page.getByRole('dialog', {
    name: 'Create search API key',
  });
  await expect(createKey).toBeVisible();
  await createKey
    .getByRole('button', { name: 'Close Create search API key' })
    .click();
  await expect(createKey).toBeHidden();
});

test('320px navigation works by keyboard without horizontal overflow', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-320', 'Mobile journey');

  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.press('Enter');
  const navigation = page.getByRole('dialog', { name: 'Navigation' });
  await expect(navigation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.press('Enter');
  await page.getByRole('button', { name: 'Analytics' }).click();
  await expect(page).toHaveURL(/view=analytics/);
  await expect(
    page.getByRole('heading', { name: 'Search analytics' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
