import { LitElement } from "lit";
import { property } from "lit/decorators.js";

// ============================================================
// Base Color Picker Class (shared logic for all pickers)
// ============================================================

export abstract class BaseColorPicker extends LitElement {
  @property({ type: String }) color = "#037ffc";
  @property({ type: String }) prevColor = "#000000";
  protected _isDragging = false;

  protected abstract syncFromColor(hex: string): void;
  protected abstract getColorFromState(): string;

  protected emitChangeEnd() {
    this.dispatchEvent(
      new CustomEvent("change", {
        detail: { value: this.color },
        bubbles: true,
        composed: true,
      })
    );
  }

  protected startDrag(
    e: PointerEvent,
    onUpdate: (e: PointerEvent) => void,
    onEnd?: () => void
  ) {
    this._isDragging = true;
    onUpdate(e);
    let rafId = 0;
    let lastEv: PointerEvent | null = null;
    const move = (ev: PointerEvent) => {
      lastEv = ev;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (lastEv) onUpdate(lastEv);
        });
      }
    };
    let ended = false;
    const up = () => {
      if (ended) return;
      ended = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (lastEv) onUpdate(lastEv);
      this._isDragging = false;
      onEnd?.();
      this.emitChangeEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
}
