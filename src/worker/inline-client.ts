/**
 * In-process EngineClient for tests (jsdom has no Worker). It runs the real handler on the calling thread but
 * structured-clones every message in both directions, like a real Worker would, so the tree the UI holds is
 * never shared with the engine's own tree. (Blobs/Files are cloned too, which is fine for them.)
 */
import { loadBuiltinSpecs } from '../formats';
import { createClient, type EngineClient } from './engine-client';
import { createEngineHandler, type HandlerDeps } from './engine-handler';
import type { EngineResponse } from './protocol';

export function createInlineClient(overrides: Partial<HandlerDeps> = {}): EngineClient {
  let deliver: (res: EngineResponse) => void = () => {};
  const { specs, errors } = loadBuiltinSpecs();
  const handler = createEngineHandler({
    specs,
    specErrors: errors,
    post: (m) => {
      const copy = structuredClone(m);
      setTimeout(() => deliver(copy), 0);
    },
    ...overrides,
  });
  return createClient({
    post: (req) => void handler.handle(req.type === 'open' ? req : structuredClone(req)),
    onMessage: (cb) => (deliver = cb),
    onError: () => {},
    close: () => {},
  });
}
