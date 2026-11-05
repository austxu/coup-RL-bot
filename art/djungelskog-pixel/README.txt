Djungelskog Pixel animations

Original animation assets, copied without changing the artwork.

Start with all-states.gif or all-states.mp4 to see the animations.
look-loop.gif shows the directional poses; idle-jump-idle.gif shows the jump sequence.
spritesheets/ contains PNG sprite sheets. The extended sheet includes the directional poses.
frames/ contains separate PNG frames grouped by action; play the numbered files in ascending order.
still-*.png files are representative still frames.

---
Copied into this repo from the artist's export. frames/look/ was cut from
spritesheets/spritesheet-extended.png rows 9-10 (16 head poses: 00 looks up,
then clockwise from the viewer: 04 right, 08 down, 12 left).
tools/build_bear_atlas.py packs the frames the web app uses into one WebP atlas.
