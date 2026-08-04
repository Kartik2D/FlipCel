/**
 * Side-effect registration of all Lit custom elements.
 */
import "./primitives/scrollbar";
import "./primitives/scroll-strip";
import "./primitives/block-button";
import "./primitives/panel-section";
import "./color-picker/generic-picker";
import "./color-picker/features";
import "./panels/tools-panel";
import "./panels/tool-settings-panel";
import "./panels/top-bar";
import "./panels/view-panel";
import "./panels/settings-panel";
import "./panels/history-panel";
import "./panels/keyboard-shortcuts-panel";
import "./panels/tutorials-panel";
import "./panels/startup-panel";
import "./panels/layers-panel";
import "./panels/jog-wheel";
import "./panels/contextual-actions-panel";
import "./panels/magic-move-popup";
import "./panels/magic-morph-popup";
import "./panels/auto-morph-popup";
import "./panels/help-popup";

export { Block } from "./primitives/block";
export { BlockyButton } from "./primitives/block-button";
export { FlipCelScrollbar } from "./primitives/scrollbar";
export { FlipCelScrollStrip } from "./primitives/scroll-strip";
export { FlipCelPanelSection } from "./primitives/panel-section";
export { FloatingPanel } from "./primitives/floating-panel";
export { PopupWindow } from "./primitives/popup-window";
export { GenericColorPicker } from "./color-picker/generic-picker";
export { FlipCelColorPanel, FlipCelColorPopup } from "./color-picker/features";
export { FlipCelToolsPanel } from "./panels/tools-panel";
export { FlipCelToolSettingsPanel } from "./panels/tool-settings-panel";
export { FlipCelTopBarPanel } from "./panels/top-bar";
export { FlipCelViewPanel } from "./panels/view-panel";
export { FlipCelUniversalPanel } from "./panels/settings-panel";
export { FlipCelHistoryPanel } from "./panels/history-panel";
export { FlipCelKeyboardShortcutsPanel } from "./panels/keyboard-shortcuts-panel";
export { FlipCelTutorialsPanel } from "./panels/tutorials-panel";
export { FlipCelHelpPopup } from "./panels/help-popup";
export { FlipCelStartupPanel } from "./panels/startup-panel";
export { FlipCelLayersPanel } from "./panels/layers-panel";
export { FlipCelWheelPanel } from "./panels/jog-wheel";
export { FlipCelFunctionsPanel } from "./panels/contextual-actions-panel";
export { FlipCelMagicMovePopup } from "./panels/magic-move-popup";
export { FlipCelMagicMorphPopup } from "./panels/magic-morph-popup";
export { FlipCelAutoMorphPopup } from "./panels/auto-morph-popup";

declare global {
  interface HTMLElementTagNameMap {
    "blocky-button": import("./primitives/block-button").BlockyButton;
    "generic-color-picker": import("./color-picker/generic-picker").GenericColorPicker;
    "flipcel-scroll-strip": import("./primitives/scroll-strip").FlipCelScrollStrip;
    "flipcel-panel-section": import("./primitives/panel-section").FlipCelPanelSection;
    "flipcel-color-panel": import("./color-picker/features").FlipCelColorPanel;
    "flipcel-color-popup": import("./color-picker/features").FlipCelColorPopup;
    "flipcel-top-bar-panel": import("./panels/top-bar").FlipCelTopBarPanel;
    "flipcel-tools-panel": import("./panels/tools-panel").FlipCelToolsPanel;
    "flipcel-tool-settings-panel": import("./panels/tool-settings-panel").FlipCelToolSettingsPanel;
    "flipcel-universal-panel": import("./panels/settings-panel").FlipCelUniversalPanel;
    "flipcel-history-panel": import("./panels/history-panel").FlipCelHistoryPanel;
    "flipcel-keyboard-shortcuts-panel": import("./panels/keyboard-shortcuts-panel").FlipCelKeyboardShortcutsPanel;
    "flipcel-tutorials-panel": import("./panels/tutorials-panel").FlipCelTutorialsPanel;
    "flipcel-help-popup": import("./panels/help-popup").FlipCelHelpPopup;
    "flipcel-startup-panel": import("./panels/startup-panel").FlipCelStartupPanel;
    "flipcel-view-panel": import("./panels/view-panel").FlipCelViewPanel;
    "flipcel-layers-panel": import("./panels/layers-panel").FlipCelLayersPanel;
    "flipcel-wheel-panel": import("./panels/jog-wheel").FlipCelWheelPanel;
    "flipcel-functions-panel": import("./panels/contextual-actions-panel").FlipCelFunctionsPanel;
    "flipcel-magic-move-popup": import("./panels/magic-move-popup").FlipCelMagicMovePopup;
    "flipcel-magic-morph-popup": import("./panels/magic-morph-popup").FlipCelMagicMorphPopup;
    "flipcel-auto-morph-popup": import("./panels/auto-morph-popup").FlipCelAutoMorphPopup;
  }
}
