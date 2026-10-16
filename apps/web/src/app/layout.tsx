import type { Metadata, Viewport } from 'next';
import { Anton, Schibsted_Grotesk } from 'next/font/google';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site-header';
import { ToastProvider } from '@/components/ui/toast';
import { getCities, type City } from '@/lib/catalog';
import { CITY_COOKIE_NAME } from '@/lib/city';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/site';
import './globals.css';

const body = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-body', display: 'swap' });
const marquee = Anton({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-marquee',
  display: 'swap',
});

export const metadata: Metadata = {
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
};

/** The header still renders when the API is down; the page itself shows the error. */
async function headerCities(): Promise<City[]> {
  try {
    return await getCities();
  } catch {
    return [];
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [cities, jar] = await Promise.all([headerCities(), cookies()]);

  return (
    <html lang="en-IN" className={`${body.variable} ${marquee.variable}`}>
      <body className="min-h-dvh bg-surface font-sans text-ink antialiased">
        <ToastProvider>
          <SiteHeader
            cities={cities.map(({ slug, name }) => ({ slug, name }))}
            rememberedCity={jar.get(CITY_COOKIE_NAME)?.value}
          />
          <main className="pb-20">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
