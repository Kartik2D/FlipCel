/**
 * Reactive store primitive + Lit StoreController.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";

type Listener<T> = (value: T) => void;

/** Generic reactive store with subscribe/publish pattern. */
export class Store<T> {
  private value: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(value: T) {
    this.value = value;
    this.listeners.forEach((fn) => fn(value));
  }

  update(fn: (current: T) => T) {
    this.set(fn(this.value));
  }

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeImmediate(fn: Listener<T>): () => void {
    fn(this.value);
    return this.subscribe(fn);
  }
}

/**
 * Reactive controller that auto-subscribes Lit components to stores.
 *
 * Usage:
 *   private tool = new StoreController(this, toolStore);
 */
export class StoreController<T> implements ReactiveController {
  private host: ReactiveControllerHost;
  private store: Store<T>;
  private unsubscribe?: () => void;

  value: T;

  constructor(host: ReactiveControllerHost, store: Store<T>) {
    this.host = host;
    this.store = store;
    this.value = store.get();
    host.addController(this);
  }

  hostConnected() {
    this.unsubscribe = this.store.subscribe((value) => {
      this.value = value;
      this.host.requestUpdate();
    });
  }

  hostDisconnected() {
    this.unsubscribe?.();
  }

  get(): T {
    return this.value;
  }

  set(value: T) {
    this.store.set(value);
  }

  update(fn: (current: T) => T) {
    this.store.update(fn);
  }
}
