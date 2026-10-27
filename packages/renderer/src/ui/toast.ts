// A short line at the bottom of the screen for the outcome of an office action.

export function mountToast(): (text: string, ms?: number) => void {
  const el = document.createElement("div");
  el.className = "office-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.hidden = true;
  document.body.appendChild(el);
  let timer = 0;
  return (text, ms = 3500) => {
    el.textContent = text;
    el.hidden = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      el.hidden = true;
    }, ms);
  };
}
