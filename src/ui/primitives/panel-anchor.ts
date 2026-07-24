export function anchorPanelBelowTrigger(panelEl: HTMLElement, triggerEl: HTMLElement) {
  const triggerRect = triggerEl.getBoundingClientRect();
  const gap = 10;
  const panelRect = panelEl.getBoundingClientRect();
  const idealLeft = triggerRect.left + triggerRect.width / 2 - panelRect.width / 2;
  const maxLeft = window.innerWidth - panelRect.width - 8;
  const clampedLeft = Math.max(8, Math.min(idealLeft, maxLeft));
  let top = triggerRect.bottom + gap;

  if (top + panelRect.height > window.innerHeight - 8) {
    top = Math.max(8, triggerRect.top - panelRect.height - gap);
  }

  panelEl.style.left = `${Math.round(clampedLeft)}px`;
  panelEl.style.top = `${Math.round(top)}px`;
  panelEl.style.right = "auto";
  panelEl.style.bottom = "auto";
}

export function raisePanelZIndex(panelEl: HTMLElement) {
  const allPanels = document.querySelectorAll<HTMLElement>("[data-panel]");
  let maxZIndex = 1000;
  allPanels.forEach((panel) => {
    const zIndex = parseInt(window.getComputedStyle(panel).zIndex || "1000", 10);
    if (zIndex > maxZIndex) maxZIndex = zIndex;
  });
  panelEl.style.zIndex = `${maxZIndex + 1}`;
}
