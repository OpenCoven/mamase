// Loaded before the stylesheet so a saved theme is applied before the first paint.
(() => {
  const key = "mamase.appearance.v1";
  const choices = ["system", "light", "dark"];
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;
  let preference = "system";
  let error = "";

  function readPreference() {
    let stored;
    try {
      stored = window.localStorage.getItem(key);
    } catch (cause) {
      if (!(cause instanceof DOMException)) throw cause;
      error = "Appearance preferences could not be read. Using your system theme.";
      return "system";
    }
    if (stored !== null && !choices.includes(stored)) {
      error = "The saved appearance preference is invalid. Using your system theme.";
      return "system";
    }
    error = "";
    return stored ?? "system";
  }

  function apply() {
    root.dataset.theme = preference === "system" ? (media.matches ? "dark" : "light") : preference;
    root.dataset.themePreference = preference;
    document.dispatchEvent(new Event("mamase:themechange"));
  }

  window.mamaseTheme = Object.freeze({
    get preference() { return preference; },
    get error() { return error; },
    setPreference(value) {
      if (!choices.includes(value)) throw new Error("Choose System, Light, or Dark.");
      try {
        window.localStorage.setItem(key, value);
      } catch (cause) {
        if (!(cause instanceof DOMException)) throw cause;
        throw new Error("Appearance could not be saved. Check your browser's storage permissions or available space.");
      }
      preference = value;
      error = "";
      apply();
    },
  });

  media.addEventListener("change", () => {
    if (preference === "system") apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    if (event.storageArea !== window.localStorage) return;
    preference = readPreference();
    apply();
  });
  preference = readPreference();
  apply();
})();
