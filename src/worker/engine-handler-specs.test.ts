import { describe, expect, it } from 'vitest';
import { MemoryByteSource } from '../core/byte-source';
import * as realEngine from '../core/engine';
import { loadBuiltinSpecs } from '../formats';
import { specText } from '../test/spec-fixtures';
import { createClient, SupersededError, type Transport } from './engine-client';
import { MAX_CUSTOM_SPECS, MAX_REJECTED_MESSAGES, MAX_SETSPECS_ITEMS, createEngineHandler, type EngineApi } from './engine-handler';
import { createInlineClient } from './inline-client';
import type { EngineRequest, EngineResponse, RequestBody, ResponseOf } from './protocol';

const magicSpec = (id: string, magic: string, extra: Record<string, unknown> = {}) =>
  specText(id, { detect: [{ at: 0, bytes: magic }], types: { root: { fields: [{ name: 'magic', type: 'u4' }, { name: 'rest', type: 'u1' }] } }, ...extra });

function setup(opts: { bytes?: Uint8Array; engine?: EngineApi } = {}) {
  const out: EngineResponse[] = [];
  const builtin = loadBuiltinSpecs();
  const bytes = opts.bytes ?? Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 7, 0, 0, 0]);
  const handler = createEngineHandler({ specs: builtin.specs, specErrors: builtin.errors, post: (m) => out.push(m), engine: opts.engine, makeSource: () => new MemoryByteSource(bytes) });
  let id = 0;
  const send = async <T extends EngineResponse['type']>(r: RequestBody) => {
    const req = { ...r, id: ++id } as EngineRequest;
    await handler.handle(req);
    return out.filter((m) => m.id === req.id)[0] as ResponseOf<T> | undefined;
  };
  const open = (name = 'x.bin') => send<'open'>({ type: 'open', file: new Blob([]), fileName: name });
  return { out, send, open, handler, nextId: () => id + 1 };
}

describe('handler: setSpecs', () => {
  it('accepts valid specs, marks them custom, and leaves built-ins alone', async () => {
    const { send } = setup();
    const r = await send<'setSpecs'>({ type: 'setSpecs', specTexts: [magicSpec('mine', 'DE AD BE EF')] });
    expect(r!.rejected).toEqual([]);
    expect(r!.specs).toEqual([{ id: 'bmp', name: 'Windows Bitmap' }, { id: 'mine', name: 'Fmt mine', custom: true }]);
  });

  it('re-validates every text itself and reports the ones it rejects', async () => {
    const { send } = setup();
    const r = await send<'setSpecs'>({
      type: 'setSpecs',
      specTexts: [
        'not json',
        specText('broken', { root: 'missing' }),
        specText('bmp'), // collides with a built-in
        specText('dup'),
        specText('dup'), // duplicate among custom specs
        specText('ok'),
        5 as unknown as string,
        'x'.repeat(1_048_577),
      ],
    });
    expect(r!.specs.map((s) => s.id)).toEqual(['bmp', 'dup', 'ok']);
    expect(r!.rejected).toHaveLength(6);
    expect(r!.rejected[0]).toMatch(/#1.*invalid JSON/);
    expect(r!.rejected[1]).toMatch(/#2.*\$/);
    expect(r!.rejected[2]).toMatch(/#3.*"bmp".*already used/);
    expect(r!.rejected[3]).toMatch(/#5.*"dup"/);
    expect(r!.rejected[4]).toMatch(/#7.*not a text/);
    expect(r!.rejected[5]).toMatch(/#8.*too large/);
  });

  it('caps the number of custom specs and rejects a non-array', async () => {
    const { send } = setup();
    const texts = Array.from({ length: MAX_CUSTOM_SPECS + 2 }, (_, i) => specText(`s${i}`));
    const r = await send<'setSpecs'>({ type: 'setSpecs', specTexts: texts });
    expect(r!.specs).toHaveLength(1 + MAX_CUSTOM_SPECS);
    expect(r!.rejected).toHaveLength(2);
    const bad = await send({ type: 'setSpecs', specTexts: 'nope' as unknown as string[] });
    expect(bad).toMatchObject({ type: 'error' });
  });

  it('replaces the previous custom set instead of adding to it', async () => {
    const { send } = setup();
    await send({ type: 'setSpecs', specTexts: [specText('a')] });
    const r = await send<'setSpecs'>({ type: 'setSpecs', specTexts: [specText('b')] });
    expect(r!.specs.map((s) => s.id)).toEqual(['bmp', 'b']);
    expect((await send({ type: 'parse', specId: 'a' }))).toMatchObject({ type: 'error', message: expect.stringMatching(/unknown format/) });
  });

  it('detection and parse include custom specs', async () => {
    const { send, open } = setup();
    await send({ type: 'setSpecs', specTexts: [magicSpec('mine', 'DE AD BE EF', { extensions: ['abc'] })] });
    const o = await open('file.abc');
    expect(o!.specs.map((s) => s.id)).toEqual(['bmp', 'mine']);
    expect(o!.specs.find((s) => s.id === 'mine')!.custom).toBe(true);
    expect(o!.detections[0]).toMatchObject({ specId: 'mine', name: 'Fmt mine', magicMatched: true });
    const p = await send<'parse'>({ type: 'parse', specId: 'mine' });
    expect(p!.snapshot!.specId).toBe('mine');
    expect(p!.snapshot!.root.children!.map((c) => c.name)).toEqual(['magic', 'rest']);
  });

  it('does not supersede a running parse', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine: EngineApi = { ...realEngine, parse: async (spec, src, o) => (await gate, realEngine.parse(spec, src, o)) };
    const { send, open, out, nextId } = setup({ engine });
    await open();
    const pid = nextId();
    const pending = send({ type: 'parse', specId: 'bmp' });
    await send({ type: 'setSpecs', specTexts: [specText('late')] });
    release();
    await pending;
    expect(out.some((m) => m.id === pid && m.type === 'parse')).toBe(true);
  });
});

describe('handler: parseDraft', () => {
  it('invalid draft text gives an error with paths; nothing is parsed', async () => {
    const { send, open } = setup();
    await open();
    const r = await send({ type: 'parseDraft', specText: specText('d', { root: 'nope' }) });
    expect(r).toMatchObject({ type: 'error', message: expect.stringMatching(/^invalid spec: \$/) });
    expect(await send({ type: 'parseDraft', specText: '{ not json' })).toMatchObject({ type: 'error', message: expect.stringMatching(/invalid JSON/) });
    expect(await send({ type: 'parseDraft', specText: 12 as unknown as string })).toMatchObject({ type: 'error' });
    expect(await send({ type: 'parseDraft', specText: 'x'.repeat(1_048_577) })).toMatchObject({ type: 'error', message: expect.stringMatching(/too large/) });
  });

  it('a valid draft yields a tree over the open document, and later requests work on it', async () => {
    const { send, open } = setup();
    await open();
    const r = await send<'parse'>({ type: 'parseDraft', specText: magicSpec('draft', 'DE AD BE EF') });
    expect(r!.type).toBe('parse');
    const snap = r!.snapshot!;
    expect(snap.specId).toBe('draft');
    expect(snap.root.children!.map((c) => c.name)).toEqual(['magic', 'rest']);
    const loc = await send<'located'>({ type: 'nodeAt', offset: 4 });
    expect(loc!.path).not.toBeNull();
  });

  it('needs an open file', async () => {
    const { send } = setup();
    expect(await send({ type: 'parseDraft', specText: specText('d') })).toMatchObject({ type: 'error', message: 'no file is open' });
  });

  it('draft is not added to the spec set', async () => {
    const { send, open } = setup();
    await send({ type: 'parseDraft', specText: specText('d') });
    const o = await open();
    expect(o!.specs.map((s) => s.id)).toEqual(['bmp']);
  });

  it('supersedes like parse: a newer parse/parseDraft silences the older one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const engine: EngineApi = {
      ...realEngine,
      parse: async (spec, src, o) => {
        if (calls++ === 0) await gate;
        return realEngine.parse(spec, src, o);
      },
    };
    const { send, open, out, nextId } = setup({ engine });
    await open();
    const firstId = nextId();
    const first = send({ type: 'parseDraft', specText: specText('first') });
    const secondId = nextId();
    const second = await send<'parse'>({ type: 'parseDraft', specText: specText('second') });
    expect(second!.snapshot!.specId).toBe('second');
    release();
    await first;
    expect(out.some((m) => m.id === firstId)).toBe(false);
    expect(out.some((m) => m.id === secondId && m.type === 'parse')).toBe(true);
  });

  it('a draft supersedes a pending open, and a parse supersedes a pending draft', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine: EngineApi = { ...realEngine, parse: async (spec, src, o) => (await gate, realEngine.parse(spec, src, o)) };
    const { send, open, out, nextId } = setup({ engine });
    await open();
    const draftId = nextId();
    const draft = send({ type: 'parseDraft', specText: specText('d') });
    const parsed = send<'parse'>({ type: 'parse', specId: null });
    expect((await parsed)!.snapshot).toBeNull();
    release();
    await draft;
    expect(out.some((m) => m.id === draftId)).toBe(false);
  });
});

describe('client: setSpecs / parseDraft', () => {
  function manual() {
    const sent: EngineRequest[] = [];
    let deliver!: (r: EngineResponse) => void;
    const t: Transport = { post: (r) => sent.push(r), onMessage: (cb) => (deliver = cb), onError: () => {}, close: () => {} };
    return { t, sent, deliver: (r: EngineResponse) => deliver(r) };
  }

  it('open and parse do not reject a pending setSpecs', async () => {
    const { t, sent, deliver } = manual();
    const c = createClient(t);
    const p = c.setSpecs(['{}']);
    c.open(null, 'x').catch(() => {});
    c.parse('a').catch(() => {});
    c.parseDraft('{}').catch(() => {});
    expect(sent[0]).toMatchObject({ type: 'setSpecs', specTexts: ['{}'] });
    deliver({ id: 1, type: 'setSpecs', specs: [{ id: 'z', name: 'Z', custom: true }], rejected: ['x'] });
    expect(await p).toEqual({ specs: [{ id: 'z', name: 'Z', custom: true }], rejected: ['x'] });
  });

  it('parseDraft supersedes older parse requests', async () => {
    const { t } = manual();
    const c = createClient(t);
    const old = c.parse('a');
    const assertion = expect(old).rejects.toBeInstanceOf(SupersededError);
    c.parseDraft('{}').catch(() => {});
    await assertion;
  });

  it('round-trips through the real handler (inline client)', async () => {
    const c = createInlineClient();
    const r = await c.setSpecs([specText('inline-1'), 'garbage']);
    expect(r.specs.map((s) => s.id)).toEqual(['bmp', 'inline-1']);
    expect(r.rejected).toHaveLength(1);
    await c.open(new Blob([Uint8Array.from([1, 2, 3, 4, 5])]), 'a.bin');
    const snap = await c.parseDraft(specText('draft'));
    expect(snap!.specId).toBe('draft');
    await expect(c.parseDraft('nope')).rejects.toThrow(/invalid spec/);
    c.dispose();
  });
});

describe('handler: limits and quiet supersede', () => {
  it('rejects a setSpecs request with too many items or too many bytes before validating anything', async () => {
    const { send } = setup();
    const many = await send({ type: 'setSpecs', specTexts: Array.from({ length: MAX_SETSPECS_ITEMS + 1 }, () => '{}') });
    expect(many).toMatchObject({ type: 'error', message: expect.stringMatching(/too many specs/) });
    const chunk = 'x'.repeat(1_000_000);
    const big = await send({ type: 'setSpecs', specTexts: Array.from({ length: 70 }, () => chunk) });
    expect(big).toMatchObject({ type: 'error', message: expect.stringMatching(/too large/) });
  });

  it('caps the number of rejection messages', async () => {
    const { send } = setup();
    const r = await send<'setSpecs'>({ type: 'setSpecs', specTexts: Array.from({ length: 200 }, () => 'not json') });
    expect(r!.rejected).toHaveLength(MAX_REJECTED_MESSAGES + 1);
    expect(r!.rejected.at(-1)).toBe(`… and ${200 - MAX_REJECTED_MESSAGES} more`);
  });

  it('a parseDraft overtaken by a newer parse stays silent even when it fails', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine: EngineApi = {
      ...realEngine,
      parse: async (spec, src, o) => {
        if (calls++ === 0) {
          await gate;
          throw new Error('late failure');
        }
        return realEngine.parse(spec, src, o);
      },
    };
    const { send, open, out, nextId } = setup({ engine });
    await open();
    const draftId = nextId();
    const draft = send({ type: 'parseDraft', specText: specText('d') });
    await send({ type: 'parse', specId: 'bmp' });
    release();
    await draft;
    expect(out.some((m) => m.id === draftId)).toBe(false);
  });
});
