# Character avatars

The 30 approved transparent portraits are bundled at 32, 64, 256 and 512 pixels
in the review order maintained by `src/lib/character-avatars.ts`. Original
`<id>.png` files remain the byte-identical canonical 64px persistence images.
`<id>-32.png`, `<id>-256.webp` and `<id>-512.webp` are display-only variants
resized from the originals, not upscaled from 64px; WebP is lossless.

`characterAvatarSources` chooses the smallest variant covering the CSS size:
32px for ≤32, 64px for ≤64, 256px for ≤256, otherwise 512px. Width-descriptor
`srcSet` plus the exact CSS width lets Chromium cover Retina density (e.g. a
64 CSS px preview uses the 256px source at DPR 2). Display files are explicit
Vite URL imports with `no-inline`; the large images do not inflate JavaScript.

Only exact canonical-image matches are upgraded, preserving picked identity even
when the profile name changes. Custom uploads, generated images and pets are
never substituted based on dimensions. The picker still stores an inline 64px
PNG through `profiles.set_asset`, not a build-specific URL. Defaults and reset
remain deterministic and shared by Bot and Profile. No runtime dependency on
source scratch files or new backend contract.

BotFace supplies its existing numeric `size`; AvatarPicker supplies 40px.
ProfileGlyph defaults to 16px; callers overriding its CSS dimensions must also
pass `size` (the 12px dropdown and 14px sidebar leads do so). No geometry changes.

The flower-wreath portrait's original attribution is unverified. Its label is
intentionally neutral: “戴花环的女子” / “Woman with a Floral Hat”.
