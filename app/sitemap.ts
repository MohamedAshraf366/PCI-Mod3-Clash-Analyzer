import type { MetadataRoute } from "next";

// Set SITE_URL in your Vercel project's Environment Variables (e.g.
// https://your-app.vercel.app or your custom domain) so this sitemap emits
// absolute URLs, which is required by the sitemap protocol.
const BASE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${BASE_URL}/`,
      changeFrequency: "weekly",
      priority: 1.0,
      lastModified: new Date(),
    },
  ];
}
