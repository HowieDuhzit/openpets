import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publishAppStatusChanged(): void {
  emitter.emit("changed");
}

export function subscribeAppStatusChanged(listener: () => void): () => void {
  emitter.on("changed", listener);
  return () => emitter.off("changed", listener);
}
