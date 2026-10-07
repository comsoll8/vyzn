#!/usr/bin/env python3
"""Generates VYZN's built-in profile avatars (public/assets/avatars/*.svg and
manifest.json). Obsidian tile + neon gradient glow + a clean off-white glyph,
matching the VYZN mark. Re-run to regenerate: python3 tools/gen-avatars.py"""
import json, os
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'avatars')
W, A = '#F5F5F7', 'rgba(245,245,247,0.55)'
PAL = {
 'aurora': ('#00E5FF', '#7C4DFF'), 'sunset': ('#FF8A65', '#E040FB'), 'mint': ('#69F0AE', '#00B8D4'),
 'rose': ('#FF4081', '#FF9100'), 'ice': ('#B3E5FC', '#536DFE'), 'lime': ('#C6FF00', '#00E676'),
 'ember': ('#FF5252', '#FFB300'), 'orchid': ('#EA80FC', '#448AFF'),
}
def tile(pal, glyph, gid):
    a, b = PAL[pal]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<defs>
<linearGradient id="g{gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>
<radialGradient id="r{gid}" cx="0.5" cy="0.42" r="0.6"><stop offset="0" stop-color="{a}" stop-opacity="0.55"/><stop offset="1" stop-color="{b}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="256" height="256" rx="64" fill="#0C0C0E"/>
<rect width="256" height="256" rx="64" fill="url(#r{gid})"/>
<rect x="2" y="2" width="252" height="252" rx="62" fill="none" stroke="url(#g{gid})" stroke-opacity="0.55" stroke-width="3"/>
<g fill="none" stroke="{W}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">{glyph}</g>
</svg>'''
def eyes(y=118, dx=26, r=7): return f'<g fill="{W}" stroke="none"><circle cx="{128-dx}" cy="{y}" r="{r}"/><circle cx="{128+dx}" cy="{y}" r="{r}"/></g>'
G = {
 'vyzn':   ('aurora', f'<path d="M72 78 L128 180 L184 78" opacity=".4"/><path d="M88 78 L128 154 L168 78" stroke-width="13"/><line x1="104" y1="108" x2="152" y2="108" opacity=".8"/>'),
 'astro':  ('ice', f'<circle cx="128" cy="124" r="62"/><rect x="92" y="104" width="72" height="42" rx="21" fill="rgba(0,0,0,.45)"/><path d="M104 118 q8 -8 18 -6" opacity=".7"/><path d="M96 190 h64" />'),
 'robot':  ('mint', f'<rect x="76" y="92" width="104" height="82" rx="22"/><line x1="128" y1="92" x2="128" y2="68"/><circle cx="128" cy="62" r="6" fill="{W}"/>{eyes(130,24,8)}<path d="M108 154 h40"/>'),
 'ghost':  ('orchid', f'<path d="M80 176 V122 a48 48 0 0 1 96 0 V176 l-16 -14 -16 14 -16 -14 -16 14 -16 -14z"/>{eyes(122,20,7)}'),
 'alien':  ('lime', f'<path d="M128 70 c-44 0 -58 40 -50 70 c8 30 30 42 50 42 s42 -12 50 -42 c8 -30 -6 -70 -50 -70z"/><g fill="{W}" stroke="none"><ellipse cx="104" cy="128" rx="13" ry="8" transform="rotate(20 104 128)"/><ellipse cx="152" cy="128" rx="13" ry="8" transform="rotate(-20 152 128)"/></g>'),
 'cat':    ('sunset', f'<path d="M76 98 L84 62 L110 84 Q128 80 146 84 L172 62 L180 98 Q192 122 180 148 Q164 182 128 182 Q92 182 76 148 Q64 122 76 98z"/>{eyes(122,26,6)}<path d="M120 142 l8 6 8 -6"/><path d="M52 138 l24 4 M52 156 l24 -4 M204 138 l-24 4 M204 156 l-24 -4" opacity=".5" stroke-width="6"/>'),
 'fox':    ('ember', f'<path d="M64 72 L106 98 Q128 92 150 98 L192 72 L186 132 Q176 182 128 190 Q80 182 70 132z"/>{eyes(128,26,6)}<path d="M116 160 l12 10 l12 -10"/>'),
 'bear':   ('rose', f'<circle cx="84" cy="88" r="20"/><circle cx="172" cy="88" r="20"/><circle cx="128" cy="130" r="56"/>{eyes(122,24,6)}<ellipse cx="128" cy="144" rx="14" ry="10"/>'),
 'owl':    ('aurora', f'<path d="M78 80 L104 98 H152 L178 80 V150 Q178 188 128 188 Q78 188 78 150z"/><circle cx="108" cy="124" r="15"/><circle cx="148" cy="124" r="15"/><g fill="{W}" stroke="none"><circle cx="108" cy="124" r="5"/><circle cx="148" cy="124" r="5"/></g><path d="M122 142 l6 10 l6 -10"/>'),
 'popcorn':('ember', f'<path d="M86 118 L98 192 H158 L170 118z"/><path d="M104 118 l6 74 M128 118 v74 M152 118 l-6 74" opacity=".5" stroke-width="6"/><path d="M84 118 q-8 -22 14 -26 q4 -22 28 -12 q22 -14 32 8 q22 2 14 30" />'),
 'clap':   ('orchid', f'<rect x="72" y="106" width="112" height="76" rx="10"/><path d="M72 106 L184 106 L172 70 L64 78z"/><path d="M92 76 l12 28 M120 74 l12 30 M148 72 l12 32" opacity=".6" stroke-width="7"/>'),
 'phones': ('mint', f'<path d="M80 150 V126 a48 48 0 0 1 96 0 V150"/><rect x="68" y="142" width="26" height="46" rx="12"/><rect x="162" y="142" width="26" height="46" rx="12"/>'),
 'planet': ('ice', f'<circle cx="128" cy="128" r="40"/><ellipse cx="128" cy="130" rx="76" ry="22" transform="rotate(-22 128 130)" opacity=".75"/>'),
 'bolt':   ('lime', f'<path d="M142 62 L88 142 H124 L112 196 L170 112 H132z" fill="rgba(245,245,247,.15)"/>'),
 'moon':   ('orchid', f'<path d="M154 70 a62 62 0 1 0 38 98 a50 50 0 0 1 -38 -98z"/><path d="M178 84 v18 M169 93 h18" stroke-width="6"/><circle cx="108" cy="188" r="3" fill="{W}"/>'),
 'rocket': ('sunset', f'<path d="M128 62 Q164 92 160 144 H96 Q92 92 128 62z"/><circle cx="128" cy="108" r="13"/><path d="M96 130 L72 160 L98 154 M160 130 L184 160 L158 154"/><path d="M116 164 q12 28 24 0" opacity=".7"/>'),
 'shades': ('rose', f'<path d="M62 112 H194"/><rect x="68" y="108" width="52" height="38" rx="14" fill="rgba(0,0,0,.5)"/><rect x="136" y="108" width="52" height="38" rx="14" fill="rgba(0,0,0,.5)"/><path d="M104 168 q24 16 48 0"/>'),
 'crown':  ('ember', f'<path d="M68 172 L60 98 L98 128 L128 80 L158 128 L196 98 L188 172z"/><path d="M70 190 H186"/>'),
 'glasses3d':('aurora', f'<rect x="58" y="104" width="68" height="48" rx="14" stroke="#FF5252"/><rect x="130" y="104" width="68" height="48" rx="14" stroke="#00E5FF"/><path d="M126 124 h4"/>'),
 'pad':    ('mint', f'<path d="M80 108 H176 Q200 108 204 148 Q206 176 188 176 Q172 176 164 160 H92 Q84 176 68 176 Q50 176 52 148 Q56 108 80 108z"/><path d="M92 128 v20 M82 138 h20"/><circle cx="160" cy="130" r="4" fill="{W}"/><circle cx="174" cy="142" r="4" fill="{W}"/>'),
 'eye':    ('orchid', f'<path d="M54 128 Q128 62 202 128 Q128 194 54 128z"/><circle cx="128" cy="128" r="22"/><circle cx="128" cy="128" r="7" fill="{W}"/>'),
 'wave':   ('ice', f'<path d="M58 128 q17 -48 35 0 t35 0 t35 0 t35 0"/><path d="M58 158 q17 -30 35 0 t35 0 t35 0 t35 0" opacity=".45"/>'),
 'gem':    ('rose', f'<path d="M92 90 H164 L194 124 L128 192 L62 124z"/><path d="M62 124 H194 M92 90 L110 124 L128 192 M164 90 L146 124 L128 192 M110 124 L128 90 L146 124" opacity=".55" stroke-width="6"/>'),
 'flame':  ('ember', f'<path d="M128 62 C132 96 176 112 170 150 C166 180 146 192 128 192 C108 192 88 178 88 152 C88 128 108 122 112 98 C122 108 124 92 128 62z"/><path d="M128 190 C112 184 110 160 128 146 C146 160 144 184 128 190z" opacity=".6" stroke-width="6"/>'),
 'ninja':  ('lime', f'<circle cx="128" cy="128" r="58"/><path d="M72 112 H184 V138 H72z" fill="rgba(0,0,0,.5)"/>{eyes(125,22,7)}<path d="M184 112 l24 -14 M184 130 l20 14" opacity=".7"/>'),
}
os.makedirs(OUT, exist_ok=True)
names = []
for i, (name, (pal, glyph)) in enumerate(G.items()):
    open(os.path.join(OUT, name + '.svg'), 'w').write(tile(pal, glyph, i))
    names.append(name)
json.dump(names, open(os.path.join(OUT, 'manifest.json'), 'w'))
print(len(names), 'avatars')
