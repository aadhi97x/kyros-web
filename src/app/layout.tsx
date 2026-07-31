import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Kyros — club & academy platform',
  description:
    'Run your football club or academy: enrollment, batches, attendance, payments and turf bookings.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
