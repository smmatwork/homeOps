import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// JSDOM doesn't implement BroadcastChannel.
class DummyBroadcastChannel {
  name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(name: string) {
    this.name = name;
  }
  postMessage(_msg: any) {}
  close() {}
  addEventListener(_type: string, _listener: any) {}
  removeEventListener(_type: string, _listener: any) {}
}

if (!(globalThis as any).BroadcastChannel) {
  (globalThis as any).BroadcastChannel = DummyBroadcastChannel as any;
}

// JSDOM doesn't implement scrolling APIs that some components rely on.
// Provide no-op stubs so effects don't crash tests.
if (!HTMLElement.prototype.scrollIntoView) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  HTMLElement.prototype.scrollIntoView = (() => {}) as any;
}

if (!(HTMLElement.prototype as any).scrollTo) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  (HTMLElement.prototype as any).scrollTo = (() => {}) as any;
}
