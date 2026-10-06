#!/usr/bin/env python3
"""Where the weekly quota goes: a local breakdown of your Claude Code transcripts (nothing leaves
the machine). Each API request is counted once (by requestId), its token types weighted by their
relative API price (input 1, cache read 0.1, cache write 1.25 for 5 min / 2 for 1 h, output 5),
since that is what the quota tracks. Context is split into the fixed base (system prompt, tools,
skills: the first request of each session), tool results (by tool, carried until a compaction)
and the rest of the conversation.

  python3 quota.py --days 7 --exclude clientA,clientB   # or set JEVMOD_EXCLUDE
"""
import argparse, collections, datetime, glob, json, os

p = argparse.ArgumentParser()
p.add_argument('--days', type=int, default=7)
p.add_argument('--exclude', default=os.environ.get('JEVMOD_EXCLUDE', ''))
args = p.parse_args()
excluded = [x.strip() for x in args.exclude.split(',') if x.strip()]
cut = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=args.days)
W = {'input': 1.0, 'read': 0.1, 'write5m': 1.25, 'write1h': 2.0, 'output': 5.0}
CH = 3.5  # characters per token, for tool results

tot = collections.Counter()           # weighted units by category
tok = collections.Counter()           # raw tokens by type
by_model = collections.Counter()
by_project = collections.Counter()
by_loop = collections.Counter()
tool_size = collections.Counter()     # tokens put into context, by tool
tool_carry = collections.Counter()    # weighted units of re-reading them later
big = collections.Counter()           # tool results over 10k tokens, by tool
requests = 0


def tool_name(n):
    return 'mcp:' + n.split('__')[1] if n.startswith('mcp__') else n


for path in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')) + glob.glob(os.path.expanduser('~/.claude/projects/*/*/subagents/*.jsonl')):
    if os.path.getmtime(path) < cut.timestamp() or any(x in path for x in excluded):
        continue
    seen, names, base, carried = set(), {}, None, []  # carried: [(tool, tokens)] since the last compaction
    for line in open(path, errors='ignore'):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if any(x in (d.get('cwd') or '') for x in excluded):
            continue
        ts = d.get('timestamp')
        if not ts or datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')) < cut:
            continue
        if d.get('type') == 'system' and d.get('subtype') == 'compact_boundary':
            carried, base = [], None
        m = d.get('message') or {}
        content = m.get('content')
        if d.get('type') == 'assistant':
            for b in content or []:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    names[b.get('id')] = tool_name(b.get('name', '?'))
            rid = d.get('requestId')
            u = m.get('usage')
            if not u or not rid or rid in seen:
                continue
            seen.add(rid)
            requests += 1
            cc = u.get('cache_creation') or {}
            w5, w1 = cc.get('ephemeral_5m_input_tokens', 0), cc.get('ephemeral_1h_input_tokens', 0)
            if not cc:
                w5 = u.get('cache_creation_input_tokens', 0)
            inp, rd, out = u.get('input_tokens', 0), u.get('cache_read_input_tokens', 0), u.get('output_tokens', 0)
            ctx = inp + rd + w5 + w1
            ctx_units = inp * W['input'] + rd * W['read'] + w5 * W['write5m'] + w1 * W['write1h']
            units = ctx_units + out * W['output']
            for k, v in (('input', inp), ('read', rd), ('write', w5 + w1), ('output', out)):
                tok[k] += v
            # split the context: fixed base, tool results carried, the rest of the conversation
            per = ctx_units / ctx if ctx else 0
            if base is None:
                base = ctx
            b_t = min(base, ctx)
            t_t = min(sum(t for _, t in carried), ctx - b_t)
            tot['output'] += out * W['output']
            tot['base context (system, tools, skills)'] += b_t * per
            tot['tool results in context'] += t_t * per
            tot['rest of the conversation'] += (ctx - b_t - t_t) * per
            if t_t:
                scale = t_t / max(1, sum(t for _, t in carried))
                for name, t in carried:
                    tool_carry[name] += t * scale * per
            by_model[m.get('model', '?')] += units
            by_project[(d.get('cwd') or '').rstrip('/').split('/')[-1] or '?'] += units
            by_loop['subagents' if d.get('isSidechain') or '/subagents/' in path else 'main loop'] += units
        elif d.get('type') == 'user' and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get('type') == 'tool_result':
                    c = b.get('content')
                    text = c if isinstance(c, str) else ''.join(x.get('text', '') for x in c or [] if isinstance(x, dict))
                    n = len(text) / CH
                    name = names.get(b.get('tool_use_id'), '?')
                    tool_size[name] += n
                    if n > 10_000:
                        big[name] += 1
                    carried.append((name, n))

all_units = sum(tot.values())
pct = lambda x: f'{100 * x / all_units:5.1f}%' if all_units else '  -'
print(f'Last {args.days} days: {requests:,} API requests · tokens: {tok["output"]:,} output · {tok["read"]:,} cache read · {tok["write"]:,} cache write · {tok["input"]:,} uncached input')
print('\nWhere the weighted usage goes:')
for k, v in tot.most_common():
    print(f'  {pct(v)}  {k}')
print('\nTool results re-read in later requests (share of all usage), and what they put in:')
for k, v in tool_carry.most_common(10):
    print(f'  {pct(v)}  {k:28s} {tool_size[k] / 1000:8,.0f}k tokens put in{f"  · {big[k]} results over 10k tokens" if big[k] else ""}')
print('\nBy loop:   ' + ' · '.join(f'{k} {pct(v).strip()}' for k, v in by_loop.most_common()))
print('By model:  ' + ' · '.join(f'{k} {pct(v).strip()}' for k, v in by_model.most_common(5)))
print(f'Projects:  {len(by_project)} · top 5 hold ' + pct(sum(v for _, v in by_project.most_common(5))).strip())
