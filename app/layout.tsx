import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Akawo Fintech Savings MVP",
  description: "Personal locked savings and group rotational contribution pool."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <nav className="topnav">
          <Link href="/">Home</Link>
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/groups">Groups</Link>
          <Link href="/admin">Admin Revenue</Link>
        </nav>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
