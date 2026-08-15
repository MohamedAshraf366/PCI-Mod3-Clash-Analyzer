import type { Metadata } from "next";
import HomeClient from "@/components/home-client";

export const metadata: Metadata = {
  title: "LTE PCI Mod3 Clash Analyzer — Map & Solve PCI Conflicts",
  description:
    "Import an LTE site table, map sectors, detect PCI and Mod3 clashes between neighbouring cells, and export a solved PCI re-plan as CSV or PDF.",
  keywords: [
    "LTE",
    "PCI planning",
    "Mod3 clash",
    "PCI conflict",
    "RF optimization",
    "sector map",
    "4G",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    title: "LTE PCI Mod3 Clash Analyzer",
    description:
      "Map LTE sectors from a site table, detect PCI modulo 3 clashes that cause CRS interference, and export a solved plan.",
    type: "website",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "LTE PCI Mod3 Clash Analyzer",
    description: "Detect and solve LTE PCI Mod3 clashes straight from your site table.",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "LTE PCI Mod3 Clash Analyzer",
  applicationCategory: "EngineeringApplication",
  operatingSystem: "Web",
  description:
    "Map LTE sectors, detect PCI and Mod3 clashes between neighbouring cells and export a solved PCI re-plan.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <HomeClient />
    </>
  );
}
