import './globals.css';

export const metadata = {
  title: 'SplitSmart | Shared expenses, sorted',
  description: 'Track shared expenses, split bills fairly, and settle up with your group.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
