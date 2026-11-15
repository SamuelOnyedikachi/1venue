# Credits

## Homepage hero collage

The homepage hero visual is a user-supplied product collage (a live stage, Q4 goals,
a poll, a John 3:16 card, and reaction bubbles). The shipped files under
`public/img/hero/` are a cutout of that image with a real transparent background
(the source JPEG had a fake checkerboard and gradient blobs, which were removed).
A soft drop shadow was re-rendered on the alpha channel.

| File | Notes |
| --- | --- |
| `public/img/hero/collage.webp` | Transparent WebP, 1168×742 (2× for the desktop hero column). |
| `public/img/hero/collage-sm.webp` | Transparent WebP, 640×407, used via `srcset` on smaller viewports. |

Seed avatars and event covers elsewhere in the app are hot-linked from Unsplash;
see `src/features/seed/fixtures.js`.
