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

  protected emitChange() {
    this.color = this.getColorFromState();
    this.dispatchEvent(
      new CustomEvent("input", {
        detail: { value: this.color },
        bubbles: true,
        composed: true,
      })
    );
    this.requestUpdate();
  }

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
    const up = () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this._isDragging = false;
      if (lastEv) onUpdate(lastEv);
      this.emitChangeEnd();
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}
