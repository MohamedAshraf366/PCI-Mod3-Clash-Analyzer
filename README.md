# LTE PCI Mod3 Clash Analyzer

Import an LTE site table, map sectors, detect PCI and Mod3 clashes between
neighbouring cells, and export a solved PCI re-plan as CSV or PDF.

Built with [Next.js](https://nextjs.org) (App Router), React 19, Tailwind CSS
v4, and Leaflet. The heavy clash-detection and PCI re-planning computation
runs off the main thread in a Web Worker, so the UI stays responsive even on
large site tables.

## Development

You need Node.js 18.18+ and npm.

```sh
npm install
npm run dev
```

Open http://localhost:3000.

## Build

```sh
npm run build
npm start
```

## Deploying to Vercel

This is a standard Next.js app, so it deploys to [Vercel](https://vercel.com)
with no extra configuration:

1. Push this repository to GitHub/GitLab/Bitbucket.
2. Import the repository in the Vercel dashboard (or run `vercel` from the
   project root with the Vercel CLI).
3. Vercel auto-detects Next.js and uses `npm run build` / `.next` — no build
   settings need to change.
4. Optionally set the `SITE_URL` environment variable (e.g.
   `https://your-app.vercel.app` or your custom domain) in the Vercel project
   settings so `/sitemap.xml` emits absolute URLs.

## Project structure

- `app/` — Next.js App Router routes, layout, metadata, sitemap.
- `src/components/home-client.tsx` — the main application UI (client
  component).
- `src/components/ClashMap.tsx` — the Leaflet map.
- `src/lib/mod3.ts` — core clash-detection / PCI re-plan algorithms.
- `src/lib/clash-worker.ts` + `src/hooks/use-clash-worker.ts` — runs the
  algorithms above in a Web Worker.
- `src/lib/read-table-file.ts` — CSV/TSV/XLSX site-table parsing.
