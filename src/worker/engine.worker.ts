/// Engine worker entry: validates the built-in specs once at startup and serves the protocol.
import { loadBuiltinSpecs } from '../formats';
import { createEngineHandler } from './engine-handler';
import type { EngineRequest, EngineResponse } from './protocol';

const ctx = self as unknown as {
  postMessage(m: EngineResponse): void;
  onmessage: ((e: MessageEvent<EngineRequest>) => void) | null;
};

const { specs, errors } = loadBuiltinSpecs();
const handler = createEngineHandler({ specs, specErrors: errors, post: (m) => ctx.postMessage(m) });
ctx.onmessage = (e) => void handler.handle(e.data);
