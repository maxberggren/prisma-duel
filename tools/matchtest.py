#!/usr/bin/env python3
"""Play N bot-only matches headlessly and report how they went.

Always builds its harness from the CURRENT index.html — a stale copy of the
page silently reports the previous build's balance, which cost me two rounds.

usage: matchtest.py [matches] [maxTurns]
"""
import pathlib, subprocess, sys, tempfile, os, json

n    = int(sys.argv[1]) if len(sys.argv) > 1 else 8
maxT = int(sys.argv[2]) if len(sys.argv) > 2 else 80

probe = """
<script>
addEventListener('load', () => setTimeout(() => {
  const P = window.__prisma;
  document.getElementById('bSolo').click();
  const lens=[], causes={}, wins={}, firstKill=[];
  for (let m=0;m<%d;m++){
    P.newGame([{id:0,name:'A'},{id:1,name:'B'},{id:2,name:'C'},{id:3,name:'D'}], 8800+m*53, 0);
    P.G.bots = new Set([0,1,2,3]);
    let g=0, fk=null;
    while (P.G.phase!=='over' && g++<%d){
      if (P.G.phase==='plan') P.G.planEnds = performance.now()-1;
      P.gameFrame(1/60);
      if (P.G.phase==='resolve'){ let k=0; while(P.G.phase==='resolve'&&k++<400) P.gameFrame(1/60);
        if (fk===null && P.G.state.ships.some(s=>!s.alive)) fk = P.G.state.turn; }
    }
    lens.push(P.G.state.turn); firstKill.push(fk);
    for (const l of P.G.state.log) causes[l.cause] = (causes[l.cause]||0)+1;
    const w = P.G.winner ? P.G.winner.name : 'draw'; wins[w]=(wins[w]||0)+1;
  }
  const srt=[...lens].sort((a,b)=>a-b);
  document.title = JSON.stringify({ matchLengths:lens, median:srt[srt.length>>1],
    firstKill, allDecided: lens.every(l=>l<%d), deathCauses:causes, winners:wins });
}, 500));
</script>
""" % (n, maxT, maxT)

page = pathlib.Path('/home/max/Code/lazer/index.html').read_text().replace('</body>', probe + '</body>')
tmp = pathlib.Path(tempfile.gettempdir()) / ('match_%d.html' % os.getpid())
tmp.write_text(page)
r = subprocess.run(['chromium','--headless=new','--disable-gpu','--enable-unsafe-swiftshader',
                    '--use-gl=angle','--use-angle=swiftshader','--hide-scrollbars',
                    '--window-size=900,520','--virtual-time-budget=60000','--dump-dom',
                    'file://' + str(tmp)], capture_output=True, text=True, timeout=600)
tmp.unlink(missing_ok=True)
if '<title>' not in r.stdout: print('no result — page failed to run'); sys.exit(1)
d = json.loads(r.stdout.split('<title>')[1].split('<')[0])
print('match lengths :', d['matchLengths'], ' median', d['median'])
print('first kill on :', d['firstKill'])
print('all decided   :', d['allDecided'])
print('deaths by     :', d['deathCauses'])
print('winners       :', d['winners'])
