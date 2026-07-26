import { html, type TemplateResult } from "lit";
import { THEMES, type ThemeMode } from "../state";

/** Mini stylized window: surround + floating panel + accent chip. */
export function renderThemePreview(mode: ThemeMode): TemplateResult {
  const { app, panel, border, accent } = THEMES[mode].preview;
  return html`
    <svg
      class="theme-preview"
      viewBox="0 0 36 28"
      width="36"
      height="28"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="36" height="28" rx="6" fill=${app} />
      <rect
        x="7"
        y="5"
        width="22"
        height="18"
        rx="4"
        fill=${panel}
        stroke=${border}
        stroke-width="1.5"
      />
      <rect x="7" y="5" width="22" height="5" rx="4" fill=${border} opacity="0.22" />
      <rect x="7" y="8.5" width="22" height="1.5" fill=${border} opacity="0.35" />
      <rect x="10" y="13" width="11" height="5" rx="2.5" fill=${accent} />
    </svg>
  `;
}
