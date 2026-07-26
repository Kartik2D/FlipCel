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
import "./panels/top-bar";
import "./panels/shortcuts";
import "./panels/view-panel";
import "./panels/settings-panel";
import "./panels/startup-panel";
import "./panels/layers-panel";
import "./panels/jog-wheel";
import "./panels/contextual-actions-panel";

export { Block } from "./primitives/block";
export { BlockyButton } from "./primitives/block-button";
export { InkwellScrollbar } from "./primitives/scrollbar";
export { InkwellScrollStrip } from "./primitives/scroll-strip";
export { InkwellPanelSection } from "./primitives/panel-section";
export { FloatingPanel } from "./primitives/floating-panel";
export { PopupWindow } from "./primitives/popup-window";
export { GenericColorPicker } from "./color-picker/generic-picker";
export { InkwellColorPanel, InkwellColorPopup } from "./color-picker/features";
export { InkwellToolsPanel } from "./panels/tools-panel";
export { InkwellTopBarPanel } from "./panels/top-bar";
export { InkwellShortcutsPanel } from "./panels/shortcuts";
export { InkwellViewPanel } from "./panels/view-panel";
export { InkwellUniversalPanel } from "./panels/settings-panel";
export { InkwellStartupPanel } from "./panels/startup-panel";
export { InkwellLayersPanel } from "./panels/layers-panel";
export { InkwellWheelPanel } from "./panels/jog-wheel";
export { InkwellFunctionsPanel } from "./panels/contextual-actions-panel";

declare global {
  interface HTMLElementTagNameMap {
    "blocky-button": import("./primitives/block-button").BlockyButton;
    "generic-color-picker": import("./color-picker/generic-picker").GenericColorPicker;
    "inkwell-scroll-strip": import("./primitives/scroll-strip").InkwellScrollStrip;
    "inkwell-panel-section": import("./primitives/panel-section").InkwellPanelSection;
    "inkwell-color-panel": import("./color-picker/features").InkwellColorPanel;
    "inkwell-color-popup": import("./color-picker/features").InkwellColorPopup;
    "inkwell-top-bar-panel": import("./panels/top-bar").InkwellTopBarPanel;
    "inkwell-shortcuts-panel": import("./panels/shortcuts").InkwellShortcutsPanel;
    "inkwell-tools-panel": import("./panels/tools-panel").InkwellToolsPanel;
    "inkwell-universal-panel": import("./panels/settings-panel").InkwellUniversalPanel;
    "inkwell-startup-panel": import("./panels/startup-panel").InkwellStartupPanel;
    "inkwell-view-panel": import("./panels/view-panel").InkwellViewPanel;
    "inkwell-layers-panel": import("./panels/layers-panel").InkwellLayersPanel;
    "inkwell-wheel-panel": import("./panels/jog-wheel").InkwellWheelPanel;
    "inkwell-functions-panel": import("./panels/contextual-actions-panel").InkwellFunctionsPanel;
  }
}
