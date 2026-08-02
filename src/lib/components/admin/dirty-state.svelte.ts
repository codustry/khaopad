/**
 * Dirty-state tracking plus the unsaved-changes guard.
 *
 * ## Why both guards are needed
 *
 * `window.onbeforeunload` was unset, so navigating away mid-edit lost the
 * work silently. But `beforeunload` alone is not enough in a SPA: it only
 * fires for full page unloads (closing the tab, typing a new URL), and
 * says nothing about SvelteKit's client-side navigation, which is how a
 * user actually leaves the editor — by clicking the sidebar. So this
 * pairs it with `beforeNavigate`, and the two cover disjoint cases.
 *
 * ## Why the snapshot is a string
 *
 * Comparing a serialised snapshot rather than tracking per-field
 * mutations means "type a character, then delete it" correctly reports
 * clean. A mutation-counting approach reports dirty forever after the
 * first keystroke, which trains people to ignore the prompt.
 *
 * The caller supplies the serialiser, because only the page knows which
 * fields are content and which are incidental UI state.
 */
import { beforeNavigate } from "$app/navigation";
import { onMount } from "svelte";

export class DirtyState {
  #baseline = $state("");
  #current = $state("");
  /** Set while a save is in flight, so the guard doesn't fire on the redirect. */
  #saving = $state(false);

  constructor(initial: string) {
    this.#baseline = initial;
    this.#current = initial;
  }

  get dirty(): boolean {
    return !this.#saving && this.#current !== this.#baseline;
  }

  get saving(): boolean {
    return this.#saving;
  }

  /** Call whenever tracked fields change — cheap, it's a string compare. */
  update(snapshot: string): void {
    this.#current = snapshot;
  }

  /** Marks a save in flight so the navigation guard stays quiet. */
  beginSave(): void {
    this.#saving = true;
  }

  /** After a successful save: the current content becomes the new baseline. */
  commit(snapshot?: string): void {
    this.#baseline = snapshot ?? this.#current;
    if (snapshot !== undefined) this.#current = snapshot;
    this.#saving = false;
  }

  /** After a failed save: still dirty, but no longer in flight. */
  abortSave(): void {
    this.#saving = false;
  }

  /** Resets to a new baseline, e.g. after a discard. */
  reset(snapshot: string): void {
    this.#baseline = snapshot;
    this.#current = snapshot;
    this.#saving = false;
  }
}

/**
 * Wires both guards to a dirty-state getter. Call at component top level.
 *
 * Takes a getter rather than a value so it reads live state on each
 * navigation instead of capturing `dirty` once at setup, when it is
 * always false.
 */
export function guardUnsavedChanges(
  isDirty: () => boolean,
  confirmMessage: string,
): void {
  // Full unloads: closing the tab, reloading, typing a new URL. The
  // browser shows its own generic wording — since Chrome 51 and Firefox
  // 44 a custom string is ignored, so `confirmMessage` deliberately
  // isn't passed here. preventDefault() is the spec-compliant trigger;
  // returnValue is set too, for older Safari.
  onMount(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  });

  // Client-side navigation, which `beforeunload` never sees. Here the
  // message IS ours to choose, so it can name what is at stake.
  beforeNavigate((navigation) => {
    if (!isDirty()) return;
    // A programmatic redirect after a successful save must not prompt;
    // `commit()` clears dirty before the redirect, so reaching here with
    // dirty still true means the user is genuinely leaving mid-edit.
    if (!confirm(confirmMessage)) {
      navigation.cancel();
    }
  });
}
