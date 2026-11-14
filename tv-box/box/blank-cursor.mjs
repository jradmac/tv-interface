// Writes an invisible mouse-pointer theme, so no pointer ever shows on the TV.
// Usage: node blank-cursor.mjs /usr/share/icons/tv-blank
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '/usr/share/icons/tv-blank';
const cursors = path.join(dir, 'cursors');
fs.mkdirSync(cursors, { recursive: true });

// One fully transparent 1x1 Xcursor image.
const b = Buffer.alloc(16 + 12 + 36 + 4);
let o = 0;
const u32 = (v) => { b.writeUInt32LE(v >>> 0, o); o += 4; };
b.write('Xcur', 0, 'ascii'); o = 4;
u32(16); u32(0x10000); u32(1);              // header: size, version, 1 table entry
u32(0xfffd0002); u32(24); u32(28);          // table: image, nominal size, position
u32(36); u32(0xfffd0002); u32(24); u32(1);  // image header: size, type, size, version
u32(1); u32(1); u32(0); u32(0); u32(0);     // width, height, hotspot x/y, delay
u32(0);                                     // one transparent pixel
fs.writeFileSync(path.join(cursors, 'left_ptr'), b);

const names = `default arrow top_left_arrow pointer hand hand1 hand2 pointing_hand openhand closedhand grab grabbing
text xterm ibeam vertical-text wait watch progress left_ptr_watch half-busy crosshair cross tcross move fleur
all-scroll size_all not-allowed no-drop forbidden crossed_circle dnd-none dnd-move dnd-copy dnd-link dnd-ask
help question_arrow whats_this context-menu cell plus alias copy link col-resize row-resize split_h split_v
n-resize s-resize e-resize w-resize ne-resize nw-resize se-resize sw-resize ew-resize ns-resize nesw-resize nwse-resize
sb_h_double_arrow sb_v_double_arrow h_double_arrow v_double_arrow size_hor size_ver size_bdiag size_fdiag
top_side bottom_side left_side right_side top_left_corner top_right_corner bottom_left_corner bottom_right_corner
zoom-in zoom-out X_cursor x-cursor pirate up_arrow center_ptr right_ptr draft_large draft_small icon target
00008160000006810000408080010102 03b6e0fcb3499374a867c041f52298f0 1081e37283d90000800003c07f3ef6bf
3085a0e285430894940527032f8b26df 4498f0e0c1937ffe01fd06f973665830 9081237383d90e509aa00f00170e968f
e29285e634086352946a0e7090d73106 fcf21c00b30f7e3f83fe0dfd12e71cff`.split(/\s+/).filter(Boolean);
for (const n of names) {
  const p = path.join(cursors, n);
  try { fs.unlinkSync(p); } catch {}
  fs.symlinkSync('left_ptr', p);
}
fs.writeFileSync(path.join(dir, 'index.theme'), '[Icon Theme]\nName=tv-blank\nComment=No visible pointer\n');
fs.writeFileSync(path.join(dir, 'cursor.theme'), '[Icon Theme]\nName=tv-blank\n');
console.log('invisible pointer theme written to', dir);
