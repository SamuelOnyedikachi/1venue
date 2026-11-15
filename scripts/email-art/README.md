# Email art

Sources for the PNGs in `public/email/` used by the transactional emails
(`src/features/mail/templates.js`). The laptop's video tiles use real Unsplash photos from
`photos/` (see [CREDITS.md](CREDITS.md)); everything else is drawn in HTML/CSS/SVG.

| Source | Output | Display size |
| --- | --- | --- |
| `hero.html` | `hero.png` (laptop with slides, video tiles and analytics popping off the screen) | 250×188 |
| `mark.html` | `mark.png` (site icon on a white tile, so it stays visible in dark mode) | 40×40 |
| `people.html` | `people.png` (brand card art) | 150×104 |
| `i-*.html` | `i-link.png`, `i-time.png`, `i-shield.png`, `i-lock.png` | 40×40 |

The `mark.html` and `hero.html` files embed the path from `public/brand/logo.svg`. If the logo
changes, paste the new path in. Render at 2x and compress (keep `hero.png` under 150 KB, the rest under 200 KB). Add
`--virtual-time-budget=3000` so the photos load before the screenshot:

```sh
google-chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 \
  --default-background-color=00000000 --window-size=520,392 \
  --screenshot=hero.png scripts/email-art/hero.html
pngquant --quality=70-90 --speed 1 --force --output public/email/hero.png hero.png
```

Window sizes: hero 520×392, mark 44×44, people 150×104, icons 40×40.
Emails load the images from `MAIL_ASSET_URL` (default: `PUBLIC_URL` when https, else
`https://1venue.live`), so a new image is live after the next deploy.

After changing any PNG, bump `ASSET_V` in `src/features/mail/templates.js` so mail clients and
image proxies fetch the new file (URLs end in `?v=<ASSET_V>`).

Decorative art (laptop, icons, brand card) is drawn as a CSS background on an empty block, not
an `<img>`, so it can't be clicked, opened or downloaded from Gmail's hover overlay. Outlook for
Windows gets the same image through VML. Only the logo is an `<img>` (it links to the site).
