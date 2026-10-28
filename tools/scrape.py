"""Pull hero portraits (card, gloat, critical), signature quote and a few voice lines from deadlock.wiki.

Writes images/audio under heroes/<slug>/ and the index to heroes.js (paths relative to the site root).
"""
import json, os, re, sys, time, urllib.parse, urllib.request

API = 'https://deadlock.wiki/api.php'
UA = {'User-Agent': 'DeadlockFeud/1.0 (fan-made party game; one-off asset fetch)'}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
LIMITS = {'gloat': 5, 'critical': 4}


def get(params):
    q = urllib.parse.urlencode(dict(params, format='json'))
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(API + '?' + q, headers=UA), timeout=30) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            time.sleep(2 + attempt * 2)
    raise RuntimeError('API failed: %s' % params)


def download(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        data = r.read()
    with open(path, 'wb') as f:
        f.write(data)
    time.sleep(0.15)


def wikitext(page):
    d = get({'action': 'parse', 'page': page, 'prop': 'wikitext', 'redirects': 1})
    return d.get('parse', {}).get('wikitext', {}).get('*', '')


def file_urls(names, width=None):
    """File names -> direct (or thumbnail) URL."""
    out = {}
    names = list(dict.fromkeys(names))
    for i in range(0, len(names), 40):
        chunk = names[i:i + 40]
        p = {'action': 'query', 'prop': 'imageinfo', 'iiprop': 'url', 'titles': '|'.join('File:' + n for n in chunk)}
        if width:
            p['iiurlwidth'] = width
        d = get(p)
        norm = {n['to']: n['from'] for n in d['query'].get('normalized', [])}
        for pg in d['query']['pages'].values():
            if 'imageinfo' not in pg:
                continue
            ii = pg['imageinfo'][0]
            title = norm.get(pg['title'], pg['title'])
            out[title[5:]] = ii.get('thumburl') or ii['url']
    return out


def clean_text(t):
    t = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r'\1', t)
    t = re.sub(r"'{2,}", '', t)
    t = re.sub(r'<[^>]+>', '', t)
    return t.strip()


def section_lines(text, heading):
    """{context: [(file, text)]} for the first '=== heading ===' table."""
    m = re.search(r'^=+\s*' + re.escape(heading) + r'\s*=+\s*$', text, re.M)
    if not m:
        return {}
    rest = text[m.end():]
    end = re.search(r'^==', rest, re.M)
    body = rest[:end.start()] if end else rest
    ctx, out = None, {}
    for line in body.splitlines():
        lab = re.match(r'^\|\s*(?:rowspan="\d+"\s*\|)?\s*([^|{][^|{]*)$', line)
        if lab and not line.startswith('|-') and not line.startswith('|}'):
            ctx = lab.group(1).strip()
        for f, t in re.findall(r'\{\{Audio link\|([^|}]+)\|([^}]*)\}\}', line):
            if ' alt ' in f or not ctx:
                continue
            out.setdefault(ctx, []).append((f.strip(), clean_text(t)))
    return out


def find_image(names, kind):
    """Best portrait file for kind ('card' | 'gloat' | 'critical') among files listed for this hero."""
    alt = re.compile(r'ver\d|_v\d|old|psd|transformed|famil', re.I)
    hits = [n for n in names if re.search(kind, n, re.I) and n.lower().endswith('.png')]
    hits.sort(key=lambda n: (bool(alt.search(n)), len(n)))
    return hits[0] if hits else None


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def main():
    d = get({'action': 'query', 'list': 'categorymembers', 'cmtitle': 'Category:Heroes', 'cmnamespace': 0, 'cmlimit': 200})
    heroes = [p['title'] for p in d['query']['categorymembers'] if p['title'] not in ('Heroes', 'Heroes by release')]
    print(len(heroes), 'heroes', file=sys.stderr)
    index = []
    for hero in heroes:
        s = slug(hero)
        folder = os.path.join(OUT, 'heroes', s)
        os.makedirs(folder, exist_ok=True)

        # portraits: list files starting with the hero name and pick card/gloat/critical
        # full name, without a leading "The", and the first word (e.g. "Nurse_card_gloat") unless that is just "The"
        prefixes = {hero.replace(' ', '_'), hero.replace('The ', '').replace(' ', '_')}
        if not hero.startswith('The '):
            prefixes.add(hero.split(' ')[0])
        names = []
        for pre in prefixes:
            names += [i['name'] for i in get({'action': 'query', 'list': 'allimages', 'aiprefix': pre, 'ailimit': 500})['query']['allimages']]
        pics = {k: find_image(names, k) for k in ('card', 'gloat', 'critical')}
        if not pics['card']:
            print('skip (no card):', hero, file=sys.stderr)
            continue
        urls = file_urls([n for n in pics.values() if n], width=260)
        entry = {'id': s, 'name': hero}
        for k, n in pics.items():
            if n and n in urls:
                download(urls[n], os.path.join(folder, k + '.png'))
                entry[k] = 'heroes/%s/%s.png' % (s, k)

        # signature quote from the hero page
        page = wikitext(hero)
        q = re.search(r'\{\{Quotation\s*\|([^}]*)\}\}', page)
        quote_file = None
        if q:
            parts = {k.strip(): v.strip() for k, v in (p.split('=', 1) for p in q.group(1).split('|') if '=' in p)}
            if parts.get('2'):
                entry['quote'] = clean_text(parts['2'])
            quote_file = parts.get('4', '').strip() or None

        # voice lines
        vl = wikitext(hero + '/Voice lines')
        picks = {'gloat': [], 'critical': []}
        for sec in ('Kill Enemy Hero', 'Generic Kill Voice Lines', 'Generic Voice Lines'):
            for ctx, lst in section_lines(vl, sec).items():
                if re.search(r'^generic$|^kill|awake', ctx, re.I) and len(picks['gloat']) < LIMITS['gloat']:
                    picks['gloat'] += lst
            if picks['gloat']:
                break
        sit = section_lines(vl, 'Situational')
        for ctx in ('Low Health Warning', 'Retreating', 'Outnumbered', 'Last Alive', 'Enemy Escaped (Low Health)'):
            picks['critical'] += sit.get(ctx, [])
        if not picks['gloat']:
            picks['gloat'] = sit.get('Interrupt Enemy', []) + sit.get('Successful Parry', []) + sit.get('Win MVP', [])
        if not picks['critical']:
            picks['critical'] = [x for lst in section_lines(vl, 'Respawn').values() for x in lst]
        wanted = [f for k, lst in picks.items() for f, _ in lst[:LIMITS[k]]] + ([quote_file] if quote_file else [])
        aurls = file_urls(wanted)
        entry['lines'] = {}
        for k, lst in picks.items():
            got = []
            for n, (f, text) in enumerate(lst[:LIMITS[k]]):
                if f not in aurls and f[0].upper() + f[1:] not in aurls:
                    continue
                url = aurls.get(f) or aurls.get(f[0].upper() + f[1:])
                name = '%s-%d.mp3' % (k, n + 1)
                download(url, os.path.join(folder, name))
                got.append({'text': text, 'audio': 'heroes/%s/%s' % (s, name)})
            entry['lines'][k] = got
        if quote_file:
            url = aurls.get(quote_file) or aurls.get(quote_file[0].upper() + quote_file[1:])
            if url:
                download(url, os.path.join(folder, 'quote.mp3'))
                entry['quoteAudio'] = 'heroes/%s/quote.mp3' % s
        index.append(entry)
        print('%-15s pics=%s quote=%s lines=%s' % (hero, ''.join(k[0] for k in pics if pics[k]), 'y' if entry.get('quote') else '-',
              {k: len(v) for k, v in entry['lines'].items()}), file=sys.stderr)

    with open(os.path.join(OUT, 'heroes.js'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Generated by wiki/scrape.py from deadlock.wiki. Portraits and voice lines are Valve\'s.\n')
        f.write('window.HEROES = ' + json.dumps(index, ensure_ascii=False, indent=1) + ';\n')


if __name__ == '__main__':
    main()
