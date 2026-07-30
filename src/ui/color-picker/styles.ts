import { css } from "lit";

export const pickerVars = css`
  :host {
    --picker-border-width: 2px;
    --picker-border-color: var(--block-border, #9f9f9f);
    --picker-handle-size: 12px;
    --picker-slider-width: 20px;
    --picker-gap: 10px;
  }
`;

export const handleStyles = css`
  .handle {
    position: absolute;
    width: var(--picker-handle-size);
    height: var(--picker-handle-size);
    border-radius: 50%;
    border: var(--picker-border-width) solid white;
    box-shadow: var(--flipcel-shadow-soft, 0 0 2px rgba(0, 0, 0, 0.5));
    background: transparent;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    pointer-events: none;
  }
`;

export const sliderColumnStyles = css`
  .slider-column {
    display: flex;
    flex-direction: column;
    gap: var(--picker-gap);
    width: var(--picker-slider-width);
  }

  .color-preview {
    width: 100%;
    aspect-ratio: 1;
    border-radius: var(--flipcel-content-radius);
    border: var(--picker-border-width) solid var(--picker-border-color);
    box-sizing: border-box;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .color-half { flex: 1; }

  .s-slider {
    flex: 1;
    position: relative;
    border-radius: var(--flipcel-content-radius);
    overflow: hidden;
    border: var(--picker-border-width) solid var(--picker-border-color);
    box-sizing: border-box;
    cursor: pointer;
  }

  .s-gradient { width: 100%; height: 100%; }

  .s-handle {
    position: absolute;
    left: 50%;
    width: calc(100% - 4px);
    height: 6px;
    border-radius: 2px;
    border: var(--picker-border-width) solid white;
    box-shadow: var(--flipcel-shadow-soft, 0 0 2px rgba(0, 0, 0, 0.5));
    background: transparent;
    transform: translate(-50%, -50%);
    box-sizing: border-box;
    pointer-events: none;
  }
`;
