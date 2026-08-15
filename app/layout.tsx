import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");

export const metadata: Metadata = {
  ...(SITE_URL ? { metadataBase: new URL(SITE_URL) } : {}),
  title: "PCI Mod3 Clash Analyzer",
  description: "Detect LTE PCI and Mod3 clashes from a site table and export a solved PCI re-plan.",
  authors: [{ name: "Mohamed Ashraf" }],
  robots: "index, follow",
  openGraph: {
    title: "PCI Mod3 Clash Analyzer",
    description:
      "Detect LTE PCI and Mod3 clashes from a site table and export a solved PCI re-plan.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
