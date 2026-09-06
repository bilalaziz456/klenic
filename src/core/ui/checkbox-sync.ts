/**
 * Keep a controlled checkbox's `defaultChecked` in step with its `checked` prop.
 *
 * WHY: React resets a `<form action={…}>` once its Server Action completes, and a form
 * reset restores every checkbox to its `defaultChecked` — an attribute React writes on
 * the FIRST render and never again. A checkbox the user has toggled since then has a
 * `checked` prop that did not change across the post-action re-render, so React writes
 * nothing to the DOM and the reset value stands: the tick silently flips back to however
 * the box first rendered, while React state — and the hidden input that actually saves —
 * still hold the new value. The card then contradicts itself, which is how this was
 * reported: a paper size showing ticked while the rest of the form said it was off.
 *
 * Syncing the attribute makes the reset a no-op. Deliberately preferred to swapping the
 * input for a `<button role="checkbox">`: it is three lines instead of a markup rewrite,
 * and it keeps native checkbox semantics — label association, keyboard, assistive tech.
 *
 * Only needed for a controlled checkbox inside a form with a Server Action. A hidden
 * input does NOT need it (React keeps `defaultValue` in step, so a reset restores the
 * current value) and neither does a checkbox in a form that navigates away on submit.
 */
export function syncChecked(checked: boolean) {
  return (el: HTMLInputElement | null) => {
    if (el) el.defaultChecked = checked;
  };
}
