# Email art

Sources for the PNGs in `public/email/` used by the transactional emails
(`src/features/mail/templates.js`). Everything is illustrated: no photos.

| Source | Output | Display size |
| --- | --- | --- |
| `hero.html` | `hero.png` (laptop with slides, video tiles and analytics popping off the screen) | 250×188 |
| `mark.html` | `mark.png` (site icon on a white tile, so it stays visible in dark mode) | 40×40 |
| `people.html` | `people.png` (brand card art) | 150×104 |
| `i-*.html` | `i-link.png`, `i-time.png`, `i-shield.png`, `i-lock.png` | 40×40 |

The `mark.html` and `hero.html` files embed the path from `public/brand/logo.svg`. If the logo
changes, paste the new path in. Render at 2x and compress (keep each file under 200 KB):

```sh
google-chrome --headless=new --hide-scrollbars --force-device-scale-factor=2 \
  --default-background-color=00000000 --window-size=520,392 \
  --screenshot=hero.png scripts/email-art/hero.html
pngquant --quality=80-95 --speed 1 --force --output public/email/hero.png hero.png
```

Window sizes: hero 520×392, mark 44×44, people 150×104, icons 40×40.
Emails load the images from `MAIL_ASSET_URL` (default: `PUBLIC_URL` when https, else
`https://1venue.live`), so a new image is live after the next deploy.
