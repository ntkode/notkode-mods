#!/usr/bin/env python3
"""Turns from your Claude Code transcripts, for replaying through Jev.

Each turn: the prompt you typed, the conversation before it, the tools Claude ran, its final
answer, how much work it took (requests, output tokens), and your next message.

  python3 extract.py                      # last 14 days, 400 random turns -> data/turns.jsonl
  python3 extract.py --days 30 --sample 0 # every turn of the last 30 days
  python3 extract.py --exclude clientA,clientB   # or set JEVMOD_EXCLUDE

The output holds your real prompts: it stays in data/, which git ignores.
"""
import argparse, datetime, glob, json, os, random, re

p = argparse.ArgumentParser()
p.add_argument('--days', type=int, default=14)
p.add_argument('--sample', type=int, default=400, help='0 = all turns')
p.add_argument('--seed', type=int, default=7)
p.add_argument('--exclude', default=os.environ.get('JEVMOD_EXCLUDE', ''), help='comma-separated folder names to leave out (default: $JEVMOD_EXCLUDE)')
p.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'data', 'turns.jsonl'))
args = p.parse_args()

root = os.path.expanduser('~/.claude/projects')
cut = (datetime.datetime.now() - datetime.timedelta(days=args.days)).timestamp()
excluded = [x.strip() for x in args.exclude.split(',') if x.strip()]
EXPLORE = re.compile(r'^\s*(cd\s+\S+\s*(&&|;)\s*)?(grep|rg|sed|cat|ls|find|head|tail|wc)\b')


def summary(inp):
    for k in ('command', 'file_path', 'pattern', 'url', 'query', 'skill', 'description'):
        v = inp.get(k)
        if isinstance(v, str) and v:
            return re.sub(r'\s+', ' ', v).strip()[:140]
    return ''


turns = []
for path in glob.glob(root + '/*/*.jsonl'):
    if os.path.getmtime(path) < cut or any(x in path for x in excluded):
        continue
    rows = []
    for line in open(path, errors='ignore'):
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    cur, hist = None, []

    def close(c, nxt):
        if not c:
            return
        c['next'] = (nxt or '')[:300]
        c['steps'] = len(c.pop('_ids'))
        c['output'] = sum(c.pop('_out').values())
        errs = c.pop('_errs')
        for t in c['tools']:
            t['isError'] = t.pop('id') in errs
        turns.append(c)

    for d in rows:
        if d.get('isSidechain'):
            continue
        m = d.get('message') or {}
        c = m.get('content')
        if d.get('type') == 'user':
            typed = isinstance(c, str) and d.get('promptSource') in ('typed', 'queued', 'suggestion_accepted')
            if typed and not c.startswith('<') and not c.startswith('Another Claude session'):
                if any(x in (d.get('cwd') or '') for x in excluded):
                    cur = None
                    continue
                if cur:
                    hist += [('user', cur['prompt']), ('assistant', cur['answer'])]
                close(cur, c)
                cwd = d.get('cwd', '')
                cur = {'file': os.path.basename(path), 'cwd': cwd, 'project': cwd.rstrip('/').split('/')[-1], 'prompt': c,
                       'history': [{'role': r, 'text': t[:1500]} for r, t in hist[-6:]], 'tools': [], 'answer': '',
                       'reason': 'answer', '_ids': set(), '_out': {}, '_errs': set(), 'toolSearch': 0, 'explore': 0,
                       'mcpUsed': [], 'skillsUsed': []}
                continue
            if cur and isinstance(c, list):
                for x in c:
                    if isinstance(x, dict) and x.get('type') == 'tool_result' and x.get('is_error'):
                        cur['_errs'].add(x.get('tool_use_id'))
                    if isinstance(x, dict) and x.get('type') == 'text' and 'Request interrupted' in x.get('text', ''):
                        cur['reason'] = 'aborted'
        elif d.get('type') == 'assistant' and cur:
            i = m.get('id')
            cur['_ids'].add(i)
            cur['_out'][i] = max(cur['_out'].get(i, 0), (m.get('usage') or {}).get('output_tokens', 0))
            for b in m.get('content') or []:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'text' and b.get('text', '').strip():
                    cur['answer'] = b['text'][:6000]
                if b.get('type') == 'tool_use':
                    n, inp = b['name'], b.get('input') or {}
                    cur['tools'].append({'tool': n, 'summary': summary(inp), 'id': b.get('id')})
                    if n == 'ToolSearch':
                        cur['toolSearch'] += 1
                    if n in ('Read', 'Grep', 'Glob') or (n == 'Bash' and EXPLORE.match(inp.get('command', '') or '')):
                        cur['explore'] += 1
                    if n.startswith('mcp__'):
                        server = n.split('__')[1]
                        if server not in cur['mcpUsed']:
                            cur['mcpUsed'].append(server)
                    if n == 'Skill':
                        cur['skillsUsed'].append(str(inp.get('skill', '')))
    close(cur, '')

eligible = [t for t in turns if t['steps'] > 0 and not t['prompt'].startswith('/')]
random.seed(args.seed)
chosen = eligible if args.sample == 0 else random.sample(eligible, min(args.sample, len(eligible)))
os.makedirs(os.path.dirname(args.out), exist_ok=True)
with open(args.out, 'w') as out:
    for t in chosen:
        out.write(json.dumps(t, ensure_ascii=False) + '\n')
print(f'{len(turns)} turns found, {len(eligible)} eligible, {len(chosen)} written to {args.out}')
