import type { Metadata } from 'next';
import Script from 'next/script';
import type { ReactNode } from 'react';

import { ThemeProvider } from '../components/theme-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Indexlume',
  description: 'Built for developers. Designed for simplicity. Ready to scale.',
  icons: {
    icon: '/brand/indexlume-logo.svg',
  },
};

const themeScript = `
  (() => {
    try {
      const saved = localStorage.getItem('osc-theme');
      const preference = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
      const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.dataset.theme = preference;
    } catch {}
  })();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        <Script
          dangerouslySetInnerHTML={{ __html: themeScript }}
          id="theme-initializer"
          strategy="beforeInteractive"
        />
      </body>
    </html>
  );
}
