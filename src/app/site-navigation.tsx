'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navigationLinks = [
  { href: '/', label: 'Home' },
  { href: '/search', label: 'Search' },
  { href: '/watchlist', label: 'Watchlists' },
  { href: '/settings/calendar', label: 'Calendar' },
];

export default function SiteNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main navigation" className="site-navigation">
      {navigationLinks.map(({ href, label }) => {
        const isCurrent = pathname === href ||
          (href !== '/' && pathname.startsWith(`${href}/`));

        return (
          <Link key={href} href={href} aria-current={isCurrent ? 'page' : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
